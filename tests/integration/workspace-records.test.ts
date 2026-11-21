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
import { audit, runAllowed } from "../../src/workspaces/policy.ts";
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
    dbName = `telo_records_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

  test("readForGuard, renewRunLease and mutateRunRow avoid full-workspace FOR UPDATE contention and preserve browser encryption", async () => {
    const { id } = await setup.createWorkspace(
      { id: adminId, username: "records-admin", operator: true },
      settingsSchema.parse({ name: "Run Row Locking", timezone: "UTC" }),
    );
    let run1Id = "";
    let run2Id = "";
    await store.change(id, (w) => {
      enrollOwner(w, "101");
      w.members.push({ id: "202", role: "member", active: true });
      const r1 = createRun(w, "101", "first task", "101", 0, "gpt-4.1-mini");
      r1.status = "running";
      r1.fence = 1;
      r1.leaseUntil = new Date(Date.now() + 60000).toISOString();
      r1.transcript = [{ role: "user", content: "heavy ".repeat(500) }];
      r1.tools = { t0: { name: "search_code", state: "done", result: "big" } };
      run1Id = r1.id;

      const r2 = createRun(w, "202", "second task", "202", 0, "gpt-4.1-mini");
      r2.status = "running";
      r2.fence = 1;
      r2.leaseUntil = new Date(Date.now() + 60000).toISOString();
      run2Id = r2.id;

      deliver(w, "101", "101", "pending notice", { topicId: 0, runId: r1.id });
      audit(w, "101", "test.setup", id);
    });

    // readForGuard omits deliveries and audit and strips heavy transcript/tools in SQL while keeping runAllowed intact.
    const guardWs = await store.readForGuard(id);
    expect(guardWs.deliveries).toEqual([]);
    expect(guardWs.audit).toEqual([]);
    const guardR1 = guardWs.runs.find((r) => r.id === run1Id);
    expect(guardR1).toBeDefined();
    expect(guardR1?.transcript).toEqual([]);
    expect(guardR1?.tools).toEqual({});
    expect(guardR1 ? runAllowed(guardWs, guardR1) : false).toBe(true);

    // renewRunLease surgically updates leaseUntil and rejects stale fences.
    const nextLease = new Date(Date.now() + 120000).toISOString();
    await store.renewRunLease(id, run1Id, 1, nextLease);
    const afterRenew = await store.readForGuard(id);
    expect(afterRenew.runs.find((r) => r.id === run1Id)?.leaseUntil).toBe(
      nextLease,
    );
    await expect(
      store.renewRunLease(id, run1Id, 99, nextLease),
    ).rejects.toThrow("run_revoked");

    // mutateRunRow executes concurrently on two distinct runs in the same workspace without blocking each other.
    let activeMutators = 0;
    let maxConcurrent = 0;
    await Promise.all([
      store.mutateRunRow(id, run1Id, async (_w, run) => {
        activeMutators++;
        maxConcurrent = Math.max(maxConcurrent, activeMutators);
        await new Promise((resolve) => setTimeout(resolve, 40));
        run.tools.callA = { name: "inspect_missions", state: "done" };
        activeMutators--;
      }),
      store.mutateRunRow(id, run2Id, async (_w, run) => {
        activeMutators++;
        maxConcurrent = Math.max(maxConcurrent, activeMutators);
        await new Promise((resolve) => setTimeout(resolve, 40));
        run.tools.callB = { name: "query_github_metadata", state: "done" };
        activeMutators--;
      }),
    ]);
    expect(maxConcurrent).toBe(2);

    const persisted = await store.read(id);
    expect(persisted.runs.find((r) => r.id === run1Id)?.tools.callA?.name).toBe(
      "inspect_missions",
    );
    expect(persisted.runs.find((r) => r.id === run2Id)?.tools.callB?.name).toBe(
      "query_github_metadata",
    );
    // Original heavy transcript and deliveries remain untouched.
    expect(
      persisted.runs.find((r) => r.id === run1Id)?.transcript,
    ).toHaveLength(1);
    expect(persisted.deliveries).toHaveLength(1);

    // Private browser runs stay sealed at rest when mutated via mutateRunRow.
    await store.change(id, (w) => {
      const r1 = w.runs.find((r) => r.id === run1Id);
      if (r1) {
        r1.browserRead = {
          owner: "101",
          botId: "bot-1",
          generation: 1,
          epoch: 1,
        };
      }
    });
    await store.mutateRunRow(id, run1Id, (_w, run) => {
      run.tools.secretTool = {
        name: "browser_action",
        state: "done",
        result: { secret: "sensitive-cookie-value" },
      };
    });
    const rawSealedRow = (
      await pool.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM workspace_runs WHERE workspace_id=$1 AND id=$2",
        [id, run1Id],
      )
    ).rows[0]?.data;
    expect(typeof rawSealedRow?.browserSealed).toBe("string");
    expect(JSON.stringify(rawSealedRow)).not.toContain(
      "sensitive-cookie-value",
    );
    const decoded = await store.read(id);
    expect(
      decoded.runs.find((r) => r.id === run1Id)?.tools.secretTool?.result,
    ).toEqual({ secret: "sensitive-cookie-value" });
  });
});
