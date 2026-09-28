import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault } from "../../src/domain.ts";
import {
  pruneRuntimeLogs,
  RuntimeLogger,
} from "../../src/observability/logs.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("runtime logs (isolated PostgreSQL)", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `deepx_logs_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  let log: RuntimeLogger;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let adminId: string;
  let workspaceId: string;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    log = new RuntimeLogger(pool, "worker", () => {});
    store = new Store(pool, log);
    app = createApp(
      store,
      new SetupService(store, "ad".repeat(32), "http://localhost:3000"),
      "http://localhost:3000",
    );
    const claimed = await claim(
      pool,

      "logoperator",
      "test password long enough",
    );
    cookie = `deepx_session=${claimed.raw}`;
    adminId = (
      await pool.query("SELECT id FROM admins WHERE username='logoperator'")
    ).rows[0].id;
    const w = workspace();
    w.operatorId = adminId;
    workspaceId = w.id;
    await pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, adminId, JSON.stringify(w)],
    );
  });
  afterAll(async () => {
    await log?.close();
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const request = (query = "", auth = cookie) =>
    app.request(`/api/admin/operator/logs${query}`, {
      headers: { cookie: auth },
    });
  test("operator-only endpoint works before Telegram linking and persists redacted events", async () => {
    log.write("worker_started");
    log.write("run_failed", {
      error: new Fault("workspace_budget_exhausted"),
      workspaceId,
      runId: randomUUID(),
    });
    log.write("telegram_polling_failed", {
      error: new Error("sk-secret-private-message"),
    });
    await log.flush();
    expect((await request("", "")).status).toBe(401);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.items).toHaveLength(3);
    expect(data.items[0].event).toBe("telegram_polling_failed");
    expect(JSON.stringify(data)).not.toContain("sk-secret");
    expect(data.items[1].code).toBe("workspace_budget_exhausted");
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS count FROM runtime_logs",
        )
      ).rows[0].count,
    ).toBe(3);
  });
  test("filters, literal search and stable cursor pagination", async () => {
    const filtered = await (
      await request("?level=error&service=worker&q=budget")
    ).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].event).toBe("run_failed");
    const first = await (await request("?limit=1")).json();
    log.write("worker_started");
    await log.flush();
    const second = await (
      await request(`?limit=1&before=${first.nextBefore}`)
    ).json();
    expect(second.items[0].event).toBe("run_failed");
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect((await (await request("?q=%25")).json()).items).toHaveLength(0);
    expect((await request("?limit=101")).status).toBe(400);
    expect((await request("?service=invalid")).status).toBe(400);
  });
  test("tenant run metadata cannot be read by another deployment operator", async () => {
    const otherId = randomUUID();
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) SELECT $1,'otheroperator',password_hash,true FROM admins WHERE id=$2",
      [otherId, adminId],
    );
    const other = await login(
      store.pool,
      "otheroperator",
      "test password long enough",
    );
    const result = await (
      await request("", `deepx_session=${other.raw}`)
    ).json();
    expect(
      result.items.some(
        (item: { workspace_id: string | null }) =>
          item.workspace_id === workspaceId,
      ),
    ).toBe(false);
    expect(
      result.items.some(
        (item: { event: string }) => item.event === "worker_started",
      ),
    ).toBe(true);
    await store.pool.query("UPDATE admins SET operator=false WHERE id=$1", [
      otherId,
    ]);
    expect((await request("", `deepx_session=${other.raw}`)).status).toBe(403);
    await store.pool.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1",
      [otherId],
    );
    expect((await request("", `deepx_session=${other.raw}`)).status).toBe(401);
  });
  test("deleted workspace logs are hidden and cannot be recreated by a late event", async () => {
    await store.pool.query(
      "UPDATE workspaces SET data=jsonb_set(data,'{deletion}','{\"requestedAt\":\"now\"}'::jsonb) WHERE id=$1",
      [workspaceId],
    );
    const before = (
      await store.pool.query(
        "SELECT count(*)::int AS count FROM runtime_logs WHERE workspace_id=$1",
        [workspaceId],
      )
    ).rows[0].count;
    log.write("run_failed", { workspaceId, runId: randomUUID() });
    await log.flush();
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS count FROM runtime_logs WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0].count,
    ).toBe(before);
    expect((await (await request("?level=error")).json()).items).toHaveLength(
      0,
    );
  });
  test("retention prunes expired records and caps the retained history", async () => {
    await store.pool.query(
      "INSERT INTO runtime_logs(at,service,level,event) VALUES(now()-interval '8 days','app','info','app_started')",
    );
    expect((await (await request("?service=app")).json()).items).toHaveLength(
      0,
    );
    await store.pool.query(
      "INSERT INTO runtime_logs(service,level,event) SELECT 'app','info','app_started' FROM generate_series(1,10005)",
    );
    await pruneRuntimeLogs(store.pool);
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS count FROM runtime_logs",
        )
      ).rows[0].count,
    ).toBe(10000);
    expect(
      (
        await store.pool.query(
          "SELECT 1 FROM runtime_logs WHERE at<now()-interval '7 days'",
        )
      ).rowCount,
    ).toBe(0);
  });
});
