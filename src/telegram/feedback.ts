import {
  ongoingStageMessage,
  requestFailureMessage,
  stageMessage,
} from "./messages.ts";
import { pullRequestButtons, taskButtons } from "./task-buttons.ts";

export { requestFailureMessage, runStatus, stageMessage } from "./messages.ts";

import type { Delivery, Run, Workspace } from "../domain.ts";
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
  pr?: { url: string };
  prUrl?: string;
}

/** Reuse a confirmed message, or wait for its in-flight send to be reconciled. */
export function deliverTaskProgress(
  w: Workspace,
  task: ProgressTask,
  owner: "coding" | "development",
  text: string,
  options: { id: string; buttons?: Delivery["buttons"]; editOnly?: boolean },
) {
  if (w.deliveries.some((d) => d.id === options.id)) return options.id;
  const belongs = (d: Delivery) =>
    d.actor === task.actor &&
    d.chatId === task.chatId &&
    d.topicId === task.topicId &&
    (d.progressMessage ?? d.feedback)?.owner === owner &&
    (d.progressMessage ?? d.feedback)?.id === task.id;
  for (const d of w.deliveries)
    if (belongs(d) && d.state === "pending") d.state = "cancelled";
  const previous = w.deliveries.findLast(
    (d) =>
      belongs(d) &&
      !d.editUnavailable &&
      !w.deliveries.find((target) => target.id === d.editOf)?.editUnavailable &&
      ["sent", "sending", "delivery_unknown"].includes(d.state),
  );
  if (!previous && options.editOnly) return;
  const id = deliver(w, task.actor, task.chatId, text, {
    topicId: task.topicId,
    id: options.id,
    buttons: options.buttons,
  });
  const d = w.deliveries.find((d) => d.id === id);
  if (d) {
    d.progressMessage = { owner, id: task.id };
    // Retention may remove the original intent while a later edit still carries
    // the confirmed message ID. That later record is a valid anchor.
    d.editOf =
      previous?.editOf && w.deliveries.some((t) => t.id === previous.editOf)
        ? previous.editOf
        : previous?.id;
  }
  return id;
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
  const id = deliverTaskProgress(
    w,
    task,
    owner,
    delayed ? ongoingStageMessage(stage) : stageMessage(stage),
    {
      id: `${owner}:${task.id}:progress:${p.sequence}${delayed ? ":delay" : ""}`,
      buttons:
        pullRequestButtons(task.pr?.url ?? task.prUrl) ??
        taskButtons(owner, task.id),
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
      "Your request is still queued. I’ll let you know when it starts.",
      {
        topicId: run.topicId,
        replyTo: run.replyTo,
        runId: run.id,
        id: `run:${run.id}:queued`,
        buttons: taskButtons("run", run.id),
      },
    );
    const d = w.deliveries.find((d) => d.id === id);
    if (d) d.feedback = { owner: "run", id: run.id, key: "queued" };
  }
}
