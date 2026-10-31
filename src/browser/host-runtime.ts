import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { decrypt, encrypt, fingerprint, hash } from "../setup/credentials.ts";
import { BrowserEgress } from "./egress.ts";
import {
  type BrowserCheckpoint,
  browserCheckpoint,
} from "./host-checkpoint.ts";
import type { BrowserHostSettings } from "./host-settings.ts";
import {
  BrowserFirewall,
  type HostIdentity,
  hostIdentity,
  stopHostIdentity,
} from "./host-system.ts";
import {
  type BrowserHostPolicy,
  deniedBrowserPolicy,
  type HostRequest,
  type HostResult,
  hostResult,
} from "./protocol.ts";
import { profileKey, sameController } from "./state.ts";

const persisted = z
  .object({
    owner: z
      .object({
        workspaceId: z.uuid(),
        actor: z.string().regex(/^[1-9]\d{0,15}$/),
      })
      .strict(),
    generation: z.number().int().nonnegative().safe(),
    controller: z
      .object({
        kind: z.enum(["chat", "codex", "plugin", "human"]),
        id: z.uuid(),
        fence: z.number().int().nonnegative(),
        pluginId: z.string().optional(),
      })
      .strict()
      .optional(),
    requests: z.array(
      z
        .object({
          id: z.uuid(),
          hash: z.string(),
          expiresAt: z.number(),
          state: z.enum(["started", "completed"]),
          status: z
            .enum(["ready", "closed", "deleted", "completed", "unavailable"])
            .optional(),
          reference: z.uuid().optional(),
        })
        .strict(),
    ),
  })
  .strict();
type Journal = z.infer<typeof persisted>;

async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  // The nonce journal must survive a power loss after the rename as well.
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

class BrowserWorker {
  private child: ChildProcess;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(identity: HostIdentity, worker: string) {
    this.child = spawn("dbus-run-session", ["--", process.execPath, worker], {
      uid: identity.uid,
      gid: identity.gid,
      cwd: identity.home,
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: identity.home,
        LANG: "C.UTF-8",
        USER: identity.name,
        LOGNAME: identity.name,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const fail = () => {
      for (const value of this.pending.values()) {
        clearTimeout(value.timer);
        value.reject(new Fault("browser_service_unavailable", 503));
      }
      this.pending.clear();
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    this.child.on("message", (message: unknown) => {
      const parsed = z
        .object({
          id: z.uuid(),
          result: z.unknown().optional(),
          error: z
            .string()
            .regex(/^browser_[a-z_]+$/)
            .optional(),
        })
        .strict()
        .safeParse(message);
      if (!parsed.success) {
        fail();
        return;
      }
      const waiting = this.pending.get(parsed.data.id);
      if (!waiting) return;
      this.pending.delete(parsed.data.id);
      clearTimeout(waiting.timer);
      if (parsed.data.error) waiting.reject(new Fault(parsed.data.error, 409));
      else if (parsed.data.result !== undefined)
        waiting.resolve(parsed.data.result);
      else waiting.reject(new Fault("browser_service_unavailable", 503));
    });
  }
  private request(input: unknown): Promise<unknown> {
    requireThat(this.child.connected, "browser_service_unavailable", 503);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Fault("browser_operation_timeout", 504));
      }, 25_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, input }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Fault("browser_service_unavailable", 503));
        }
      });
    });
  }
  async call(input: unknown): Promise<HostResult> {
    return hostResult.parse(await this.request(input));
  }
  async snapshot(): Promise<BrowserCheckpoint> {
    return browserCheckpoint.parse(
      await this.request({ command: "checkpoint" }),
    );
  }
  async close() {
    try {
      await this.call({ command: "shutdown" });
    } catch {
      /* Forced UID cleanup below is authoritative. */
    }
    if (this.child.connected) this.child.disconnect();
  }
}
interface LiveBrowser {
  identity: HostIdentity;
  worker: BrowserWorker;
  egress: BrowserEgress;
  policyHash: string;
  usedAt: number;
  waitingUntil: number;
}

