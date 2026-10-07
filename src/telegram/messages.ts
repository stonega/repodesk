import type { Run } from "../domain.ts";

const stages: Record<string, string> = {
  queued: "Your task is queued.",
  prepare: "I’m preparing the repository.",
  setup: "I’m preparing the repository environment.",
  intake: "I’m investigating your request.",
  analysis: "I’m investigating your question.",
  implement: "I’m implementing the change.",
  check: "The changes are ready for checks. I’m running them now.",
  repair: "A check failed. I’m working on a repair before publishing.",
  publish: "The recorded checks passed. I’m opening or updating your draft PR.",
};
export const stageMessage = (stage: string) =>
  stages[stage] ?? "Your task is running.";

const failures: Record<string, string> = {
  empty_response:
    "The model returned no answer. Try a clearer request; ask the administrator to check the model if this happens again.",
  incomplete_response:
    "The model did not finish its answer. Try narrowing the request; ask the administrator to inspect it if this happens again.",
  worker_shutdown:
    "The server interrupted this request during a restart. Ask the administrator to inspect its outcome before trying again.",
  invalid_command_arguments:
    "I couldn’t understand those command arguments. Use /help to check the command format.",
  not_found:
    "I couldn’t find an accessible task or request. Use /status in its conversation.",
  access_denied:
    "This action is not available with your current access. Ask the workspace administrator to review your access.",
  run_timeout:
    "I couldn’t finish before the request timed out. You can send a smaller request or ask the administrator to review the timeout.",
  turn_limit:
    "I couldn’t finish this response within the available turns. Try narrowing the request.",
  output_limit:
    "I couldn’t finish this response within the available output. Try asking for a smaller part.",
  provider_outcome_unknown:
    "I couldn’t confirm the model request’s outcome. Ask the administrator to inspect the request and provider usage before retrying.",
  queue_retries_exhausted:
    "Your request could not start after repeated queue failures. Ask the administrator to check the worker before trying again.",
  extension_configuration_invalid:
    "A required plugin could not load. Ask the administrator to check the plugin configuration.",
  extension_configuration_changed:
    "The plugin configuration changed during this request. Ask the administrator to check the configuration before trying again.",
  incomplete_tool_checkpoint:
    "This request could not safely resume after an interruption. Ask the administrator to inspect its recorded tool outcomes.",
  run_budget_exhausted:
    "This request reached its model spending budget. Ask the administrator to review the budget or try a smaller request.",
  workspace_budget_exhausted:
    "The workspace model spending budget has been reached. Ask the administrator to review it.",
  model_endpoint_changed:
    "The model connection changed during this request. Ask the administrator to check it before trying again.",
};
export const requestFailureMessage = (code: string) =>
  failures[code] ??
  "I couldn’t finish this request. Ask the workspace administrator to inspect it in the panel.";

const runLabels: Record<Run["status"], string> = {
  queued: "Queued",
  running: "Working on your request",
  awaiting_approval: "Waiting for your approval",
  succeeded: "Completed",
  partial: "Response incomplete",
  failed: "Could not complete",
  cancelled: "Cancelled",
};
export function runStatus(run: Run) {
  if (run.codingTaskId)
    return `Handed to Codex. Check task updates in this conversation.\nTask reference: ${run.codingTaskId}\nRequest reference: ${run.id}`;
  const label =
    run.cancelled &&
    !run.stopConfirmed &&
    Date.parse(run.leaseUntil ?? "") > Date.now()
      ? "Stopping your request"
      : runLabels[run.status];
  return `${label}${run.error && run.status === "failed" ? ` — ${requestFailureMessage(run.error)}` : ""}\nReference: ${run.id}`;
}
