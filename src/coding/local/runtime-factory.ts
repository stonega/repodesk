import { Docker } from "./docker.ts";
import { NativeDriver } from "./native-driver.ts";
import { OpenSandboxDriver } from "./opensandbox.ts";
import { SandboxTaskRuntime } from "./sandbox-runtime.ts";
import type { RunnerSettings } from "./settings.ts";
import { OciTaskRuntime, type TaskRuntime } from "./task-runtime.ts";

export function taskRuntime(settings: RunnerSettings): TaskRuntime {
  switch (settings.CODEX_CONTAINER_ENGINE) {
    case "native":
      return new SandboxTaskRuntime(settings, new NativeDriver(settings));
    case "opensandbox":
      return new SandboxTaskRuntime(settings, new OpenSandboxDriver(settings));
    case "docker":
      return new OciTaskRuntime(settings, new Docker(settings));
  }
}
