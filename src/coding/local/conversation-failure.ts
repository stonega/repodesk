import { Fault } from "../../domain.ts";
import type { ResultIssues } from "../result-validation.ts";

export const conversationFailureCodes = [
  "coding_conversation_failed",
  "coding_codex_failed",
  "coding_provider_usage_limit",
  "coding_provider_rate_limited",
  "coding_provider_unavailable",
  "coding_provider_request_invalid",
  "coding_context_exceeded",
  "coding_sandbox_failed",
  "coding_result_missing",
  "coding_result_json_invalid",
  "coding_result_invalid",
  "coding_cancelled",
  "coding_task_timeout",
] as const;
type ConversationFailureCode = (typeof conversationFailureCodes)[number];

export class CodexConversationError extends Fault {
  constructor(
    code: ConversationFailureCode,
    readonly threadId?: string,
    readonly tokens?: number,
    readonly resultIssues?: ResultIssues,
    readonly usageUnknown?: boolean,
  ) {
    super(code, 503);
  }
}

// Provider messages and additionalDetails may contain private text or credentials.
// Classify only the protocol's known enum/status fields; never retain raw errors.
export function conversationFailureCode(
  error: unknown,
): ConversationFailureCode {
  const codes: Record<string, ConversationFailureCode> = {
    contextwindowexceeded: "coding_context_exceeded",
    usagelimitexceeded: "coding_provider_usage_limit",
    httpconnectionfailed: "coding_provider_unavailable",
    responsestreamconnectionfailed: "coding_provider_unavailable",
    responsestreamdisconnected: "coding_provider_unavailable",
    responsetoomanyfailedattempts: "coding_provider_unavailable",
    badrequest: "coding_provider_request_invalid",
    sandboxerror: "coding_sandbox_failed",
    internalservererror: "coding_provider_unavailable",
  };
  if (!error || typeof error !== "object") return "coding_conversation_failed";
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  if (typeof info === "string")
    return codes[info.toLowerCase()] ?? "coding_conversation_failed";
  if (info && typeof info === "object") {
    for (const [variant, value] of Object.entries(info)) {
      const status =
        value && typeof value === "object"
          ? (value as { httpStatusCode?: unknown }).httpStatusCode
          : undefined;
      if (status === 429) return "coding_provider_rate_limited";
      if (status === 400) return "coding_provider_request_invalid";
      const code = codes[variant.toLowerCase()];
      if (code) return code;
    }
  }
  return "coding_conversation_failed";
}
