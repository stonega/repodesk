import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { Fault, requireThat } from "../../domain.ts";
import { decrypt, encrypt, hash } from "../../setup/credentials.ts";
import type { AntigravityAuthStatus } from "./protocol.ts";
import type { RunnerSettings } from "./settings.ts";

interface PendingAntigravityLogin {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  timer: ReturnType<typeof setTimeout>;
  loginHome: string;
  cancelled?: boolean;
  submitted?: boolean;
  verificationUrl?: string;
  failed: boolean;
  output: string;
}

const MAX_BUNDLE_BYTES = 512 * 1024;
const MAX_SINGLE_FILE_BYTES = 128 * 1024;

const authBundleSchema = z
  .object({
    format: z.enum([
      "telo-antigravity-files-v1",
      "repodesk-antigravity-files-v1",
    ]),
    files: z.record(z.string().min(1).max(240), z.string().max(256 * 1024)),
  })
  .strict();

export type AntigravityAuthBundle = z.infer<typeof authBundleSchema>;

const SAFE_RELATIVE_ROOTS = [".gemini", ".config", ".local/share"] as const;
const IGNORED_SEGMENTS = new Set([
  "log",
  "logs",
  "builtin",
  "conversations",
  "brain",
  "crashes",
  "updater",
  "implicit",
  "presence",
  "annotations",
  "persistent_terminals",
  "bin",
  "mcp",
]);
const IGNORED_BASENAMES = new Set([
  "conversation_summaries.db",
  "conversation_summaries.db-shm",
  "conversation_summaries.db-wal",
  "history.jsonl",
  "cli.log",
  "last_check.timestamp",
  "installation_id",
  "settings.json",
  "mcp_config.json",
  ".migrated",
]);

function isSafeRelativeAuthPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0"))
    return false;
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return false;
  return SAFE_RELATIVE_ROOTS.some(
    (root) => rel === root || rel.startsWith(`${root}/`),
  );
}

/**
 * Collects file-based Antigravity OAuth/token state from an isolated HOME directory
 * while excluding logs, SQLite caches, and bundled skills.
 */
export async function packAntigravityAuthBundle(
  homeDir: string,
): Promise<string | undefined> {
  const files: Record<string, string> = {};
  let totalBytes = 0;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (IGNORED_SEGMENTS.has(name) || IGNORED_BASENAMES.has(name)) continue;
      const full = join(current, name);
      const stat = await lstat(full).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full, depth + 1);
      } else if (stat.isFile()) {
        if (stat.size === 0 || stat.size > MAX_SINGLE_FILE_BYTES) continue;
        const rel = relative(homeDir, full).split(sep).join("/");
        if (!isSafeRelativeAuthPath(rel)) continue;
        // Skip SQLite databases or lock files.
        if (/\.(?:db|db-shm|db-wal|lock|log|tmp)$/i.test(name)) continue;
        const content = await readFile(full);
        if (totalBytes + content.length > MAX_BUNDLE_BYTES) continue;
        totalBytes += content.length;
        files[rel] = content.toString("base64");
      }
    }
  }

  for (const root of SAFE_RELATIVE_ROOTS) {
    await walk(join(homeDir, root), 0);
  }
  if (Object.keys(files).length === 0) return undefined;
  return JSON.stringify({
    format: "telo-antigravity-files-v1",
    files,
  } satisfies AntigravityAuthBundle);
}

/**
 * Restores a validated Antigravity auth bundle into a task HOME directory.
 */
export async function unpackAntigravityAuthBundle(
  bundleJson: string,
  homeDir: string,
): Promise<void> {
  requireThat(
    bundleJson.length > 0 && bundleJson.length <= MAX_BUNDLE_BYTES * 2,
    "coding_device_auth_invalid",
  );
  const parsed = authBundleSchema.parse(JSON.parse(bundleJson));
  const entries = Object.entries(parsed.files);
  requireThat(entries.length > 0, "coding_device_auth_invalid");
  for (const [rel, b64] of entries) {
    requireThat(isSafeRelativeAuthPath(rel), "coding_device_auth_invalid");
    const target = join(homeDir, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(b64, "base64"), { mode: 0o600 });
  }
}

export function validateAntigravityAuthBundle(bundleJson: string): void {
  requireThat(
    bundleJson.length > 0 && bundleJson.length <= MAX_BUNDLE_BYTES * 2,
    "coding_device_auth_invalid",
  );
  const parsed = authBundleSchema.parse(JSON.parse(bundleJson));
  const entries = Object.entries(parsed.files);
  requireThat(entries.length > 0, "coding_device_auth_invalid");
  for (const [rel] of entries) {
    requireThat(isSafeRelativeAuthPath(rel), "coding_device_auth_invalid");
  }
}

