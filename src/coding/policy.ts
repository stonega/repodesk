import { randomUUID } from "node:crypto";
import { type Approval, requireThat, type Workspace } from "../domain.ts";
import { authorizeRepository } from "../github/user-access.ts";
import { fingerprint } from "../setup/credentials.ts";
import { clearProgress, deliverTaskProgress } from "../telegram/feedback.ts";
import { taskButtons } from "../telegram/task-buttons.ts";
import {
  audience,
  audit,
  authorize,
  runAllowed,
} from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import {
  type CodingPayload,
  type CodingTask,
  codingInput,
  codingPayload,
  codingTerminal,
} from "./config.ts";
import { reviewedStatus } from "./feedback.ts";

export function codingDestination(
  w: Workspace,
  actor: string,
  value: unknown,
): CodingPayload {
  authorize(w, actor);
  requireThat(
    !w.settings.paused && w.coding?.settings.enabled,
    "coding_disabled",
    409,
  );
  requireThat(
    w.coding.settings.backend === "podman",
    "coding_local_configuration_required",
    409,
  );
  const input = codingInput.parse(value);
  authorizeRepository(w, actor, input.repositoryId, true);
  const target = w.coding.settings.repositories.find(
    (r) => r.repositoryId === input.repositoryId,
  );
  requireThat(target, "coding_maintainer_required", 403);
  requireThat(
    target.maintainers.includes(actor),
    "coding_maintainer_required",
    403,
  );
  const repo = w.github?.repositories.find((r) => r.id === input.repositoryId);
  requireThat(
    repo && w.github?.installationId,
    "github_repository_not_connected",
    409,
  );
  return codingPayload.parse({
    ...input,
    repository: repo.full_name,
    installationId: w.github.installationId,
    githubRevision: w.github.revision,
    configRevision: w.coding.revision,
    baseBranch: target.baseBranch,
    backend: "podman",
    authMode: w.coding.settings.authMode ?? "provider_key",
  });
}
export function checkCodingPayload(
  w: Workspace,
  actor: string,
  payload: CodingPayload,
) {
  const { repositoryId, title, body } = payload;
  requireThat(
    fingerprint(codingDestination(w, actor, { repositoryId, title, body })) ===
      fingerprint(payload),
    "coding_configuration_changed",
    409,
  );
}
export function proposeCoding(
  w: Workspace,
  actor: string,
  runId: string,
  callId: string,
  value: unknown,
) {
  const payload = codingDestination(w, actor, value);
  const run = w.runs.find((r) => r.id === runId);
  requireThat(
    run &&
      run.actor === actor &&
      run.status === "running" &&
      runAllowed(w, run),
    "run_revoked",
    409,
  );
  const target = `${runId}:${callId}`;
  const prior = w.approvals.find(
    (a) => a.kind === "coding_task" && a.target === target,
  );
  if (prior) {
    requireThat(
      prior.actor === actor && prior.hash === fingerprint(payload),
      "approval_changed",
      409,
    );
    return prior;
  }
  requireThat(
    !w.approvals.some(
      (a) =>
        a.actor === actor &&
        !a.decision &&
        Date.parse(a.expiresAt) > Date.now(),
    ),
    "resolve_existing_proposal_first",
    409,
  );
  const approval: Approval = {
    id: randomUUID(),
    actor,
    runId,
    kind: "coding_task",
    target,
    version: payload.configRevision,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  w.approvals.push(approval);
  deliver(
    w,
    actor,
    run.chatId,
    `Start Codex implementation in ${payload.repository}?\nBase branch: ${payload.baseBranch}\nRunner: local Podman\n\nTitle: ${payload.title}\n\n${payload.body}\n\nApprove to create this issue, run Codex in an isolated local container, push a task branch and open a draft PR referencing the issue. Coding provider usage is billed separately from chat usage.`,
    {
      runId,
      topicId: run.topicId,
      id: `coding:${approval.id}:review`,
      buttons: [
        [
          { text: "Approve", callback_data: `approve:${approval.id}` },
          { text: "Reject", callback_data: `reject:${approval.id}` },
        ],
      ],
    },
  );
  audit(w, actor, "coding.proposed", approval.id);
  return approval;
}
export function approveCoding(w: Workspace, approval: Approval) {
  const payload = codingPayload.parse(approval.payload);
  checkCodingPayload(w, approval.actor, payload);
  const run = w.runs.find((r) => r.id === approval.runId);
  requireThat(
    run && run.actor === approval.actor && runAllowed(w, run),
    "run_revoked",
    409,
  );
  w.codingTasks ??= [];
  requireThat(
    w.codingTasks.length < 200 &&
      w.codingTasks.filter((t) => !codingTerminal(t.state)).length < 10,
    "coding_capacity_reached",
    429,
  );
  const at = new Date().toISOString();
  w.codingTasks.push({
    id: approval.id,
    actor: approval.actor,
    runId: run.id,
    chatId: run.chatId,
    topicId: run.topicId,
    payload,
    state: "queued",
    createdAt: at,
    updatedAt: at,
  });
  audit(w, approval.actor, "coding.queued", approval.id);
  notifyCoding(w, w.codingTasks.at(-1) as CodingTask);
}
export function checkCodingTask(w: Workspace, task: CodingTask) {
  checkCodingPayload(w, task.actor, task.payload);
  audience(w, task.actor, task.chatId);
  const run = w.runs.find((r) => r.id === task.runId);
  requireThat(
    run && runAllowed(w, run) && !task.cancelRequested,
    "coding_cancelled",
    409,
  );
}
export function cancelCoding(w: Workspace, actor: string, id: string) {
  authorize(w, actor);
  const task = w.codingTasks?.find((t) => t.id === id);
  requireThat(task, "not_found", 404);
  // Initiators may stop their task even after a maintainer grant is removed.
  requireThat(
    task.actor === actor ||
      w.coding?.settings.repositories.some(
        (r) =>
          r.repositoryId === task.payload.repositoryId &&
          r.maintainers.includes(actor),
      ),
    "coding_maintainer_required",
    403,
  );
  if (codingTerminal(task.state) || task.cancelRequested) return task;
  task.cancelRequested = true;
  clearProgress(w, "coding", task.id);
  if (
    ["queued", "issue_created"].includes(task.state) ||
    (task.state === "auth_required" && task.authResumeState !== "running")
  )
    task.state = "cancelled";
  deliver(
    w,
    task.actor,
    task.chatId,
    task.state === "cancelled"
      ? "Your task has stopped. Messages already sent cannot be undone."
      : "Stopping your task… Any GitHub operation already underway may finish.",
    {
      topicId: task.topicId,
      id: `coding:${task.id}:cancel:${task.state === "cancelled" ? "stopped" : "requested"}`,
    },
  );
  audit(w, actor, "coding.cancel_requested", id);
  return task;
}
export function notifyCoding(w: Workspace, task: CodingTask) {
  try {
    audience(w, task.actor, task.chatId);
  } catch {
    return;
  }
  if (w.settings.paused) return;
  if (!["running", "publishing"].includes(task.state))
    clearProgress(w, "coding", task.id);
  const text = reviewedStatus(task);
  const options = {
    topicId: task.topicId,
    buttons:
      !codingTerminal(task.state) && !task.cancelRequested
        ? taskButtons("coding", task.id)
        : undefined,
    id:
      task.state === "cancelled"
        ? `coding:${task.id}:cancel:stopped`
        : `coding:${task.id}:${task.state}:${task.workflowRunId ?? ""}:${task.authPauses ?? 0}`,
  };
  const routine = ["queued", "running", "publishing"].includes(task.state);
  if (!routine)
    deliverTaskProgress(w, task, "coding", text, {
      id: `coding:${task.id}:progress:${task.state}:${task.workflowRunId ?? ""}:${task.authPauses ?? 0}`,
      editOnly: true,
    });
  const id = routine
    ? deliverTaskProgress(w, task, "coding", text, options)
    : deliver(w, task.actor, task.chatId, text, options);
  if (task.state === "queued") {
    const d = w.deliveries.find((d) => d.id === id);
    if (d) d.feedback = { owner: "coding", id: task.id, key: "queued" };
  }
}
