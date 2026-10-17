import { constants } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requireThat } from "../../domain.ts";
import { decrypt, encrypt, hash } from "../../setup/credentials.ts";
import type { RunnerSettings } from "./settings.ts";
import {
  type TaskRuntime,
  type TaskSpec,
  type TaskState,
  taskState,
} from "./task-runtime.ts";

export interface SandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
}
export interface SandboxLaunch {
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  env: Record<string, string>;
  mounts: SandboxMount[];
  network: boolean;
}
/** SDK adapters own remote identities; callers never supply arbitrary sandbox IDs. */
export interface SandboxDriver {
  ready(): Promise<void>;
  create(spec: SandboxLaunch): Promise<string>;
  run(
    id: string,
    command: string[],
    attach: boolean,
  ): Promise<{ jobId?: string; stdout?: string; exitCode?: number }>;
  inspect(id: string, jobId: string): Promise<TaskState>;
  destroy(name: string, id?: string): Promise<void>;
}

const nameSchema = z
  .string()
  .regex(
    /^deepx-codex-[a-f0-9]{32}-(prepare|setup|implement|check|export|publish)$/,
  );
const volumeSchema = z
  .string()
  .regex(/^deepx-codex-[a-f0-9]{32}-(work|publish|auth|input)$/);
const recordSchema = z.object({
  name: nameSchema,
  volume: volumeSchema,
  mode: z.enum(["prepare", "setup", "implement", "check", "export", "publish"]),
  authVolume: volumeSchema.optional(),
  backend: z.literal("opensandbox"),
  sealedEnv: z.string().optional(),
  state: z.enum(["created", "starting", "started", "exited"]),
  sandboxId: z.string().optional(),
  jobId: z.string().optional(),
  exitCode: z.number().int().optional(),
});
type SandboxRecord = z.infer<typeof recordSchema>;

