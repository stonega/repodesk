import { z } from "zod";
import { type ContainerEngine, containerArgs } from "./container.ts";
import type { RunnerSettings } from "./settings.ts";

export type TaskMode =
  | "prepare"
  | "setup"
  | "implement"
  | "check"
  | "export"
  | "publish";
export interface TaskSpec {
  name: string;
  volume: string;
  mode: TaskMode;
  env: Record<string, string>;
  authVolume?: string;
}
export const taskState = z.object({
  Running: z.boolean(),
  Status: z.string(),
  ExitCode: z.number().int(),
});
export type TaskState = z.infer<typeof taskState>;

/** Phase isolation and durable work storage, independent of a container CLI. */
export interface TaskRuntime {
  ready(): Promise<void>;
  create(spec: TaskSpec): Promise<void>;
  copyFile(source: string, name: string, path: string): Promise<void>;
  start(name: string, attach?: boolean): Promise<string>;
  inspect(name: string): Promise<TaskState>;
  readText(name: string, path: string, maxBytes?: number): Promise<string>;
  stop(name: string): Promise<void>;
  remove(names: string[]): Promise<void>;
  createVolume(name: string): Promise<void>;
  listVolumes(prefix: string): Promise<string[]>;
  removeVolumes(names: string[]): Promise<void>;
}

/** Keep Docker phase behavior and deterministic engine fixtures. */
export class OciTaskRuntime implements TaskRuntime {
  constructor(
    private settings: RunnerSettings,
    private engine: ContainerEngine,
  ) {}
  async ready() {
    await this.engine.command([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.settings.CODEX_RUNNER_IMAGE,
    ]);
    await this.engine.command([
      "network",
      "inspect",
      this.settings.CODEX_RUNNER_NETWORK,
    ]);
  }
  async create(spec: TaskSpec) {
    if (spec.authVolume) await this.createVolume(spec.authVolume);
    await this.engine.command(
      containerArgs(
        this.settings,
        spec.name,
        spec.volume,
        spec.mode,
        spec.env,
        spec.authVolume,
      ),
      spec.env,
    );
  }
  async copyFile(source: string, name: string, path: string) {
    await this.engine.command(["cp", source, `${name}:${path}`]);
  }
  start(name: string, attach = false) {
    return this.engine.command(
      attach ? ["start", "--attach", name] : ["start", name],
    );
  }
  async inspect(name: string) {
    return taskState.parse(
      JSON.parse(
        await this.engine.command([
          "inspect",
          "--format",
          "{{json .State}}",
          name,
        ]),
      ),
    );
  }
  readText(name: string, path: string, maxBytes?: number) {
    return this.engine.readText(name, path, maxBytes);
  }
  async stop(name: string) {
    await this.engine.command(["stop", "--ignore", "--time", "0", name]);
  }
  async remove(names: string[]) {
    if (names.length)
      await this.engine.command(["rm", "--force", "--ignore", ...names]);
  }
  async createVolume(name: string) {
    await this.engine.command(["volume", "create", name]);
  }
  async listVolumes(prefix: string) {
    return (
      await this.engine.command([
        "volume",
        "ls",
        "--format",
        "{{.Name}}",
        "--filter",
        `name=${prefix}`,
      ])
    ).split("\n");
  }
  async removeVolumes(names: string[]) {
    if (names.length)
      await this.engine.command(["volume", "rm", "--force", ...names]);
  }
}
