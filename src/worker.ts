import { PluginService } from "./agent/plugin-service.ts";
import { CodeTruthClient } from "./code-truth/client.ts";
import { LocalRunnerClient } from "./coding/local/client.ts";
import { CodingService } from "./coding/service.ts";
import { config } from "./config.ts";
import { database } from "./db/pool.ts";
import { Store } from "./db/repositories.ts";
import { configuredGitHubApp } from "./github/app.ts";
import { GitHubIssues } from "./github/issues.ts";
import { GitHubApps } from "./github/registry.ts";
import { startWorker } from "./jobs/queue.ts";
import { RuntimeLogger } from "./observability/logs.ts";
import { SetupService } from "./setup/service.ts";

const cfg = config();
const pool = database(cfg.DATABASE_URL);
const log = new RuntimeLogger(pool, "worker");
const store = new Store(pool, log);
const githubApps = new GitHubApps(
  store,
  cfg.ENCRYPTION_KEY,
  configuredGitHubApp(cfg),
);
const plugins = new PluginService(
  store,
  cfg.PI_EXTENSIONS_FILE,
  cfg.CODE_TRUTH_URL && cfg.CODE_TRUTH_TOKEN
    ? new CodeTruthClient(cfg.CODE_TRUTH_URL, cfg.CODE_TRUTH_TOKEN)
    : undefined,
  githubApps,
);
const stop = await startWorker(
  store,
  new SetupService(
    store,
    cfg.ENCRYPTION_KEY,
    cfg.PUBLIC_ORIGIN,
    undefined,
    cfg.TELEGRAM_TRANSPORT,
  ),
  cfg.DATABASE_URL,
  (deployment, workspaceId) => plugins.runner(deployment, workspaceId),
  cfg.RUN_TIMEOUT_SECONDS,
  new GitHubIssues(store, githubApps),
  new CodingService(
    store,
    githubApps,
    cfg.CODEX_RUNNER_URL && cfg.CODEX_RUNNER_TOKEN
      ? new LocalRunnerClient(cfg.CODEX_RUNNER_URL, cfg.CODEX_RUNNER_TOKEN)
      : undefined,
    cfg.ENCRYPTION_KEY,
  ),
);
log.write("worker_started");
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log.write("worker_stopping");
  await stop();
  await log.close();
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
