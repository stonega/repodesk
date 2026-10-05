import { Fault } from "../../domain.ts";

/** Only Codex's own errors enter this classifier; tool/script output never does. */
export function codexAuthFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  const info = error.codexErrorInfo;
  if (info === "unauthorized" || info === "Unauthorized") return true;
  if (info && typeof info === "object") {
    const details = info as Record<string, unknown>;
    for (const kind of [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ])
      if (
        (details[kind] as { httpStatusCode?: number } | undefined)
          ?.httpStatusCode === 401
      )
        return true;
  }
  // Managed-auth refresh failures can arrive as RPC/exec error messages.
  const message = typeof error.message === "string" ? error.message : "";
  return (
    /^unexpected status 401 Unauthorized\b/i.test(message) ||
    /\brefresh_token_(?:expired|reused|invalidated)\b/.test(message) ||
    /your (?:access token could not be refreshed because your )?refresh token (?:expired|has expired|has already been used|was already used|was invalidated|was revoked)[\s\S]*(?:log|sign) in again/i.test(
      message,
    )
  );
}

export class CodexAuthError extends Fault {
  constructor(
    readonly threadId?: string,
    readonly tokens?: number,
  ) {
    super("coding_device_auth_required", 409);
  }
}
