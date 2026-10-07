import { requestFailureMessage, stageMessage } from "./messages.ts";

export { requestFailureMessage, runStatus, stageMessage } from "./messages.ts";

import type { Run, Workspace } from "../domain.ts";
import { runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";

export interface Progress {
  key: string;
  stage: string;
  sequence: number;
  changedAt: number;
  observedAt: number;
  notifiedAt?: number;
  delayed?: boolean;
  unavailable?: boolean;
}
interface ProgressTask {
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  progress?: Progress;
}

export function clearProgress(w: Workspace, owner: string, id: string) {
  for (const d of w.deliveries)
    if (
      d.state === "pending" &&
      d.feedback?.owner === owner &&
      d.feedback.id === id
    )
      d.state = "cancelled";
}

/** Called under the task lock, only after a confirmed runner response. */
export function recordProgress(
  w: Workspace,
  task: ProgressTask,
  owner: "coding" | "development",
  stage: string,
  cycle: string,
  now = Date.now(),
) {
  const key = `${cycle}:${stage}`;
  if (task.progress?.key !== key) {
    clearProgress(w, owner, task.id);
    task.progress = {
      key,
      stage,
      sequence: (task.progress?.sequence ?? 0) + 1,
      changedAt: now,
      observedAt: now,
      notifiedAt: task.progress?.notifiedAt,
    };
  }
  const p = task.progress;
  p.observedAt = now;
  p.unavailable = false;
  const initial = !w.deliveries.some(
    (d) => d.id === `${owner}:${task.id}:progress:${p.sequence}`,
  );
  const delayed = !initial && now - p.changedAt >= 120000 && !p.delayed;
  if (
    (!initial && !delayed) ||
    (p.notifiedAt !== undefined && now - p.notifiedAt < 10000)
  )
    return;
  const id = deliver(
    w,
    task.actor,
    task.chatId,
    delayed
      ? `This stage is taking longer. ${stageMessage(stage)} Use /status to check it or /cancel to stop it.`
      : stageMessage(stage),
    {
      topicId: task.topicId,
      id: `${owner}:${task.id}:progress:${p.sequence}${delayed ? ":delay" : ""}`,
    },
  );
  const d = w.deliveries.find((d) => d.id === id);
  if (d) d.feedback = { owner, id: task.id, key };
  p.notifiedAt = now;
  if (delayed) p.delayed = true;
}

export function notifyRunFailure(
  w: Workspace,
  run: Run,
  text = requestFailureMessage(run.error ?? ""),
) {
  if (
    (run.followup && run.followup.decision !== "reply") ||
    !runAllowed(w, run)
  )
    return;
  deliver(w, run.actor, run.chatId, text, {
    topicId: run.topicId,
    replyTo: run.replyTo,
    runId: run.id,
    id: `run:${run.id}:failure`,
  });
}

export function queuedRunFeedback(w: Workspace, now = Date.now()) {
  for (const run of w.runs) {
    if (
      run.status !== "queued" ||
      run.chatId !== run.actor ||
      run.workflowId ||
      run.followup ||
      now - Date.parse(run.at) < 30000 ||
      !runAllowed(w, run)
    )
      continue;
    const id = deliver(
      w,
      run.actor,
      run.chatId,
      "Your request is still queued. Use /status to check it or /cancel to stop it.",
      {
        topicId: run.topicId,
        replyTo: run.replyTo,
        runId: run.id,
        id: `run:${run.id}:queued`,
      },
    );
    const d = w.deliveries.find((d) => d.id === id);
    if (d) d.feedback = { owner: "run", id: run.id, key: "queued" };
  }
}
