import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import type { AgentRunner, RunnerProvider } from "../agent/runtime.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { pruneRuntimeLogs, RuntimeLogger } from "../observability/logs.ts";
import { sweep } from "../privacy/service.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramPoller } from "../telegram/polling.ts";
import { tick } from "../workflows/service.ts";
import { deliverAccessHelp } from "./control.ts";
import { DeliveryWorker } from "./delivery.ts";
import { Executor } from "./execute.ts";
import { recoverJobs } from "./recovery.ts";
export interface JobData {
  workspaceId: string;
  targetId: string;
}
export function queue(
  url: string,
  log = new RuntimeLogger(undefined, "worker"),
) {
  const boss = new PgBoss({ connectionString: url, migrate: false });
  boss.on("error", (error) => {
    log.write("queue_error", { error });
  });
  return boss;
}
export async function dispatch(store: Store, boss: PgBoss) {
  return transaction(store.pool, async (sql) => {
    const rows = await sql.query(
      "SELECT id,kind,workspace_id,target_id FROM outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
    );
    for (const row of rows.rows) {
      // pg-boss uses this exact connection; enqueue and outbox acknowledgement commit together.
      await boss.send(
        row.kind,
        { workspaceId: row.workspace_id, targetId: row.target_id },
        {
          id: row.id,
          db: { executeSql: (text, values) => sql.query(text, values) },
        },
      );
      await sql.query("UPDATE outbox SET dispatched_at=now() WHERE id=$1", [
        row.id,
      ]);
    }
    return rows.rowCount;
  });
}
export async function startWorker(
  store: Store,
  setup: SetupService,
  url: string,
  runner?: AgentRunner | RunnerProvider,
) {
  const boss = queue(url, store.log);
  await boss.start();
  const executor = new Executor(store, setup, runner);
  const delivery = new DeliveryWorker(store, setup);
  const shutdown = new AbortController();
  const id = randomUUID();
  await boss.work<JobData>(
    "run",
    { localConcurrency: 3, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs)
        await executor.execute(
          job.data.workspaceId,
          job.data.targetId,
          shutdown.signal,
        );
    },
  );
  await boss.work<JobData>(
    "delivery",
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs)
        await delivery.send(job.data.workspaceId, job.data.targetId);
    },
  );
  let busy = false;
  let lastLogCleanup = 0;
  const maintain = async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastLogCleanup > 60000) {
        lastLogCleanup = Date.now();
        try {
          await pruneRuntimeLogs(store.pool);
        } catch {
          store.log.write("log_storage_unavailable");
        }
      }
      const d = await store.deployment();
      for (const workspaceId of await store.ids()) {
        await store.change(workspaceId, async (w, sql) => {
          sweep(w);
          if (w.deletion) {
            await sql.query(
              "DELETE FROM github_app_flows WHERE workspace_id=$1",
              [w.id],
            );
            await sql.query("DELETE FROM github_flows WHERE workspace_id=$1", [
              w.id,
            ]);
            await sql.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
              w.id,
            ]);
            await sql.query("DELETE FROM outbox WHERE workspace_id=$1", [w.id]);
            await sql.query("DELETE FROM inbox WHERE workspace_id=$1", [w.id]);
            await sql.query("DELETE FROM runtime_logs WHERE workspace_id=$1", [
              w.id,
            ]);
            return;
          }
          if (d.active && !d.paused) tick(w, d.model);
        });
        // Durable rate-limit retries and ambiguous-send detection do not rely on queue retry timing.
        const current = await store.read(workspaceId);
        for (const intent of current.deliveries)
          if (
            (intent.state === "pending" &&
              (!intent.nextAt || Date.parse(intent.nextAt) <= Date.now())) ||
            (intent.state === "sending" &&
              Date.parse(intent.startedAt ?? "") + 30000 < Date.now())
          )
            await delivery.send(workspaceId, intent.id);
      }
      await deliverAccessHelp(store, setup);
      await recoverJobs(store, boss);
      await dispatch(store, boss);
      await store.pool.query(
        "INSERT INTO worker_heartbeats(id,at) VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET at=now()",
        [id],
      );
      await store.pool.query(
        "DELETE FROM github_flows WHERE expires_at<=now()",
      );
      await store.pool.query(
        "DELETE FROM github_app_flows WHERE expires_at<=now()",
      );
      await store.pool.query("DELETE FROM sessions WHERE expires_at<now()");
      await store.pool.query("DELETE FROM auth_limits WHERE expires_at<now()");
      await store.pool.query(
        "DELETE FROM inbox WHERE accepted_at<now()-interval '30 days'",
      );
    } catch (error) {
      store.log.write("worker_maintenance_failed", { error });
    } finally {
      busy = false;
    }
  };
  await maintain();
  const polling =
    setup.telegramTransport === "polling"
      ? new TelegramPoller(store, setup).run(shutdown.signal)
      : Promise.resolve();
  // Observe unexpected infrastructure failures immediately; normal poll failures retry in the loop.
  void polling.catch((error) =>
    store.log.write("telegram_polling_stopped", { error }),
  );
  const timer = setInterval(() => void maintain(), 5000);
  return async () => {
    clearInterval(timer);
    shutdown.abort();
    await Promise.all([polling, boss.stop({ graceful: true, timeout: 10000 })]);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 25));
    await store.pool.query("DELETE FROM worker_heartbeats WHERE id=$1", [id]);
  };
}
