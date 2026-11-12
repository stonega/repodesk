import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { requireThat } from "../../domain.ts";
import {
  nativeIdentity,
  readNativeProcess,
  saveNativeProcess,
  stopNativeProcess,
} from "./native-process.ts";
import type { SandboxDriver, SandboxLaunch } from "./sandbox-runtime.ts";
import type { RunnerSettings } from "./settings.ts";

const nameSchema = z
  .string()
  .regex(
    /^deepx-codex-[a-f0-9]{32}-(prepare|setup|implement|check|export|publish)$/,
  );
const processSchema = z.object({
  pid: z.number().int().min(2),
  start: z.string().regex(/^\d+$/),
  boot: z.uuid(),
  exitCode: z.number().int().optional(),
});

/** Explicit host execution, not a tenant or filesystem sandbox. */
export class NativeDriver implements SandboxDriver {
  private checked = false;
  private pending = new Map<string, SandboxLaunch>();
  private root: string;
  constructor(
    private settings: RunnerSettings,
    private paths = {
      phase: fileURLToPath(new URL("./native-phase.js", import.meta.url)),
      job: fileURLToPath(new URL("./job.js", import.meta.url)),
    },
  ) {
    this.root = resolve(settings.CODEX_RUNNER_STATE, "native-processes");
  }
  private path(name: string) {
    return join(this.root, `${nameSchema.parse(name)}.json`);
  }
  private async record(name: string) {
    return processSchema.parse(await readNativeProcess(this.path(name)));
  }
  async ready() {
    requireThat(
      this.settings.CODEX_NATIVE_ENABLED === "true",
      "coding_runtime_not_configured",
      409,
    );
    requireThat(
      process.platform === "linux" &&
        process.getuid?.() !== 0 &&
        !existsSync("/.dockerenv") &&
        !existsSync("/run/.containerenv"),
      "coding_native_host_required",
      503,
    );
    await Promise.all([access(this.paths.phase), access(this.paths.job)]);
    const env = { PATH: process.env.PATH, HOME: "/nonexistent" };
    // Offline checks only. Neither host login state nor a model request is used.
    for (const [binary, args] of [
      [this.settings.CODEX_NATIVE_CODEX_BIN, ["--version"]],
      ["git", ["--version"]],
      ["bash", ["--version"]],
    ] as const)
      await promisify(execFile)(binary, [...args], {
        env,
        timeout: 10000,
        maxBuffer: 4096,
      });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.checked = true;
  }
  async create(spec: SandboxLaunch) {
    if (!this.checked) await this.ready();
    const name = nameSchema.parse(spec.name);
    requireThat(
      !this.pending.has(name) && !existsSync(this.path(name)),
      "coding_outcome_unknown",
      409,
    );
    this.pending.set(name, spec);
    return name;
  }
  async run(id: string, command: string[], attach: boolean) {
    const spec = this.pending.get(id);
    requireThat(
      spec && command[1] === "/opt/deepx/job.js",
      "coding_job_invalid",
      409,
    );
    this.pending.delete(id); // A lost launch is never replayed.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const mount = (target: string) =>
      spec.mounts.find((m) => m.target === target)?.source;
    const work = mount("/task"),
      input = mount("/input");
    requireThat(work && input, "coding_job_invalid", 409);
    const home = join(work, "home"),
      temp = join(work, "tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temp, { recursive: true, mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        this.paths.phase,
        this.path(id),
        `${this.path(id)}.out`,
        this.paths.job,
        id.split("-").at(-1) as string,
      ],
      {
        cwd: work,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          ...spec.env,
          HOME: home,
          TMPDIR: temp,
          REPODESK_TASK_ROOT: work,
          REPODESK_INPUT_ROOT: input,
          REPODESK_AUTH_ROOT: mount("/auth") ?? join(work, "unused-auth"),
          REPODESK_CODEX_BIN: this.settings.CODEX_NATIVE_CODEX_BIN,
        },
      },
    );
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(Error("coding_execution_failed")));
    });
    try {
      const identity = await nativeIdentity(child.pid as number);
      await saveNativeProcess(this.path(id), identity);
      child.stdin?.on("error", () => {});
      child.stdin?.end("start\n");
    } catch (error) {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      throw error;
    }
    if (attach) {
      await closed;
      const result = await this.inspect(id, id);
      return {
        exitCode: result.ExitCode,
        stdout: await readFile(`${this.path(id)}.out`, "utf8"),
      };
    }
    child.unref();
    return { jobId: id };
  }
  async inspect(id: string, jobId: string) {
    requireThat(id === jobId, "coding_job_invalid", 409);
    const saved = await this.record(id);
    if (saved.exitCode !== undefined) {
      await stopNativeProcess(saved);
      return {
        Running: false,
        Status: "exited",
        ExitCode: saved.exitCode,
        OOMKilled: false,
      };
    }
    try {
      const current = await nativeIdentity(saved.pid);
      if (current.boot !== saved.boot)
        return {
          Running: false,
          Status: "exited",
          ExitCode: 137,
          OOMKilled: false,
        };
      requireThat(current.start === saved.start, "coding_outcome_unknown", 409);
      return { Running: true, Status: "running", ExitCode: 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await stopNativeProcess(saved);
      return {
        Running: false,
        Status: "exited",
        ExitCode: 137,
        OOMKilled: false,
      };
    }
  }
  async destroy(name: string, id?: string) {
    nameSchema.parse(name);
    requireThat(!id || id === name, "coding_job_invalid", 409);
    this.pending.delete(name);
    try {
      await stopNativeProcess(await this.record(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(this.path(name), { force: true });
    await rm(`${this.path(name)}.out`, { force: true });
    await rm(`${this.path(name)}.tmp`, { force: true });
  }
}
