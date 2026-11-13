import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { PluginPackageOptions } from "./package-service.ts";
import { PluginRunnerClient } from "./runner-client.ts";

export function packageRuntime(config: Config): PluginPackageOptions {
  return {
    directory: config.PLUGIN_PACKAGES_DIRECTORY,
    runtimeIdentity: config.PLUGIN_RUNNER_URL,
    encryptionKey: config.ENCRYPTION_KEY,
    sandbox:
      config.PLUGIN_RUNNER_URL &&
      (config.PLUGIN_RUNNER_TOKEN || config.PLUGIN_RUNNER_TOKEN_FILE)
        ? new PluginRunnerClient(config.PLUGIN_RUNNER_URL, () =>
            config.PLUGIN_RUNNER_TOKEN_FILE
              ? readFileSync(config.PLUGIN_RUNNER_TOKEN_FILE, "utf8").trim()
              : (config.PLUGIN_RUNNER_TOKEN ?? ""),
          )
        : undefined,
  };
}
