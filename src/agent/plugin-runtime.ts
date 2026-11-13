import { browserRuntime } from "../browser/runtime.ts";
import { CloudflareService } from "../cloudflare/service.ts";
import { CodeTruthClient } from "../code-truth/client.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db/repositories.ts";
import type { GitHubApps } from "../github/registry.ts";
import { GoogleService } from "../google/service.ts";
import { NowledgeService } from "../nowledge-mem/service.ts";
import { packageRuntime } from "../plugins/runtime.ts";
import { SearchConsoleService } from "../search-console/service.ts";
import { PluginService } from "./plugin-service.ts";

/** Shared API/worker wiring; optional credentials and services remain lazy. */
export function pluginRuntime(store: Store, cfg: Config, github: GitHubApps) {
  const google = new GoogleService(
    store,
    cfg.ENCRYPTION_KEY,
    cfg.PUBLIC_ORIGIN,
  );
  return new PluginService(
    store,
    cfg.PI_EXTENSIONS_FILE,
    cfg.CODE_TRUTH_URL && cfg.CODE_TRUTH_TOKEN
      ? new CodeTruthClient(cfg.CODE_TRUTH_URL, cfg.CODE_TRUTH_TOKEN)
      : undefined,
    github,
    new CloudflareService(
      store,
      cfg.ENCRYPTION_KEY,
      undefined,
      cfg.PUBLIC_ORIGIN,
    ),
    new SearchConsoleService(store, cfg.ENCRYPTION_KEY, undefined, google),
    google,
    undefined,
    browserRuntime(store, cfg.ENCRYPTION_KEY, cfg),
    new NowledgeService(store, cfg.ENCRYPTION_KEY),
    packageRuntime(cfg),
  );
}
