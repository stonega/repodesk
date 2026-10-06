import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Fault, requireThat } from "../../domain.ts";
import { decrypt, encrypt, hash } from "../../setup/credentials.ts";
import type { DeviceAuthStatus } from "./protocol.ts";
import type { RunnerSettings } from "./settings.ts";

interface PendingLogin {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  completion?: Promise<void>;
  cancelled?: boolean;
  verificationUrl?: string;
  userCode?: string;
  failed: boolean;
  output: string;
}

// Only the supervisor sees the reusable ChatGPT credential. A task gets an
// isolated copy in a short-lived Podman volume during its Codex phase.
export class DeviceAuth {
  private pending = new Map<string, PendingLogin>();
  private failed = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  constructor(
    private settings: RunnerSettings,
    private binary = "codex",
  ) {}
  private home(workspaceId: string) {
    return join(
      this.settings.CODEX_RUNNER_STATE,
      "device-auth",
      z.uuid().parse(workspaceId),
    );
  }
  private sealed(workspaceId: string) {
    return join(this.home(workspaceId), "credential.json");
  }
  private aad(workspaceId: string) {
    return `coding-device-auth:${workspaceId}`;
  }
  private async connected(workspaceId: string) {
    try {
      await this.read(workspaceId);
      return true;
    } catch {
      return false;
    }
  }
  async status(workspaceId: string): Promise<DeviceAuthStatus> {
    const login = this.pending.get(workspaceId);
    if (login && !login.failed)
      return {
        state: "pending",
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
      };
    try {
      const cache = await this.cache(workspaceId);
      if (cache.state === "auth_required") return { state: "auth_required" };
      if (!cache.credential) throw Error();
      this.validate(cache.credential);
      return { state: "connected" };
    } catch {}
    return { state: this.failed.has(workspaceId) ? "failed" : "disconnected" };
  }
  async initialize() {
    const root = join(this.settings.CODEX_RUNNER_STATE, "device-auth");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const workspaceId of await readdir(root)) {
      if (!z.uuid().safeParse(workspaceId).success) continue;
      const leftover = join(this.home(workspaceId), "auth.json");
      try {
        if (!(await this.connected(workspaceId)))
          await this.save(workspaceId, await readFile(leftover, "utf8"));
      } catch {
        // An interrupted login may leave an incomplete cache.
      } finally {
        await rm(leftover, { force: true });
      }
    }
  }
  private async cache(workspaceId: string): Promise<{
    generation: string;
    state: "connected" | "auth_required";
    credential?: string;
  }> {
    const sealed = await readFile(this.sealed(workspaceId), "utf8");
    const plain = decrypt(
      hash(this.settings.CODEX_RUNNER_TOKEN),
      this.aad(workspaceId),
      sealed,
    );
    const value = JSON.parse(plain);
    if (value.format === "repodesk-device-auth-v1") {
      return z
        .object({
          generation: z.string().min(1),
          state: z.enum(["connected", "auth_required"]),
          credential: z.string().optional(),
        })
        .parse(value);
    }
    // Existing sealed caches acquire a stable generation without another login.
    return { generation: hash(sealed), state: "connected", credential: plain };
  }
  async snapshot(workspaceId: string) {
    try {
      const cache = await this.cache(workspaceId);
      if (cache.state !== "connected" || !cache.credential) throw Error();
      this.validate(cache.credential);
      return { generation: cache.generation, credential: cache.credential };
    } catch {
      throw new Fault("coding_device_auth_required", 409);
    }
  }
  async read(workspaceId: string) {
    return (await this.snapshot(workspaceId)).credential;
  }
  private validate(credential: string) {
    requireThat(
      credential.length > 0 && credential.length <= 128 * 1024,
      "coding_device_auth_invalid",
    );
    z.object({ tokens: z.object({ access_token: z.string().min(1) }) }).parse(
      JSON.parse(credential),
    );
  }
  private async write(
    workspaceId: string,
    value: {
      generation: string;
      state: "connected" | "auth_required";
      credential?: string;
    },
  ) {
    const home = this.home(workspaceId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const temp = join(home, "credential.tmp");
    await writeFile(
      temp,
      encrypt(
        hash(this.settings.CODEX_RUNNER_TOKEN),
        this.aad(workspaceId),
        JSON.stringify({ format: "repodesk-device-auth-v1", ...value }),
      ),
      { mode: 0o600 },
    );
    await rename(temp, this.sealed(workspaceId));
  }
  async save(workspaceId: string, credential: string) {
    this.validate(credential);
    return this.serial(async () => {
      const generation = randomUUID();
      await this.write(workspaceId, {
        generation,
        state: "connected",
        credential,
      });
      return generation;
    });
  }
  async capture(workspaceId: string, generation: string, credential: string) {
    this.validate(credential);
    return this.serial(async () => {
      const current = await this.cache(workspaceId).catch(() => undefined);
      if (current?.generation !== generation || current.state !== "connected")
        return false;
      await this.write(workspaceId, {
        generation,
        state: "connected",
        credential,
      });
      return true;
    });
  }
  async invalidate(workspaceId: string, generation: string) {
    return this.serial(async () => {
      const current = await this.cache(workspaceId).catch(() => undefined);
      if (current?.generation !== generation) return;
      await this.write(workspaceId, { generation, state: "auth_required" });
    });
  }
  async start(workspaceId: string): Promise<DeviceAuthStatus> {
    z.uuid().parse(workspaceId);
    if (await this.connected(workspaceId)) return { state: "connected" };
    if (this.pending.has(workspaceId)) return this.status(workspaceId);
    requireThat(this.pending.size < 4, "coding_device_login_busy", 429);
    const home = this.home(workspaceId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    this.failed.delete(workspaceId);
    const child = spawn(this.binary, ["login", "--device-auth"], {
      env: { PATH: process.env.PATH, HOME: "/tmp", CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", resolve);
      child.once("error", resolve);
    });
    const timer = setTimeout(() => this.killLogin(child), 16 * 60 * 1000);
    timer.unref();
    const login: PendingLogin = {
      child,
      closed,
      timer,
      failed: false,
      output: "",
    };
    this.pending.set(workspaceId, login);
    const collect = (chunk: Buffer) => {
      login.output = (login.output + chunk.toString())
        .slice(-4096)
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
      const url = login.output.match(/https:\/\/[^\s]+/);
      const code = login.output.match(
        /Enter this one-time code[\s\S]*?\n\s*([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)/,
      );
      if (url) {
        const parsed = new URL(url[0]);
        if (
          parsed.protocol === "https:" &&
          parsed.hostname === "auth.openai.com"
        )
          login.verificationUrl = parsed.href;
      }
      if (code) login.userCode = code[1];
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      clearTimeout(timer);
      if (this.pending.get(workspaceId) !== login) return;
      login.failed = true;
      this.failed.add(workspaceId);
      this.pending.delete(workspaceId);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (this.pending.get(workspaceId) !== login) return;
      login.completion = (async () => {
        try {
          if (code !== 0 || login.cancelled)
            throw new Error("device login failed");
          await this.save(
            workspaceId,
            await readFile(join(home, "auth.json"), "utf8"),
          );
          this.failed.delete(workspaceId);
        } catch {
          this.failed.add(workspaceId);
        } finally {
          await rm(join(home, "auth.json"), { force: true });
          if (this.pending.get(workspaceId) === login)
            this.pending.delete(workspaceId);
        }
      })();
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && this.pending.has(workspaceId)) {
      if (login.verificationUrl && login.userCode)
        return this.status(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (login.verificationUrl && login.userCode)
      return this.status(workspaceId);
    const failure = /device code login is not enabled/i.test(login.output)
      ? "coding_device_login_disabled"
      : /device code request failed with status (?:401|403)\b/i.test(
            login.output,
          )
        ? "coding_device_login_rejected"
        : /error sending request|certificate|dns error|connect error/i.test(
              login.output,
            )
          ? "coding_device_login_network_failed"
          : "coding_device_login_unavailable";
    await this.cancelLogin(workspaceId);
    await rm(join(home, "auth.json"), { force: true });
    this.failed.add(workspaceId);
    throw new Fault(failure, 503);
  }
  private killLogin(child: ChildProcessWithoutNullStreams) {
    // npm launches a native child; killing only the JS launcher leaves its pipes open.
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // A child that already exited has no process group to signal.
      }
    }
    child.kill("SIGKILL");
  }
  private async cancelLogin(workspaceId: string) {
    const login = this.pending.get(workspaceId);
    if (login) {
      login.cancelled = true;
      clearTimeout(login.timer);
      this.killLogin(login.child);
      await login.closed;
      await login.completion;
      this.pending.delete(workspaceId);
    }
  }
  async logout(workspaceId: string): Promise<DeviceAuthStatus> {
    z.uuid().parse(workspaceId);
    await this.cancelLogin(workspaceId);
    await this.serial(() =>
      rm(this.home(workspaceId), { recursive: true, force: true }),
    );
    this.failed.delete(workspaceId);
    return { state: "disconnected" };
  }
}
