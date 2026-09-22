import type { Telegram } from "./client.ts";
import { TelegramError } from "./client.ts";
import { telegramRichMessage } from "./format.ts";

/** Ephemeral, awaited previews only. Final delivery always goes through the outbox. */
export class TelegramDraft {
  private nextAt = 0;
  private lastText = "";
  private disabled = false;
  private transientFailures = 0;
  delivered = false;

  constructor(
    private destination: { chatId: string; topicId: number; draftId: number },
    private client: () => Promise<Telegram>,
    private guard: () => Promise<void>,
    private validate: (text: string) => void,
    private signal: AbortSignal,
    private now: () => number = Date.now,
    private report: (
      event: "telegram_draft_started" | "telegram_draft_failed",
      error?: unknown,
    ) => void = () => {},
  ) {}

  /** Show Telegram's native thinking indicator before the first model token. */
  async start() {
    await this.send({ text: "" }, true);
  }

  async update(text: string) {
    if (this.disabled || this.signal.aborted || this.now() < this.nextAt)
      return;
    // Do not show incomplete citations or a dangling UTF-16 surrogate.
    const preview = text
      .slice(0, 2700)
      .replace(/\[source:[^\]]*$|[\uD800-\uDBFF]$/g, "");
    if (!preview.trim() || preview === this.lastText) return;
    try {
      this.validate(preview);
    } catch {
      // Partial text may not yet satisfy citation requirements. Final validation is mandatory.
      return;
    }
    if (await this.send({ rich_message: telegramRichMessage(preview) }))
      this.lastText = preview;
  }

  private async send(content: Record<string, unknown>, thinking = false) {
    if (this.disabled || this.signal.aborted || this.now() < this.nextAt)
      return;
    this.nextAt = this.now() + 1000;
    try {
      const client = await this.client();
      await this.guard();
      this.signal.throwIfAborted();
      await client.call(
        thinking ? "sendMessageDraft" : "sendRichMessageDraft",
        {
          chat_id: Number(this.destination.chatId),
          message_thread_id: this.destination.topicId || undefined,
          draft_id: this.destination.draftId,
          ...content,
          can_stop: true,
          keep_on_stop: false,
        },
        { signal: this.signal, timeoutMs: 2000 },
      );
      if (!this.delivered) this.report("telegram_draft_started");
      this.delivered = true;
      this.transientFailures = 0;
      // The placeholder must not delay the first actual text; 429s still back off.
      if (thinking) this.nextAt = 0;
      return true;
    } catch (error) {
      this.report("telegram_draft_failed", error);
      if (error instanceof TelegramError && error.disposition === "retry")
        this.nextAt = this.now() + Math.max(1000, error.retryAfter * 1000);
      else if (
        error instanceof TelegramError &&
        error.disposition === "unknown" &&
        ++this.transientFailures < 3
      )
        // Ephemeral updates replace the same draft; retrying cannot duplicate a saved reply.
        this.nextAt = this.now() + 1000;
      else this.disabled = true;
      // A preview failure must not lose usage settlement or prevent the final reply.
    }
  }
}
