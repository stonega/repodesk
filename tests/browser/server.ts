import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { ReviewService } from "../../src/review-bot/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";
import { githubTransport } from "../github-fixture.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const browserPort = Number(process.env.BROWSER_PORT ?? 3107);
const browserOrigin = `http://127.0.0.1:${browserPort}`;
const browserDbPath =
  process.env.BROWSER_DB_PATH ??
  join(tmpdir(), "repodesk-browser-3107-db.json");
const root = database(rootUrl);
const name = `deepx_browser_${randomUUID().replaceAll("-", "")}`;
await root.query(`CREATE DATABASE ${name}`);
const parsed = new URL(rootUrl);
parsed.pathname = `/${name}`;
const pool = database(parsed.toString());
await migrate(pool);
await mkdir("test-results", { recursive: true });
await writeFile(browserDbPath, JSON.stringify({ url: parsed.toString() }), {
  mode: 0o600,
});
const log = new RuntimeLogger(pool, "app", () => {});
const store = new Store(pool, log);
log.write("app_started");
const setup = new SetupService(
  store,
  "ab".repeat(32),
  browserOrigin,
  () => ({
    async call<T>(method: string) {
      return (
        method === "getUpdates"
          ? []
          : method === "getMe"
            ? {
                id: 999,
                is_bot: true,
                username: "fixture_bot",
                can_read_all_group_messages: true,
              }
            : { url: "" }
      ) as T;
    },
  }),
  process.env.BROWSER_TELEGRAM_TRANSPORT === "polling" ? "polling" : "webhook",
  async (_input, init) => {
    const key = new Headers(init?.headers).get("authorization");
    if (key === "Bearer fixture-bad-key")
      return Response.json({ error: "fixture auth error" }, { status: 401 });
    return Response.json({
      data: [
        { id: "gpt-4.1-mini" },
        { id: "gpt-4.1" },
        { id: "team/custom-model" },
      ],
    });
  },
);
const shutdown = new AbortController();
const polling =
  setup.telegramTransport === "polling"
    ? new TelegramPoller(store, setup).run(shutdown.signal)
    : Promise.resolve();
const reviewApps = new GitHubApps(
  store,
  "ab".repeat(32),
  undefined,
  githubTransport(undefined, 13),
);
const server = serve({
  fetch: createApp(
    store,
    setup,
    browserOrigin,
    undefined,
    new GitHubService(
      store,
      "ab".repeat(32),
      browserOrigin,
      new GitHubApps(
        store,
        "ab".repeat(32),
        undefined,
        githubTransport(undefined, 13),
      ),
    ),
    "ab".repeat(32),
    undefined,
    new ReviewService(store, reviewApps, "ab".repeat(32), browserOrigin),
  ).fetch,
  hostname: "127.0.0.1",
  port: browserPort,
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  server.close(async () => {
    await polling;
    await log.close();
    await pool.end();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
    await rm(browserDbPath, { force: true });
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
