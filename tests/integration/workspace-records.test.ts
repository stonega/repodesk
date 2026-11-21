import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { coreWorkspaceData, Store } from "../../src/db/repositories.ts";
import { settingsSchema } from "../../src/domain.ts";
import { SetupService } from "../../src/setup/service.ts";
import { stopGeneration } from "../../src/telegram/generation.ts";
import { audit } from "../../src/workspaces/policy.ts";
import {
  createRun,
  deliver,
  enrollOwner,
  newWorkspace,
} from "../../src/workspaces/service.ts";

const baseUrl = process.env.TEST_DATABASE_URL;
const describeDb = baseUrl ? describe : describe.skip;

describeDb("relational workspace records and incremental outbox", () => {
  let pool: Pool;
  let adminPool: Pool;
  let dbName: string;
  let store: Store;
  let setup: SetupService;
  let adminId: string;
  const encryptionKey = "ab".repeat(32);

  beforeAll(async () => {
    if (!baseUrl) return;
    const parsed = new URL(baseUrl);
    dbName = `repodesk_records_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    adminPool = database(baseUrl);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    parsed.pathname = `/${dbName}`;
    pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool, undefined, encryptionKey);
    setup = new SetupService(store, encryptionKey, "http://localhost:3000");
    await claim(pool, "records-admin", "a long test password");
    adminId = (await pool.query("SELECT id FROM admins LIMIT 1")).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool && dbName) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    }
    await adminPool?.end();
  });

  test("persists messages, runs, deliveries, and audit in indexed relational tables outside workspaces.data", async () => {
    const { id } = await setup.createWorkspace(
      { id: adminId, username: "records-admin", operator: true },
      settingsSchema.parse({ name: "Relational Test", timezone: "UTC" }),
    );
    const initialRaw = (
      await pool.query("SELECT data FROM workspaces WHERE id=$1", [id])
    ).rows[0].data;
    expect(initialRaw).not.toHaveProperty("messages");
    expect(initialRaw).not.toHaveProperty("runs");
    expect(initialRaw).not.toHaveProperty("deliveries");
    expect(initialRaw).not.toHaveProperty("audit");

    let runId = "";
    let deliveryId = "";
    await store.change(id, (w) => {
      enrollOwner(w, "101");
      w.messages.push({
        id: "msg-1",
        chatId: "101",
        topicId: 0,
        author: "101",
        text: "hello relational world",
        at: "2026-11-20T00:00:00.000Z",
        expiresAt: "2026-12-20T00:00:00.000Z",
        directed: true,
      });
      const run = createRun(w, "101", "hello", "101", 0, "gpt-4.1-mini");
      run.telegramDraft = { id: 4242, botId: "bot-1", fence: 1 };
      run.fence = 1;
      runId = run.id;
      deliveryId = deliver(w, "101", "101", "reply text", {
        topicId: 0,
        runId: run.id,
      });
      audit(w, "101", "test.recorded", id);
    });

    const rawAfter = (
      await pool.query("SELECT data FROM workspaces WHERE id=$1", [id])
    ).rows[0].data;
    expect(rawAfter).not.toHaveProperty("messages");
    expect(rawAfter).not.toHaveProperty("runs");
    expect(rawAfter).not.toHaveProperty("deliveries");
    expect(rawAfter).not.toHaveProperty("audit");

    expect(
      (
        await pool.query(
          "SELECT id, chat_id FROM workspace_messages WHERE workspace_id=$1 ORDER BY seq",
          [id],
        )
      ).rows,
    ).toEqual([
      { id: "msg-1", chat_id: "101" },
      { id: `request:${runId}`, chat_id: "101" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT id, status, draft_id, draft_bot_id FROM workspace_runs WHERE workspace_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([
      { id: runId, status: "queued", draft_id: "4242", draft_bot_id: "bot-1" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT id, state, run_id FROM workspace_deliveries WHERE workspace_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ id: deliveryId, state: "pending", run_id: runId }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS c FROM workspace_audit WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].c,
    ).toBeGreaterThanOrEqual(2);

    // Outbox contains the newly queued run and pending delivery.
    expect(
      (
        await pool.query(
          "SELECT kind, target_id FROM outbox WHERE workspace_id=$1 ORDER BY kind",
          [id],
        )
      ).rows,
    ).toEqual([
      { kind: "delivery", target_id: deliveryId },
      { kind: "run", target_id: runId },
    ]);

    // Clearing outbox and making an unrelated settings save must NOT re-enqueue unchanged records.
    await pool.query("DELETE FROM outbox WHERE workspace_id=$1", [id]);
    await store.change(id, (w) => {
      w.settings.name = "Relational Test Renamed";
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS c FROM outbox WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].c,
    ).toBe(0);

    // stopGeneration finds the run via the indexed workspace_runs table.
    const stoppedWorkspace = await stopGeneration(store, pool, "bot-1", {
      chat: { id: 101, type: "private" },
      draft_id: 4242,
    });
    expect(stoppedWorkspace).toBe(id);
    const hydrated = await store.read(id);
    expect(hydrated.runs.find((r) => r.id === runId)?.status).toBe("cancelled");

    // Removing records in store.change deletes them from the relational tables.
    await store.change(id, (w) => {
      w.messages = [];
      w.audit = [];
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS c FROM workspace_messages WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].c,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS c FROM workspace_audit WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].c,
    ).toBe(0);
  });

  test("migration 026 backfills legacy inline JSONB arrays and strips them idempotently", async () => {
    const legacy = newWorkspace(
      adminId,
      settingsSchema.parse({ name: "Legacy Inline", timezone: "UTC" }),
    );
    enrollOwner(legacy, "202");
    const run = createRun(
      legacy,
      "202",
      "legacy task",
      "202",
      0,
      "gpt-4.1-mini",
    );
    const delId = deliver(legacy, "202", "202", "legacy reply", {
      topicId: 0,
      runId: run.id,
    });
    await pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [legacy.id, adminId, JSON.stringify(legacy)],
    );

    // Even before migration runs, Store.read handles raw inline data cleanly.
    expect((await store.read(legacy.id)).runs[0]?.id).toBe(run.id);

    const migrationSql = await readFile(
      "migrations/026_workspace_records.sql",
      "utf8",
    );
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const raw = (
      await pool.query("SELECT data FROM workspaces WHERE id=$1", [legacy.id])
    ).rows[0].data;
    expect(raw).not.toHaveProperty("runs");
    expect(raw).not.toHaveProperty("deliveries");
    const after = await store.read(legacy.id);
    expect(after.runs.map((r) => r.id)).toEqual([run.id]);
    expect(after.deliveries.map((d) => d.id)).toEqual([delId]);

    // Named AppDependencies works cleanly with createApp.
    const app = createApp({
      store,
      setup,
      origin: "http://localhost:3000",
      encryptionKey,
    });
    expect((await app.request("/healthz")).status).toBe(200);
    expect(coreWorkspaceData(after)).not.toHaveProperty("runs");
  });
});
