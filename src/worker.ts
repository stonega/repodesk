import { pluginRuntime } from "./agent/plugin-runtime.ts";
import { LocalRunnerClient } from "./coding/local/client.ts";
import { CodingService } from "./coding/service.ts";
import { config } from "./config.ts";
import { database } from "./db/pool.ts";
import { Store } from "./db/repositories.ts";
import { configuredGitHubApp } from "./github/app.ts";
import { GitHubIssues } from "./github/issues.ts";
import { GitHubPullRequests } from "./github/pull-requests.ts";
import { GitHubApps } from "./github/registry.ts";
import { GitHubUsers } from "./github/users.ts";
import { startWorker } from "./jobs/queue.ts";
import { RuntimeLogger } from "./observability/logs.ts";
import { ReviewExecutor } from "./review-bot/executor.ts";
import { SetupService } from "./setup/service.ts";
import { qwenRuntime } from "./transcription/runtime.ts";

const cfg = config();
const pool = database(cfg.DATABASE_URL);
const log = new RuntimeLogger(pool, "worker");
const store = new Store(pool, log, cfg.ENCRYPTION_KEY);
const githubApps = new GitHubApps(
  store,
  cfg.ENCRYPTION_KEY,
  configuredGitHubApp(cfg),
);
const plugins = pluginRuntime(store, cfg, githubApps);
const localRunner =
  cfg.CODEX_RUNNER_URL && cfg.CODEX_RUNNER_TOKEN
    ? new LocalRunnerClient(cfg.CODEX_RUNNER_URL, cfg.CODEX_RUNNER_TOKEN)
    : undefined;
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
  new GitHubIssues(store, githubApps),
  new CodingService(
    store,
    githubApps,
    localRunner,
    cfg.ENCRYPTION_KEY,
    plugins.browser.coding,
  ),
  new GitHubUsers(store, githubApps, cfg.ENCRYPTION_KEY, cfg.PUBLIC_ORIGIN),
  new ReviewExecutor(store, githubApps, localRunner, cfg.ENCRYPTION_KEY),
  new GitHubPullRequests(store, githubApps),
  plugins.cloudflare,
  plugins.google,
  plugins.searchConsole,
  plugins.transcription,
  plugins.browser,
);
log.write("worker_started");
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log.write("worker_stopping");
  await stop();
  qwenRuntime.close();
  await log.close();
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