/** Shared data survives each fresh phase; credentials and writable roots do not. */
export class SandboxTaskRuntime implements TaskRuntime {
  readonly root: string;
  private hostRoot: string;
  private metadata: string;
  constructor(
    private settings: RunnerSettings,
    private driver: SandboxDriver,
  ) {
    this.root =
      settings.CODEX_SANDBOX_ROOT ??
      join(settings.CODEX_RUNNER_STATE, "sandbox-data");
    this.hostRoot = settings.CODEX_SANDBOX_HOST_ROOT ?? this.root;
    this.metadata = join(settings.CODEX_RUNNER_STATE, "sandbox-runtime");
  }
  private async initialize() {
    for (const path of [
      this.root,
      this.metadata,
      join(this.root, "volumes"),
      join(this.root, "inputs"),
    ])
      await mkdir(path, { recursive: true, mode: 0o700 });
  }
  private path(name: string) {
    return join(this.metadata, `${nameSchema.parse(name)}.json`);
  }
  private volume(name: string) {
    return join(this.root, "volumes", volumeSchema.parse(name));
  }
  private async record(name: string) {
    const r = recordSchema.parse(
      JSON.parse(await readFile(this.path(name), "utf8")),
    );
    requireThat(
      r.name === name && r.backend === this.settings.CODEX_CONTAINER_ENGINE,
      "coding_runtime_mismatch",
      409,
    );
    return r;
  }
  private async save(r: SandboxRecord) {
    await writeFile(`${this.path(r.name)}.tmp`, JSON.stringify(r), {
      mode: 0o600,
    });
    await rename(`${this.path(r.name)}.tmp`, this.path(r.name));
  }
  async ready() {
    requireThat(
      [0, 1000].includes(process.getuid?.() ?? -1),
      "coding_sandbox_supervisor_uid_invalid",
      503,
    );
    await this.initialize();
    await this.driver.ready();
  }
  async createVolume(name: string) {
    await this.initialize();
    const path = this.volume(name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    // A dedicated unprivileged supervisor may own storage instead of root.
    if (process.getuid?.() === 0) await chown(path, 1000, 1000);
    await chmod(path, 0o700);
  }
  async create(spec: TaskSpec) {
    nameSchema.parse(spec.name);
    const key = spec.name.replace(/-[a-z]+$/, "");
    requireThat(
      spec.name === `${key}-${spec.mode}` &&
        spec.volume ===
          `${key}-${spec.mode === "publish" ? "publish" : "work"}` &&
        (!spec.authVolume ||
          (spec.mode === "implement" && spec.authVolume === `${key}-auth`)),
      "coding_job_invalid",
      409,
    );
    await this.initialize();
    try {
      await readFile(this.path(spec.name));
      throw new Error("coding_phase_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.createVolume(spec.volume);
    if (spec.authVolume) await this.createVolume(spec.authVolume);
    await mkdir(join(this.root, "inputs", spec.name), { mode: 0o755 });
    const { env, ...safe } = spec;
    await this.save({
      ...safe,
      backend: this.settings.CODEX_CONTAINER_ENGINE as SandboxRecord["backend"],
      sealedEnv: encrypt(
        hash(this.settings.CODEX_RUNNER_TOKEN),
        spec.name,
        JSON.stringify(env),
      ),
      state: "created",
    });
  }
  private file(r: SandboxRecord, path: string) {
    const match = path.match(/^\/(task|input|auth)\/([a-zA-Z0-9_.-]+)$/);
    requireThat(
      match && match[2] !== "." && match[2] !== "..",
      "coding_artifact_invalid",
      409,
    );
    const base =
      match[1] === "input"
        ? join(this.root, "inputs", r.name)
        : match[1] === "auth"
          ? this.volume(r.authVolume ?? "")
          : this.volume(r.volume);
    return join(base, match[2] as string);
  }
  async copyFile(source: string, name: string, path: string) {
    const r = await this.record(name);
    requireThat(
      r.state === "created" &&
        (/^\/input\//.test(path) || path === "/auth/auth.json"),
      "coding_input_denied",
      409,
    );
    const file = await open(
      this.file(r, path),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      path.startsWith("/auth/") ? 0o600 : 0o444,
    );
    try {
      await file.writeFile(await readFile(source));
      if (path.startsWith("/auth/") && process.getuid?.() === 0)
        await file.chown(1000, 1000);
    } finally {
      await file.close();
    }
  }
  async start(name: string, attach = false) {
    const r = await this.record(name);
    requireThat(r.state === "created", "coding_outcome_unknown", 409);
    const env = JSON.parse(
      decrypt(hash(this.settings.CODEX_RUNNER_TOKEN), name, r.sealedEnv ?? ""),
    ) as Record<string, string>;
    r.state = "starting";
    delete r.sealedEnv;
    await this.save(r); // Never replay an uncertain create or command launch.
    const mounts: SandboxMount[] = [
      {
        source: join(this.hostRoot, "volumes", r.volume),
        target: "/task",
        readOnly: r.mode === "export",
      },
      {
        source: join(this.hostRoot, "inputs", name),
        target: "/input",
        readOnly: true,
      },
    ];
    if (r.authVolume)
      mounts.push({
        source: join(this.hostRoot, "volumes", r.authVolume),
        target: "/auth",
        readOnly: false,
      });
    r.sandboxId = await this.driver.create({
      name,
      image: this.settings.CODEX_RUNNER_IMAGE,
      cpus: this.settings.CODEX_RUNNER_CPUS,
      memoryMb: this.settings.CODEX_RUNNER_MEMORY_MB,
      env: { HOME: "/task/home", ...env },
      mounts,
      network: r.mode !== "export",
    });
    await this.save(r);
    const result = await this.driver.run(
      r.sandboxId,
      ["node", "/opt/deepx/job.js", r.mode],
      attach,
    );
    if (attach) {
      requireThat(result.exitCode === 0, "coding_execution_failed", 503);
      await this.driver.destroy(name, r.sandboxId);
      r.state = "exited";
      r.exitCode = result.exitCode;
    } else {
      requireThat(result.jobId, "coding_outcome_unknown", 503);
      r.jobId = result.jobId;
      r.state = "started";
    }
    await this.save(r);
    return result.stdout ?? "";
  }
  async inspect(name: string) {
    const r = await this.record(name);
    if (r.state === "exited")
      return { Running: false, Status: "exited", ExitCode: r.exitCode ?? 1 };
    requireThat(r.sandboxId && r.jobId, "coding_outcome_unknown", 503);
    const state = taskState.parse(
      await this.driver.inspect(r.sandboxId, r.jobId),
    );
    if (!state.Running) {
      requireThat(state.Status === "exited", "coding_outcome_unknown", 503);
      await this.driver.destroy(name, r.sandboxId); // No phase processes survive into the next phase.
      r.state = "exited";
      r.exitCode = state.ExitCode;
      await this.save(r);
    }
    return state;
  }
  async readText(name: string, path: string, maxBytes = 4096) {
    const r = await this.record(name);
    const file = await open(
      this.file(r, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      requireThat(
        stat.isFile() && stat.size <= maxBytes,
        "coding_artifact_invalid",
        503,
      );
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      requireThat(bytesRead <= maxBytes, "coding_artifact_invalid", 503);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  }
  async stop(name: string) {
    const r = await this.record(name);
    await this.driver.destroy(name, r.sandboxId);
    r.state = "exited";
    r.exitCode ??= 137;
    delete r.sealedEnv;
    await this.save(r);
  }
  async remove(names: string[]) {
    for (const name of names) {
      if (name.endsWith("-input")) continue; // OCI input copiers have no sandbox equivalent.
      nameSchema.parse(name);
      let r: SandboxRecord;
      try {
        r = await this.record(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await this.driver.destroy(name, r.sandboxId);
      await rm(join(this.root, "inputs", name), {
        recursive: true,
        force: true,
      });
      await rm(this.path(name), { force: true });
      await rm(`${this.path(name)}.tmp`, { force: true });
    }
  }
  async listVolumes(prefix: string) {
    requireThat(
      /^deepx-codex-[a-f0-9]{32}(?:-(?:work|publish|auth|input))?$/.test(
        prefix,
      ),
      "coding_job_invalid",
      409,
    );
    await this.initialize();
    return (await readdir(join(this.root, "volumes"))).filter(
      (name) => volumeSchema.safeParse(name).success && name.startsWith(prefix),
    );
  }
  async removeVolumes(names: string[]) {
    for (const name of names)
      await rm(this.volume(name), { recursive: true, force: true });
  }
}
