import { serve } from "@hono/node-server";
import { PluginService } from "./agent/plugin-service.ts";
import { createApp } from "./app.ts";
import { CodeTruthClient } from "./code-truth/client.ts";
import { LocalRunnerClient } from "./coding/local/client.ts";
import { config } from "./config.ts";
import { database } from "./db/pool.ts";
import { Store } from "./db/repositories.ts";
import { configuredGitHubApp } from "./github/app.ts";
import { GitHubApps } from "./github/registry.ts";
import { GitHubService } from "./github/service.ts";
import { RuntimeLogger } from "./observability/logs.ts";
import { ReviewService } from "./review-bot/service.ts";
import { SetupService } from "./setup/service.ts";

const cfg = config();
const pool = database(cfg.DATABASE_URL);
const log = new RuntimeLogger(pool, "app");
const store = new Store(pool, log);
const githubApp = new GitHubApps(
  store,
  cfg.ENCRYPTION_KEY,
  configuredGitHubApp(cfg),
);
const app = createApp(
  store,
  new SetupService(
    store,
    cfg.ENCRYPTION_KEY,
    cfg.PUBLIC_ORIGIN,
    undefined,
    cfg.TELEGRAM_TRANSPORT,
  ),
  cfg.PUBLIC_ORIGIN,
  new PluginService(
    store,
    cfg.PI_EXTENSIONS_FILE,
    cfg.CODE_TRUTH_URL && cfg.CODE_TRUTH_TOKEN
      ? new CodeTruthClient(cfg.CODE_TRUTH_URL, cfg.CODE_TRUTH_TOKEN)
      : undefined,
    githubApp,
  ),
  new GitHubService(store, cfg.ENCRYPTION_KEY, cfg.PUBLIC_ORIGIN, githubApp),
  cfg.ENCRYPTION_KEY,
  cfg.CODEX_RUNNER_URL && cfg.CODEX_RUNNER_TOKEN
    ? new LocalRunnerClient(cfg.CODEX_RUNNER_URL, cfg.CODEX_RUNNER_TOKEN)
    : undefined,
  new ReviewService(store, githubApp, cfg.ENCRYPTION_KEY, cfg.PUBLIC_ORIGIN),
);
const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: cfg.PORT });
log.write("app_started");
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  log.write("app_stopping");
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(async () => {
    await log.close();
    await pool.end();
    clearTimeout(deadline);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
