import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { TelegramPoller } from "../../src/telegram/polling.ts";
import { githubTransport } from "../github-fixture.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
if (!rootUrl) throw Error("TEST_DATABASE_URL required");
const root = database(rootUrl);
const name = `deepx_browser_${randomUUID().replaceAll("-", "")}`;
await root.query(`CREATE DATABASE ${name}`);
const parsed = new URL(rootUrl);
parsed.pathname = `/${name}`;
const pool = database(parsed.toString());
await migrate(pool);
await pool.query(
  "UPDATE deployment SET bootstrap_hash=$1,bootstrap_expires_at=now()+interval '15 minutes' WHERE id=true",
  [hash("browser-claim-token")],
);
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/browser-db.json",
  JSON.stringify({ url: parsed.toString() }),
);
const log = new RuntimeLogger(pool, "app", () => {});
const store = new Store(pool, log);
log.write("app_started");
const setup = new SetupService(
  store,
  "ab".repeat(32),
  "http://127.0.0.1:3107",
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
);
const shutdown = new AbortController();
const polling =
  setup.telegramTransport === "polling"
    ? new TelegramPoller(store, setup).run(shutdown.signal)
    : Promise.resolve();
const server = serve({
  fetch: createApp(
    store,
    setup,
    "http://127.0.0.1:3107",
    undefined,
    new GitHubService(
      store,
      "ab".repeat(32),
      "http://127.0.0.1:3107",
      new GitHubApps(store, "ab".repeat(32), undefined, githubTransport()),
    ),
  ).fetch,
  hostname: "127.0.0.1",
  port: 3107,
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
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
