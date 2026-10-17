import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Fault } from "../../domain.ts";
import {
  type RuntimeEngine,
  type RuntimeSave,
  runtimeSave,
} from "../runtime-config.ts";
import type { RunnerSettings } from "./settings.ts";

/** Host configuration stays in the environment; only the selected profile is saved. */
export class RuntimeSelection {
  private value: RuntimeSave = { revision: 0, selection: null };
  private environment: RunnerSettings;
  private path: string;
  constructor(settings: RunnerSettings) {
    this.environment = { ...settings };
    this.path = join(settings.CODEX_RUNNER_STATE, "runtime-selection.json");
  }
  get current() {
    return { ...this.value };
  }
  get defaultEngine() {
    return this.environment.CODEX_CONTAINER_ENGINE;
  }
  async initialize() {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Fault("coding_runtime_state_invalid", 503);
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096)
        throw new Fault("coding_runtime_state_invalid", 503);
      this.value = runtimeSave.parse(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Fault("coding_runtime_state_invalid", 503);
    } finally {
      await file?.close();
    }
  }
  settings(selection: RuntimeEngine | null) {
    const engine = selection ?? this.defaultEngine;
    const base = this.environment;
    const image = {
      docker: base.CODEX_DOCKER_IMAGE,
      opensandbox: base.CODEX_OPENSANDBOX_IMAGE,
    }[engine];
    // OpenSandbox needs the execd-compatible root-USER image, unlike OCI jobs.
    if (engine === "opensandbox" && engine !== this.defaultEngine && !image)
      throw new Fault("coding_runtime_not_configured", 409);
    const alternate = engine !== this.defaultEngine;
    return {
      ...base,
      CODEX_CONTAINER_ENGINE: engine,
      CODEX_RUNNER_IMAGE: image ?? base.CODEX_RUNNER_IMAGE,
      CONTAINER_HOST:
        engine === "docker"
          ? (base.CODEX_DOCKER_HOST ??
            (alternate ? "unix:///var/run/docker.sock" : base.CONTAINER_HOST))
          : base.CONTAINER_HOST,
      CODEX_SANDBOX_ROOT:
        alternate && base.CODEX_SANDBOX_ROOT
          ? join(base.CODEX_SANDBOX_ROOT, engine)
          : base.CODEX_SANDBOX_ROOT,
      CODEX_SANDBOX_HOST_ROOT:
        alternate && base.CODEX_SANDBOX_HOST_ROOT
          ? join(base.CODEX_SANDBOX_HOST_ROOT, engine)
          : base.CODEX_SANDBOX_HOST_ROOT,
    } satisfies RunnerSettings;
  }
  async save(selection: RuntimeEngine | null) {
    const value = { revision: this.value.revision + 1, selection };
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
    this.value = value;
  }
}
