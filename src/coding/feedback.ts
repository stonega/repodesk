import { stageMessage } from "../telegram/messages.ts";
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
  progress?: DevelopmentTask["progress"];
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
  progress?: DevelopmentTask["progress"];
  phase?: string;
  pr?: unknown;
  error?: string;
}) {
  if (
    ["working", "running", "publishing", "queued", "auth_required"].includes(
      task.state,
    ) &&
    task.cancelRequested
  )
    return "Stopping";
  if (
    task.error === "github_user_access_unavailable" &&
    !["review", "failed", "cancelled", "unknown"].includes(task.state)
  )
    return "Waiting for GitHub access verification";
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
      publish: "Publishing PR",
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
          ? "PR ready for review"
          : "Ready for review",
    publishing: "Publishing PR",
    failed: "Could not complete",
    cancelled: "Stopped",
    unknown: "Outcome uncertain",
  };
  return labels[task.state] ?? "Status unavailable";
}

function active(task: {
  progress?: DevelopmentTask["progress"];
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
  if (task.error === "github_user_access_unavailable" && !task.cancelRequested)
    return `${task.payload.repository}: ${codingFailureMessage(task.error, task.payload)}${task.pr ? `\n${task.pr.url}` : ""}`;
  const labels: Record<DevelopmentTask["state"], string> = {
    queued: stageMessage("queued"),
    working: active(task),
    waiting: `I need your input before we can continue.\n${task.question?.text ?? "What outcome would you like?"}`,
    auth_required: codingFailureMessage("coding_device_auth_required"),
    publishing:
      task.progress?.unavailable || task.cancelRequested
        ? active(task)
        : stageMessage("publish"),
    review:
      task.phase === "analysis" || task.result?.status === "analysis"
        ? "I’ve finished looking into it."
        : task.pr
          ? "Your PR is ready for review."
          : "The recorded checks passed. Publication has not been requested.",
    failed: codingFailureMessage(task.error ?? "", task.payload),
    cancelled:
      task.error === "github_user_access_denied"
        ? codingFailureMessage(task.error, task.payload)
        : "Your task has stopped.",
    unknown:
      task.progress?.stage === "publish" ? publicationUnknown : taskUnknown,
  };
  return `${task.payload.repository}: ${labels[task.state]}${task.pr ? `\n${task.pr.url}` : ""}`;
}