/**
 * Manages per-workspace Antigravity CLI OAuth credentials on the runner supervisor.
 * Uses `agy acp --login` with SSH_CONNECTION set so Antigravity uses file-based
 * token storage instead of an OS desktop keyring.
 */
export class AntigravityAuth {
  private pending = new Map<string, PendingAntigravityLogin>();
  private failed = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  constructor(
    private settings: RunnerSettings,
    private binary?: string,
  ) {}

  private home(workspaceId: string) {
    return join(
      this.settings.CODEX_RUNNER_STATE,
      "antigravity-auth",
      z.uuid().parse(workspaceId),
    );
  }

  private sealed(workspaceId: string) {
    return join(this.home(workspaceId), "credential.json");
  }

  private aad(workspaceId: string) {
    return `antigravity-auth:${workspaceId}`;
  }

  private async connected(workspaceId: string) {
    try {
      await this.read(workspaceId);
      return true;
    } catch {
      return false;
    }
  }

  async initialize() {
    const root = join(this.settings.CODEX_RUNNER_STATE, "antigravity-auth");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const workspaceId of await readdir(root)) {
      if (!z.uuid().safeParse(workspaceId).success) continue;
      // Clean up any leftover temp login homes from interrupted runs.
      await rm(join(this.home(workspaceId), "login-home"), {
        recursive: true,
        force: true,
      });
    }
  }

  async status(workspaceId: string): Promise<AntigravityAuthStatus> {
    const login = this.pending.get(workspaceId);
    if (login && !login.failed) {
      return {
        state: "pending",
        verificationUrl: login.verificationUrl,
      };
    }
    try {
      const cache = await this.cache(workspaceId);
      if (cache.state === "auth_required") return { state: "auth_required" };
      if (!cache.credential) throw Error();
      validateAntigravityAuthBundle(cache.credential);
      return { state: "connected" };
    } catch {}
    return { state: this.failed.has(workspaceId) ? "failed" : "disconnected" };
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
    return z
      .object({
        format: z.enum([
          "telo-antigravity-auth-v1",
          "repodesk-antigravity-auth-v1",
        ]),
        generation: z.string().min(1),
        state: z.enum(["connected", "auth_required"]),
        credential: z.string().optional(),
      })
      .parse(value);
  }

  async snapshot(workspaceId: string) {
    try {
      const cache = await this.cache(workspaceId);
      if (cache.state !== "connected" || !cache.credential) throw Error();
      validateAntigravityAuthBundle(cache.credential);
      return { generation: cache.generation, credential: cache.credential };
    } catch {
      throw new Fault("coding_device_auth_required", 409);
    }
  }

  async read(workspaceId: string) {
    return (await this.snapshot(workspaceId)).credential;
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
        JSON.stringify({ format: "telo-antigravity-auth-v1", ...value }),
      ),
      { mode: 0o600 },
    );
    await rename(temp, this.sealed(workspaceId));
  }

  async save(workspaceId: string, credential: string) {
    validateAntigravityAuthBundle(credential);
    return this.serial(async () => {
      const generation = randomUUID();
      await this.write(workspaceId, {
        generation,
        state: "connected",
        credential,
      });
      this.failed.delete(workspaceId);
      return generation;
    });
  }

  async capture(workspaceId: string, generation: string, credential: string) {
    validateAntigravityAuthBundle(credential);
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

  async start(workspaceId: string): Promise<AntigravityAuthStatus> {
    z.uuid().parse(workspaceId);
    if (await this.connected(workspaceId)) return { state: "connected" };
    if (this.pending.has(workspaceId)) return this.status(workspaceId);
    requireThat(this.pending.size < 4, "coding_antigravity_login_busy", 429);

    const home = this.home(workspaceId);
    const loginHome = join(home, "login-home");
    await rm(loginHome, { recursive: true, force: true });
    await mkdir(loginHome, { recursive: true, mode: 0o700 });
    this.failed.delete(workspaceId);

    const binary =
      this.binary ??
      (this.settings.CODEX_CONTAINER_ENGINE === "native"
        ? this.settings.CODEX_NATIVE_AGY_BIN
        : "agy");

    const child = spawn(binary, ["acp", "--login"], {
      env: {
        PATH: process.env.PATH,
        HOME: loginHome,
        SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
        XDG_CONFIG_HOME: join(loginHome, ".config"),
        XDG_DATA_HOME: join(loginHome, ".local", "share"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const closed = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    const timer = setTimeout(
      () => {
        void this.cancelLogin(workspaceId);
      },
      15 * 60 * 1000,
    );
    timer.unref();

    const login: PendingAntigravityLogin = {
      child,
      closed,
      timer,
      loginHome,
      failed: false,
      output: "",
    };
    this.pending.set(workspaceId, login);

    const collect = (chunk: Buffer) => {
      login.output = (login.output + chunk.toString())
        .slice(-8192)
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
      const match = login.output.match(
        /https:\/\/accounts\.google\.com\/[^\s]+/,
      );
      if (match) {
        try {
          const parsed = new URL(match[0]);
          if (
            parsed.protocol === "https:" &&
            parsed.hostname === "accounts.google.com"
          ) {
            login.verificationUrl = parsed.href;
          }
        } catch {}
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      clearTimeout(timer);
      if (this.pending.get(workspaceId) !== login) return;
      login.failed = true;
      this.failed.add(workspaceId);
      this.pending.delete(workspaceId);
      void rm(loginHome, { recursive: true, force: true });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (this.pending.get(workspaceId) !== login) return;
      if (!login.submitted && !login.cancelled) {
        login.failed = true;
        this.failed.add(workspaceId);
        this.pending.delete(workspaceId);
        void rm(loginHome, { recursive: true, force: true });
      }
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && this.pending.has(workspaceId)) {
      if (login.verificationUrl) return this.status(workspaceId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (login.verificationUrl) return this.status(workspaceId);

    const failure =
      /error sending request|certificate|dns error|connect error|dial tcp|no such host/i.test(
        login.output,
      )
        ? "coding_antigravity_login_network_failed"
        : "coding_antigravity_login_unavailable";
    await this.cancelLogin(workspaceId);
    this.failed.add(workspaceId);
    throw new Fault(failure, 503);
  }

  async complete(
    workspaceId: string,
    codeOrUrl: string,
  ): Promise<AntigravityAuthStatus> {
    z.uuid().parse(workspaceId);
    const cleaned = z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n]/.test(v), "Single-line authorization code")
      .parse(codeOrUrl);
    const login = this.pending.get(workspaceId);
    requireThat(
      login && !login.failed && !login.submitted,
      "coding_antigravity_login_not_pending",
      409,
    );

    login.submitted = true;
    try {
      login.child.stdin.write(`${cleaned}\n`);
      login.child.stdin.end();
    } catch {
      await this.cancelLogin(workspaceId);
      this.failed.add(workspaceId);
      throw new Fault("coding_antigravity_login_failed", 503);
    }

    const exitCode = await Promise.race([
      login.closed,
      new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), 30000);
        t.unref();
      }),
    ]);

    clearTimeout(login.timer);
    if (exitCode === "timeout") {
      this.killLogin(login.child);
      await login.closed;
      this.pending.delete(workspaceId);
      await rm(login.loginHome, { recursive: true, force: true });
      this.failed.add(workspaceId);
      throw new Fault("coding_antigravity_login_failed", 503);
    }

    const bundle =
      exitCode === 0
        ? await packAntigravityAuthBundle(login.loginHome)
        : undefined;
    this.pending.delete(workspaceId);
    await rm(login.loginHome, { recursive: true, force: true });

    if (exitCode !== 0 || !bundle) {
      this.failed.add(workspaceId);
      const rejected =
        /invalid_grant|invalid code|authorization code|mismatch|rejected|401|403|400/i.test(
          login.output,
        );
      throw new Fault(
        rejected
          ? "coding_antigravity_login_rejected"
          : "coding_antigravity_login_failed",
        rejected ? 400 : 503,
      );
    }

    await this.save(workspaceId, bundle);
    return { state: "connected" };
  }

  private killLogin(child: ChildProcessWithoutNullStreams) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
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
      this.pending.delete(workspaceId);
      await rm(login.loginHome, { recursive: true, force: true });
    }
  }

  async logout(workspaceId: string): Promise<AntigravityAuthStatus> {
    z.uuid().parse(workspaceId);
    await this.cancelLogin(workspaceId);
    await this.serial(() =>
      rm(this.home(workspaceId), { recursive: true, force: true }),
    );
    this.failed.delete(workspaceId);
    return { state: "disconnected" };
  }
}
