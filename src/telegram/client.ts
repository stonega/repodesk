import { Fault } from "../domain.ts";
export class TelegramError extends Fault {
  constructor(
    code: string,
    public disposition: "permanent" | "retry" | "unknown",
    public retryAfter = 0,
  ) {
    super(code, 502);
  }
}
export interface BotIdentity {
  id: number;
  username: string;
  is_bot: boolean;
  can_read_all_group_messages?: boolean;
}
export const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
  "chat_member",
  "stopped_message_generation",
];
export interface TelegramCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface Telegram {
  downloadFile?(
    fileId: string,
    maxBytes: number,
    options?: TelegramCallOptions,
  ): Promise<Uint8Array>;
  call<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: TelegramCallOptions,
  ): Promise<T>;
}
export class TelegramClient implements Telegram {
  constructor(
    private secret: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async downloadFile(
    fileId: string,
    maxBytes: number,
    options: TelegramCallOptions = {},
  ): Promise<Uint8Array> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 15000),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const file = await this.call<{ file_path?: string; file_size?: number }>(
        "getFile",
        { file_id: fileId },
        { ...options, signal },
      );
      if (file.file_size !== undefined && file.file_size > maxBytes)
        throw new Fault("attachment_too_large");
      // The Bot API supplies relative paths. Reject URLs, traversal and encoded separators.
      if (
        !file.file_path ||
        !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) ||
        file.file_path.startsWith("/") ||
        file.file_path
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new Fault("attachment_download_failed");
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.secret}/${file.file_path}`,
        { signal, redirect: "error" },
      );
      if (!response.ok || !response.body)
        throw new Fault("attachment_download_failed");
      const length = response.headers.get("content-length");
      if (length && Number(length) > maxBytes) {
        await response.body.cancel();
        throw new Fault("attachment_too_large");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Fault("attachment_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Fault && error.code.startsWith("attachment_"))
        throw error;
      throw new Fault("attachment_download_failed");
    }
  }
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: TelegramCallOptions = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.secret}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.any([
            AbortSignal.timeout(options.timeoutMs ?? 15000),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
    } catch {
      options.signal?.throwIfAborted();
      throw new TelegramError("telegram_outcome_unknown", "unknown");
    }
    let body: {
      ok: boolean;
      result: T;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramError("telegram_invalid_response", "unknown");
    }
    if (!body.ok) {
      if (method === "getUpdates" && body.error_code === 409)
        throw new TelegramError("telegram_polling_conflict", "permanent");
      if (body.error_code === 401)
        throw new TelegramError("telegram_unauthorized", "permanent");
      if (body.error_code === 429)
        throw new TelegramError(
          "telegram_rate_limited",
          "retry",
          body.parameters?.retry_after ?? 30,
        );
      if (body.error_code && body.error_code >= 500)
        throw new TelegramError("telegram_unavailable", "unknown");
      throw new TelegramError("telegram_destination_rejected", "permanent");
    }
    return body.result;
  }
}
export async function registerWebhook(
  client: Telegram,
  origin: string,
  secret: string,
) {
  const url = `${origin}/telegram/webhook`;
  const current = await client.call<{
    url: string;
    allowed_updates?: string[];
  }>("getWebhookInfo");
  // Telegram does not expose the configured secret. Reasserting the same desired config is idempotent.
  await client.call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
  const verified = await client.call<{ url: string }>("getWebhookInfo");
  if (verified.url !== url) throw new Fault("webhook_verification_failed", 502);
  return { changed: current.url !== url, url };
}
