import { stageMessage } from "../telegram/messages.ts";
import type { CodingTask } from "./config.ts";
import type { DevelopmentTask } from "./development.ts";
import { codingFailureMessage } from "./failure-messages.ts";
import type { LocalStatus } from "./local/protocol.ts";

export function runnerStage(status: LocalStatus, mode = "work") {
  if (status.phase === "implement")
    return mode === "intake" || mode === "analysis"
      ? mode
      : (status.repairCount ?? 0) > 0
        ? "repair"
        : "implement";
  return status.phase ?? (status.state === "preparing" ? "prepare" : "running");
}

export const publicationUnknown =
  "I couldn’t confirm whether GitHub accepted the update. An administrator needs to check GitHub before another attempt. It will not be repeated automatically.";
export const taskUnknown =
  "I couldn’t confirm this task’s outcome. Ask the workspace administrator to inspect the recorded state before another attempt. It will not be repeated automatically.";

export function markRunnerUnavailable(task: {
  progress?: CodingTask["progress"];
}) {
  task.progress ??= {
    key: "unavailable",
    stage: "running",
    sequence: 0,
    observedAt: 0,
    changedAt: Date.now(),
  };
  task.progress.unavailable = true;
}

export function codingStatusLabel(task: {
  state: string;
  cancelRequested?: boolean;
  progress?: CodingTask["progress"];
  phase?: string;
  pr?: unknown;
  prUrl?: string;
}) {
  if (
    [
      "working",
      "running",
      "publishing",
      "dispatching",
      "queued",
      "auth_required",
    ].includes(task.state) &&
    task.cancelRequested
  )
    return "Stopping";
  if (["working", "running"].includes(task.state)) {
    if (
      task.progress?.unavailable ||
      (task.progress && Date.now() - task.progress.observedAt > 60000)
    )
      return "Runner status unavailable";
    const labels: Record<string, string> = {
      prepare: "Preparing repository",
      setup: "Preparing environment",
      intake: "Investigating request",
      analysis: "Investigating question",
      implement: "Implementing",
      repair: "Repairing failed checks",
      check: "Running checks",
      publish: "Publishing draft PR",
    };
    return (
      labels[task.progress?.stage ?? ""] ?? "Waiting for runner confirmation"
    );
  }
  const labels: Record<string, string> = {
    queued: "Queued",
    waiting: "Waiting for your answer",
    auth_required: "Waiting for sign-in",
    review:
      task.phase === "analysis"
        ? "Investigation complete"
        : task.pr
          ? "Draft PR published"
          : "Ready for review",
    creating_issue: "Creating approved issue",
    issue_created: "Waiting for runner",
    dispatching: "Starting runner",
    starting_publication: "Preparing publication",
    publishing: "Publishing draft PR",
    succeeded: "Draft PR ready",
    failed: "Could not complete",
    cancelled: "Stopped",
    unknown: "Outcome uncertain",
  };
  return labels[task.state] ?? "Status unavailable";
}

function active(task: {
  progress?: CodingTask["progress"];
  cancelRequested?: boolean;
}) {
  if (task.cancelRequested) return "Stopping your task…";
  if (
    task.progress?.unavailable ||
    (task.progress && Date.now() - task.progress.observedAt > 60000)
  )
    return `The runner’s current status is unavailable. Last confirmed stage: ${stageMessage(task.progress?.stage ?? "running")}`;
  return task.progress
    ? stageMessage(task.progress.stage)
    : "Waiting for the runner to confirm the current stage.";
}
export function developmentStatus(task: DevelopmentTask) {
  const labels: Record<DevelopmentTask["state"], string> = {
    queued: "Your task is queued.",
    working: active(task),
    waiting: `Waiting for your answer.\n${task.question?.text ?? "Reply with the outcome you want."}`,
    auth_required: codingFailureMessage("coding_device_auth_required"),
    publishing:
      task.progress?.unavailable || task.cancelRequested
        ? active(task)
        : stageMessage("publish"),
    review:
      task.phase === "analysis" || task.result?.status === "analysis"
        ? "The investigation is complete."
        : task.pr
          ? "A draft PR was published for this task."
          : "The recorded checks passed. Publication has not been requested.",
    failed: codingFailureMessage(task.error ?? ""),
    cancelled: "Your task has stopped.",
    unknown:
      task.progress?.stage === "publish" ? publicationUnknown : taskUnknown,
  };
  return `${task.payload.repository}: ${labels[task.state]}${task.pr ? `\n${task.pr.url}` : ""}`;
}
export function reviewedStatus(task: CodingTask) {
  const labels: Record<CodingTask["state"], string> = {
    queued: "Your coding request is queued.",
    creating_issue: "I’m creating the approved issue.",
    issue_created:
      "The approved issue is ready. Waiting for the coding runner.",
    dispatching: "I’m starting the coding runner.",
    running: active(task),
    starting_publication:
      "The recorded checks passed. Preparing draft PR publication.",
    publishing:
      task.progress?.unavailable || task.cancelRequested
        ? active(task)
        : stageMessage("publish"),
    succeeded: "The recorded checks passed. Your draft PR is ready.",
    failed: codingFailureMessage(task.error ?? ""),
    cancelled: "Your task has stopped.",
    unknown:
      task.progress?.stage === "publish" ? publicationUnknown : taskUnknown,
    auth_required: codingFailureMessage("coding_device_auth_required"),
  };
  return `${task.payload.repository}: ${task.cancelRequested && !["succeeded", "unknown", "failed", "cancelled"].includes(task.state) ? active(task) : labels[task.state]}${task.issue ? `\nIssue: ${task.issue.url}` : ""}${task.prUrl ? `\n${task.prUrl}` : ""}`;
}
