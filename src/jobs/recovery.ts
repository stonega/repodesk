import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import type { Store } from "../db/repositories.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { notifyRunFailure } from "../telegram/feedback.ts";
import { audit, authorize } from "../workspaces/policy.ts";
import { visibleRuns } from "../workspaces/service.ts";
export async function recoverJobs(store: Store, boss: PgBoss) {
  const deployment = await store.deployment();
  if (!deployment.active || deployment.paused) return;
  const rows = await store.pool.query(
    "SELECT id,workspace_id,target_id FROM outbox WHERE kind='run' AND dispatched_at IS NOT NULL",
  );
  for (const row of rows.rows) {
    const w = await store.read(row.workspace_id);
    const r = w.runs.find((r) => r.id === row.target_id);
    if (!r || !["queued", "running"].includes(r.status)) continue;
    if (r.status === "running" && Date.parse(r.leaseUntil ?? "") > Date.now())
      continue;
    const job = await boss.getJobById("run", row.id);
    if (job && ["created", "retry", "active"].includes(job.state)) continue;
    await store.change(w.id, async (current, sql) => {
      const run = current.runs.find((r) => r.id === row.target_id);
      if (!run || !["queued", "running"].includes(run.status)) return;
      if (job?.state === "failed" && run.status === "queued") {
        run.status = "failed";
        run.error = "queue_retries_exhausted";
        run.finishedAt = new Date().toISOString();
        notifyRunFailure(current, run);
        audit(current, "worker", "run.queue_failed", run.id);
      } else
        await sql.query(
          "UPDATE outbox SET dispatched_at=NULL,id=$2 WHERE id=$1",
          [row.id, randomUUID()],
        );
    });
  }
}
export function reconcileCharge(
  w: Workspace,
  actor: string,
  runId: string,
  attemptId: string,
  actualUsd: number,
  reference: string,
) {
  authorize(w, actor, true);
  const run = visibleRuns(w, actor).find((r) => r.id === runId);
  requireThat(run, "not_found", 404);
  const attempt = run.attempts.find((a) => a.id === attemptId);
  requireThat(attempt?.status === "unknown", "charge_not_reconcilable", 409);
  requireThat(
    Number.isFinite(actualUsd) &&
      actualUsd >= 0 &&
      actualUsd <= 100 &&
      reference.trim().length >= 3,
    "invalid_reconciliation",
  );
  attempt.actual = actualUsd;
  attempt.reconciliation = { actor, reference, at: new Date().toISOString() };
  attempt.status = "settled";
  audit(w, actor, "usage.reconciled", `${runId}:${attemptId}`);
}
export function resolveDelivery(
  w: Workspace,
  actor: string,
  id: string,
  action: "confirm_sent" | "abandon",
  remoteId?: number,
) {
  authorize(w, actor, true);
  const d = w.deliveries.find((d) => d.id === id);
  requireThat(
    d &&
      (d.actor === actor || w.chats.some((c) => c.id === d.chatId && c.active)),
    "not_found",
    404,
  );
  requireThat(d.state === "delivery_unknown", "delivery_not_ambiguous", 409);
  if (action === "confirm_sent") {
    requireThat(
      remoteId && Number.isSafeInteger(remoteId) && remoteId > 0,
      "remote_message_id_required",
    );
    d.state = "sent";
    d.remoteId = remoteId;
  } else d.state = "failed";
  audit(w, actor, `delivery.${action}`, id);
}
