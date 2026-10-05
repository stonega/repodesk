import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import type { AgentRunner, RunnerProvider } from "../agent/runtime.ts";
import type { CodingService } from "../coding/service.ts";
import { pruneDevelopment } from "../coding/tasks.ts";
import { DEFAULT_RUN_TIMEOUT_SECONDS } from "../config.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import type { GitHubIssues } from "../github/issues.ts";
import type { GitHubUsers } from "../github/users.ts";
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
export async function dispatch(
  store: Store,
  boss: PgBoss,
  runTimeoutSeconds = DEFAULT_RUN_TIMEOUT_SECONDS,
) {
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
          ...(row.kind === "run"
            ? { expireInSeconds: runTimeoutSeconds + 60 }
            : {}),
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
  runTimeoutSeconds = DEFAULT_RUN_TIMEOUT_SECONDS,
  githubIssues?: GitHubIssues,
  coding?: CodingService,
  githubUsers?: GitHubUsers,
) {
  const boss = queue(url, store.log);
  await boss.start();
  const executor = new Executor(store, setup, runner, runTimeoutSeconds * 1000);
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
          await pruneDevelopment(sql, w);
          if (w.deletion) {
            await sql.query(
              "DELETE FROM github_user_flows WHERE workspace_id=$1",
              [w.id],
            );
            await sql.query(
              "DELETE FROM github_user_accounts WHERE workspace_id=$1",
              [w.id],
            );
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
        if (
          coding &&
          current.deletion &&
          !current.deletion.deviceAuthPurgedAt
        ) {
          try {
            if (await coding.purgeDeletedWorkspaceAuth(workspaceId))
              await store.change(workspaceId, (w) => {
                if (w.deletion)
                  w.deletion.deviceAuthPurgedAt = new Date().toISOString();
              });
          } catch (error) {
            store.log.write("worker_maintenance_failed", {
              workspaceId,
              error,
            });
          }
        }
        if (githubIssues && d.active && !d.paused)
          for (const approval of current.approvals)
            if (
              approval.kind === "github_issue" &&
              approval.decision === "approved" &&
              (!approval.issue || approval.issue.state === "sending")
            )
              await githubIssues.send(workspaceId, approval.id);
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
      await dispatch(store, boss, runTimeoutSeconds);
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
      ? new TelegramPoller(store, setup, githubUsers).run(shutdown.signal)
      : Promise.resolve();
  // Observe unexpected infrastructure failures immediately; normal poll failures retry in the loop.
  void polling.catch((error) =>
    store.log.write("telegram_polling_stopped", { error }),
  );
  // Remote coding runs must not block polling, scheduling or worker heartbeats.
  let codingBusy: Promise<void> | undefined;
  const codingTick = () => {
    if (!coding || codingBusy || shutdown.signal.aborted) return;
    codingBusy = (async () => {
      for (const workspaceId of await store.ids()) {
        if (shutdown.signal.aborted) break;
        await coding.tick(workspaceId);
      }
    })()
      .catch((error) => store.log.write("worker_maintenance_failed", { error }))
      .finally(() => {
        codingBusy = undefined;
      });
  };
  let githubBusy: Promise<void> | undefined;
  const githubTick = () => {
    if (!githubUsers || githubBusy || shutdown.signal.aborted) return;
    githubBusy = githubUsers
      .syncDue()
      .catch(() => store.log.write("worker_maintenance_failed"))
      .finally(() => {
        githubBusy = undefined;
      });
  };
  githubTick();
  const githubTimer = setInterval(githubTick, 30000);
  codingTick();
  const codingTimer = setInterval(codingTick, 5000);
  const timer = setInterval(() => void maintain(), 5000);
  return async () => {
    clearInterval(timer);
    clearInterval(codingTimer);
    clearInterval(githubTimer);
    shutdown.abort();
    await Promise.all([polling, boss.stop({ graceful: true, timeout: 10000 })]);
    await Promise.all([codingBusy, githubBusy]);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 25));
    await store.pool.query("DELETE FROM worker_heartbeats WHERE id=$1", [id]);
  };
}
