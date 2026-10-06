import { attachmentErrors } from "../telegram/attachments.ts";

const messages: Record<string, string> = {
  coding_conversation_failed: "Codex could not complete the conversation.",
  coding_codex_failed: "The Codex process stopped before completing the task.",
  coding_provider_usage_limit: "Your Codex provider's usage limit was reached.",
  coding_provider_rate_limited:
    "Your Codex provider is rate limiting requests.",
  coding_provider_unavailable: "The connection to your Codex provider failed.",
  coding_provider_request_invalid: "Your Codex provider rejected the request.",
  coding_context_exceeded:
    "The Codex conversation exceeded the provider's context capacity.",
  coding_sandbox_failed:
    "Codex could not run a command in its execution environment.",
  coding_result_missing: "Codex finished without returning a task result.",
  coding_result_json_invalid: "Codex returned an unreadable task result.",
  coding_result_invalid:
    "Codex returned an incomplete task result or verification plan.",
};

export const codingFailureMessage = (code: string) =>
  messages[code] ?? attachmentErrors[code] ?? code;
