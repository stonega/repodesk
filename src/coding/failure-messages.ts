import { attachmentErrors } from "../telegram/attachments.ts";
import type { CodingPayload } from "./config.ts";

const messages: Record<string, string> = {
  github_user_access_unavailable:
    "GitHub access could not be verified. RepoDesk will retry automatically; new execution and PR publication wait until access is verified.",
  github_user_access_denied:
    "The linked GitHub account does not have the required repository access. Run /github sync in your private bot chat, or reconnect with /github connect. Start a new request after access is restored.",
  coding_conversation_failed:
    "Codex could not complete the conversation. Ask the workspace administrator to inspect the task before trying again.",
  coding_codex_failed: "The Codex process stopped before completing the task.",
  coding_provider_request_invalid: "Your Codex provider rejected the request.",
  coding_context_exceeded:
    "The Codex conversation exceeded the provider's context capacity.",
  coding_sandbox_failed:
    "Codex could not run a command in its execution environment.",
  coding_result_missing: "Codex finished without returning a task result.",
  coding_result_json_invalid: "Codex returned an unreadable task result.",
  coding_result_invalid:
    "Codex returned an incomplete task result or verification plan.",
  coding_runner_not_configured:
    "The coding runner is not configured. Ask the workspace administrator to connect it.",
  coding_runner_unavailable:
    "The coding runner is unavailable. Ask the workspace administrator to check its connection.",
  coding_runner_request_failed:
    "The coding runner could not be reached. Ask the workspace administrator to check its connection.",
  coding_execution_failed:
    "The coding task could not finish. Ask the workspace administrator to inspect it in the panel.",
  coding_base_branch_missing:
    "The configured base branch does not exist in the repository. Ask the workspace administrator to update the base branch in Plugins → Codex → Repositories, then start a new request.",
  coding_checkout_failed:
    "The repository could not be checked out, so Codex did not start. Ask the workspace administrator to check the GitHub connection and repository branch settings, then start a new request.",
  coding_failed:
    "The coding task could not finish. Ask the workspace administrator to inspect it in the panel.",
  coding_checks_failed:
    "The repository checks did not pass. Ask the workspace administrator to inspect the recorded checks before another attempt.",
  coding_intent_unverified:
    "The coding request could not be verified against your message. State the change you want explicitly in a new request.",
  coding_device_auth_required:
    "Your task is paused because Codex needs sign-in. Ask the workspace operator to reconnect the account in Plugins → Codex → Configuration.",
  github_app_permissions_missing:
    "The GitHub App lacks permissions needed for this task. Ask the workspace operator to update its repository permissions in GitHub.",
  github_repository_not_connected:
    "This repository is not connected to the workspace. Ask the workspace operator to check its GitHub connection.",
  coding_maintainer_required:
    "You do not have coding access to this repository. Ask the workspace administrator to review your maintainer access.",
  coding_direct_execution_disabled:
    "This repository requires reviewed approval. Request a coding proposal and approve it before execution.",
  coding_configuration_changed:
    "Coding settings changed during this task. Ask the workspace administrator to review them before a new request.",
  coding_pr_closed:
    "The existing PR is closed or merged. Start a new request if you need another change.",
  coding_task_timeout:
    "The coding task timed out. Ask the workspace administrator to inspect it before another attempt.",
  coding_provider_usage_limit:
    "Your Codex provider's usage limit was reached. Ask the workspace operator to review the account allowance before trying again.",
  coding_provider_rate_limited:
    "Your Codex provider is rate limiting requests. Wait before trying again; ask the operator to review the provider if this persists.",
  coding_provider_unavailable:
    "The connection to your Codex provider failed. Ask the workspace operator to check the provider connection.",
};

export function codingFailureMessage(
  code: string,
  payload?: Pick<CodingPayload, "repository" | "baseBranch">,
) {
  if (payload && code === "coding_base_branch_missing")
    return `The configured base branch “${payload.baseBranch}” does not exist in ${payload.repository}, so Codex did not start. Ask the workspace administrator to update the base branch in Plugins → Codex → Repositories, then start a new request.`;
  if (payload && code === "coding_checkout_failed")
    return `Could not check out ${payload.repository}, so Codex did not start. Ask the workspace administrator to check the GitHub connection and repository branch settings, then start a new request.`;
  const text = messages[code] ?? attachmentErrors[code];
  if (!text)
    return "I couldn’t finish this task. Ask the workspace administrator to inspect it in the panel.";
  return code === "github_user_access_unavailable" ||
    /Ask|Wait|Start|State|Request/.test(text)
    ? text
    : `${text} Ask the workspace administrator to inspect the task before trying again.`;
}
