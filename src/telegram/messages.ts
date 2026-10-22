import type { Run } from "../domain.ts";

const stages: Record<string, string> = {
  queued: "Got it — your task is queued. I’ll keep you posted.",
  prepare: "I’m getting the repository ready.",
  setup: "I’m getting the repository environment ready.",
  intake: "I’m taking a closer look at your request.",
  analysis: "I’m looking into your question.",
  implement: "I’m working on the changes.",
  check: "I’m running the checks now.",
  repair: "A check caught a problem. I’m working on the fix.",
  recover:
    "The server interrupted your task. I’m restoring its saved workspace so it can continue.",
  publish: "The checks passed. I’m opening or updating your PR.",
};
export const stageMessage = (stage: string) =>
  stages[stage] ?? "I’m working on your task.";

const ongoingStages: Record<string, string> = {
  prepare: "I’m still getting the repository ready.",
  setup: "I’m still getting the environment ready.",
  intake: "I’m still looking into your request.",
  analysis: "I’m still looking into your question.",
  implement: "I’m still working on the changes.",
  check:
    "The checks are still running. I’ll share the result when they finish.",
  repair: "I’m still working on the failed check.",
  recover: "Your saved work is retained. I’m still waiting to resume the task.",
  publish: "I’m waiting for confirmation from GitHub about your PR.",
};
export const ongoingStageMessage = (stage: string) =>
  ongoingStages[stage] ?? "I’m still on it. I’ll keep you posted.";

const failures: Record<string, string> = {
  google_not_configured:
    "Google is not enabled or configured for this workspace. Ask the administrator to configure Plugins → Google in the panel.",
  google_not_connected:
    "Connect your own Google account with /google in this private chat, complete sign-in, confirm the account here, then retry.",
  google_reconnect_required:
    "Your Google connection needs sign-in again. Send /google connect in this private chat, complete sign-in and confirm the account here, then retry.",
  google_refresh_pending:
    "Your Google connection is refreshing. Try again shortly; if it remains unavailable, send /google connect.",
  google_authorization_expired:
    "This Google connection request expired or changed. Send /google connect to start again.",
  google_properties_expired:
    "This Search Console selection expired or changed. Send /google properties to open it again.",
  google_property_limit:
    "Select at most 20 Search Console properties. Deselect one before adding another.",
  google_connection_changed:
    "Your Google connection changed. Send /google to check its status, then retry.",
  search_console_property_denied:
    "That Search Console property is not available in your current selection. Send /google properties to check your access and selection.",
  use_private_chat: "Open the bot’s private chat to manage your account.",
  repository_menu_expired:
    "This repository menu has expired or access changed. Send /repos to open the current choices.",
  empty_response:
    "I didn’t get an answer back from the model. Your administrator can check the model connection if this keeps happening.",
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
  tool_limit:
    "This request was stopped by a tool-call limit. Ask the workspace administrator to inspect the request before trying again.",
  model_pricing_required_for_budget:
    "This model has no known token prices, so the configured dollar budget cannot be enforced. Ask the workspace administrator to enter prices in Model settings or clear the workspace dollar budget.",
  unpriced_usage_requires_reconciliation:
    "Earlier model calls have unknown costs, so the configured dollar budget cannot be enforced. Ask the workspace administrator to reconcile those charges or clear the dollar budget.",
  output_limit:
    "I couldn’t finish this response within the available output. Try asking for a smaller part.",
  provider_outcome_unknown:
    "I couldn’t confirm the model request’s outcome. Ask the administrator to inspect the request and provider usage before retrying.",
  queue_retries_exhausted:
    "I couldn’t get your request started after several attempts. Your administrator can check the worker before you try again.",
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
  "I hit a snag and couldn’t finish this request. Your workspace administrator can check the details in the panel.";

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