/** Root supervisor; repository code and browsers never receive its socket/key. */
export class NativeBrowserHost {
  private live = new Map<string, LiveBrowser>();
  private starting = 0;
  private closing = false;
  private queues = new Map<string, Promise<unknown>>();
  private firewall = new BrowserFirewall();
  private sweep?: ReturnType<typeof setInterval>;
  private lockId = randomUUID();
  constructor(
    readonly settings: BrowserHostSettings,
    private workerFile = fileURLToPath(
      new URL("./browser-host-worker.js", import.meta.url),
    ),
    private key?: string,
  ) {}
  private async checkpoint(
    identity: HostIdentity,
    value?: BrowserCheckpoint,
  ): Promise<BrowserCheckpoint | undefined> {
    requireThat(
      this.key && this.key.length >= 32,
      "browser_credentials_unavailable",
      503,
    );
    const name = `browser-session:${identity.directory.split("/").at(-1)}`;
    const encryptionKey = hash(`repodesk:browser-session:v1:${this.key}`);
    const path = join(identity.directory, "session.json");
    if (value) {
      const raw = JSON.stringify(browserCheckpoint.parse(value));
      requireThat(
        Buffer.byteLength(raw) <= 4 * 1024 * 1024,
        "browser_capacity",
        503,
      );
      await save(path, { sealed: encrypt(encryptionKey, name, raw) });
      return value;
    }
    try {
      const sealed = z
        .object({ sealed: z.string().max(6 * 1024 * 1024) })
        .strict()
        .parse(JSON.parse(await readFile(path, "utf8")));
      return browserCheckpoint.parse(
        JSON.parse(decrypt(encryptionKey, name, sealed.sealed)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Fault("browser_profile_invalid", 503);
    }
  }
  async initialize() {
    requireThat(
      this.key && this.key.length >= 32,
      "browser_credentials_unavailable",
      503,
    );
    requireThat(
      process.platform === "linux" && process.getuid?.() === 0,
      "browser_host_privileges_required",
      503,
    );
    await access(this.settings.BROWSER_EXECUTABLE);
    await access(this.workerFile);
    await mkdir(this.settings.BROWSER_HOST_ROOT, {
      mode: 0o711,
      recursive: true,
    });
    const root = await lstat(this.settings.BROWSER_HOST_ROOT);
    requireThat(
      root.isDirectory() && !root.isSymbolicLink() && root.uid === 0,
      "browser_profile_invalid",
      503,
    );
    const lockPath = join(this.settings.BROWSER_HOST_ROOT, "host.lock");
    try {
      const file = await open(lockPath, "wx", 0o600);
      await file.writeFile(
        JSON.stringify({ pid: process.pid, id: this.lockId }),
      );
      await file.close();
    } catch {
      const lock = z
        .object({ pid: z.number().int().positive(), id: z.uuid() })
        .parse(JSON.parse(await readFile(lockPath, "utf8")));
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      requireThat(!alive, "browser_host_already_running", 503);
      await unlink(lockPath);
      const file = await open(lockPath, "wx", 0o600);
      await file.writeFile(
        JSON.stringify({ pid: process.pid, id: this.lockId }),
      );
      await file.close();
    }
    await mkdir(join(this.settings.BROWSER_HOST_ROOT, "profiles"), {
      mode: 0o711,
      recursive: true,
    });
    // Revoke surviving UID processes before accepting a request after restart.
    for (const entry of await readdir(
      join(this.settings.BROWSER_HOST_ROOT, "profiles"),
      { withFileTypes: true },
    )) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(
        this.settings.BROWSER_HOST_ROOT,
        "profiles",
        entry.name,
        "control.json",
      );
      let data: Journal;
      try {
        data = persisted.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      requireThat(
        profileKey(data.owner) === entry.name,
        "browser_profile_invalid",
        503,
      );
      const identity = await hostIdentity(
        this.settings.BROWSER_HOST_ROOT,
        data.owner,
      );
      await this.firewall.set(identity.uid);
      await stopHostIdentity(identity);
      await this.cleanDisplay(identity);
    }
    this.sweep = setInterval(() => {
      for (const [key, value] of this.live)
        if (
          Math.max(
            value.usedAt + this.settings.BROWSER_HOST_IDLE_SECONDS * 1000,
            value.waitingUntil,
          ) < Date.now()
        )
          void this.serial(key, () => this.stop(key)).catch(() => {});
    }, 15_000);
    this.sweep.unref();
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(key, next);
    void next
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async cleanDisplay(identity: HostIdentity) {
    for (const path of [
      `/tmp/.X11-unix/X${10000 + identity.uid}`,
      `/tmp/.X${10000 + identity.uid}-lock`,
    ]) {
      try {
        if ((await lstat(path)).uid === identity.uid) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private async stop(key: string) {
    const live = this.live.get(key);
    if (!live) return;
    this.live.delete(key);
    // Revoke the proxy first. Even if nft or a crashed worker is unavailable,
    // every remaining teardown step must still run.
    live.egress.update(deniedBrowserPolicy);
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(() => this.firewall.set(live.identity.uid));
    try {
      await this.checkpoint(live.identity, await live.worker.snapshot());
    } catch {
      /* Retain the last acknowledged checkpoint if the process crashed. */
    }
    await cleanup(() => live.worker.close());
    await cleanup(() => stopHostIdentity(live.identity));
    await cleanup(() => this.cleanDisplay(live.identity));
    await cleanup(() => live.egress.close());
    requireThat(!failures.length, "browser_host_cleanup_failed", 503);
  }
  private async process(identity: HostIdentity, policy: BrowserHostPolicy) {
    const key = identity.directory.split("/").at(-1) ?? "";
    let live = this.live.get(key);
    if (!live) {
      requireThat(
        this.live.size + this.starting <
          this.settings.BROWSER_HOST_MAX_PROCESSES,
        "browser_capacity",
        503,
      );
      this.starting++;
      let egress: BrowserEgress | undefined;
      try {
        await this.firewall.set(identity.uid);
        await stopHostIdentity(identity);
        await this.cleanDisplay(identity);
        egress = new BrowserEgress(policy);
        const proxy = await egress.start();
        await this.firewall.set(identity.uid, proxy.port);
        const worker = new BrowserWorker(identity, this.workerFile);
        live = {
          identity,
          worker,
          egress,
          usedAt: Date.now(),
          waitingUntil: 0,
          policyHash: fingerprint(policy),
        };
        this.live.set(key, live);
        await worker.call({
          command: "initialize",
          home: identity.home,
          executable: this.settings.BROWSER_EXECUTABLE,
          proxy: {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
          },
          checkpoint: await this.checkpoint(identity),
        });
      } catch (error) {
        if (this.live.has(key)) await this.stop(key);
        else {
          await this.firewall.set(identity.uid);
          await egress?.close();
        }
        throw error;
      } finally {
        this.starting--;
      }
    }
    if (live.policyHash !== fingerprint(policy)) {
      live.egress.update(policy);
      live.policyHash = fingerprint(policy);
    } else if (!live.egress.renew()) {
      live.egress.update(policy);
    }
    live.usedAt = Date.now();
    return live;
  }
  async invoke(input: HostRequest): Promise<HostResult> {
    requireThat(!this.closing, "browser_service_unavailable", 503);
    const key = profileKey(input.owner);
    return this.serial(key, async () => {
      requireThat(!this.closing, "browser_service_unavailable", 503);
      requireThat(input.expiresAt > Date.now(), "browser_request_expired", 401);
      const directory = join(this.settings.BROWSER_HOST_ROOT, "profiles", key);
      const path = join(directory, "control.json");
      let journal: Journal;
      try {
        journal = persisted.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Fault("browser_profile_invalid", 503);
        if (["status", "observe"].includes(input.operation.command))
          return { status: "closed", headed: true };
        const identity = await hostIdentity(
          this.settings.BROWSER_HOST_ROOT,
          input.owner,
        );
        await chmod(identity.directory, 0o711);
        journal = { owner: input.owner, generation: 0, requests: [] };
      }
      requireThat(
        profileKey(journal.owner) === key,
        "browser_profile_invalid",
        503,
      );
      const hash = fingerprint(input);
      const prior = journal.requests.find((request) => request.id === input.id);
      if (prior) {
        requireThat(prior.hash === hash, "browser_duplicate_conflict", 409);
        requireThat(
          prior.state === "completed",
          "browser_outcome_unknown",
          409,
        );
        return {
          status: prior.status ?? "completed",
          reference: prior.reference,
        };
      }
      const command = input.operation.command;
      const changedController = input.generation > journal.generation;
      if (["acquire", "release", "close", "delete"].includes(command)) {
        requireThat(
          input.generation >= journal.generation &&
            (input.generation > journal.generation ||
              !journal.controller ||
              sameController(journal.controller, input.controller)),
          "browser_control_expired",
          409,
        );
        journal.generation = input.generation;
        journal.controller =
          command === "acquire" ? input.controller : undefined;
      } else if (command === "observe") {
        requireThat(
          input.generation === journal.generation,
          "browser_control_expired",
          409,
        );
      } else if (command !== "status" && command !== "artifact") {
        requireThat(
          input.generation === journal.generation &&
            journal.controller &&
            sameController(journal.controller, input.controller),
          "browser_control_expired",
          409,
        );
      }
      journal.requests = journal.requests.filter(
        (request) => request.expiresAt > Date.now(),
      );
      journal.requests.push({
        id: input.id,
        hash,
        expiresAt: input.expiresAt,
        state: "started",
      });
      await save(path, journal);
      const policy = input.policy ?? deniedBrowserPolicy;
      let result: HostResult;
      try {
        if (command === "close" || command === "delete") {
          await this.stop(key);
          if (command === "delete")
            await rm(join(directory, "home"), { recursive: true, force: true });
          if (command === "delete")
            await rm(join(directory, "session.json"), { force: true });
          result = {
            status: command === "delete" ? "deleted" : "closed",
            headed: true,
          };
        } else if (command === "release") {
          this.live.get(key)?.egress.update(deniedBrowserPolicy);
          const live = this.live.get(key);
          if (live) {
            live.policyHash = fingerprint(deniedBrowserPolicy);
            live.waitingUntil = 0;
            await live.worker.call({
              command: "execute",
              operation: { command: "release" },
              policy: deniedBrowserPolicy,
            });
          }
          result = { status: "ready", headed: true };
        } else if (command === "status" || command === "observe") {
          const live = this.live.get(key);
          result = live
            ? await live.worker.call({
                command: "execute",
                operation: input.operation,
                policy,
              })
            : { status: "closed", headed: true };
        } else {
          const identity = await hostIdentity(
            this.settings.BROWSER_HOST_ROOT,
            input.owner,
          );
          if (command === "acquire" && changedController && this.live.has(key))
            await this.live.get(key)?.worker.call({
              command: "execute",
              operation: { command: "release" },
              policy: deniedBrowserPolicy,
            });
          const live =
            command === "artifact"
              ? this.live.get(key)
              : await this.process(identity, policy);
          if (!live && command === "artifact") {
            await this.firewall.set(identity.uid);
            const reader = new BrowserWorker(identity, this.workerFile);
            try {
              result = await reader.call({
                command: "artifact",
                home: identity.home,
                id: input.operation.id,
                policy,
              });
            } finally {
              await reader.close();
              await stopHostIdentity(identity);
            }
          } else {
            requireThat(live, "browser_artifact_unavailable", 404);
            result = await live.worker.call({
              command: "execute",
              operation: input.operation,
              policy,
            });
            if (
              command === "action" &&
              input.operation.input.action === "request_input"
            )
              live.waitingUntil = Date.now() + 10 * 60_000;
            if (command === "input") live.waitingUntil = 0;
            if (command !== "artifact")
              await this.checkpoint(identity, await live.worker.snapshot());
          }
        }
      } catch (error) {
        if (
          !(error instanceof Fault) ||
          [
            "browser_operation_timeout",
            "browser_service_unavailable",
            "browser_execution_failed",
          ].includes(error.code)
        )
          await this.stop(key);
        throw error;
      }
      const receipt = journal.requests.find(
        (request) => request.id === input.id,
      );
      requireThat(receipt, "browser_outcome_unknown", 409);
      receipt.state = "completed";
      receipt.status = result.status;
      receipt.reference = result.reference;
      await save(path, journal);
      return result;
    });
  }
  async close() {
    this.closing = true;
    if (this.sweep) clearInterval(this.sweep);
    await Promise.allSettled(
      [...this.live.keys()].map((key) =>
        this.serial(key, () => this.stop(key)),
      ),
    );
    const path = join(this.settings.BROWSER_HOST_ROOT, "host.lock");
    try {
      const lock = JSON.parse(await readFile(path, "utf8"));
      if (lock.id === this.lockId) await unlink(path);
    } catch {
      /* A failed initialization may not own a lock. */
    }
  }
}
