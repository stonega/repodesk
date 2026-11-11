import type { Store } from "../db/repositories.ts";
import type { Deployment } from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "./client.ts";

// Clear every scope published by earlier versions, including the fallback list.
export const commandScopes = [
  { type: "default" },
  { type: "all_group_chats" },
  { type: "all_private_chats" },
] as const;

function identity(d: Deployment) {
  return d.active && !d.paused && d.bot && d.credentials.bot
    ? `${d.bot.id}:${d.credentials.bot}`
    : undefined;
}

/** Remove legacy menus once per worker/credential; chat actions authorize every request. */
export class TelegramCommandMenu {
  private registered?: string;
  private retryAt = 0;
  private busy = false;
  constructor(
    private store: Store,
    private setup: SetupService,
    private now = Date.now,
  ) {}

  async sync(signal: AbortSignal) {
    if (signal.aborted || this.busy || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      const deployment = await this.store.deployment();
      const key = identity(deployment);
      if (!key || this.registered === key) return;
      const client = await this.setup.client(deployment);
      for (const scope of commandScopes) {
        signal.throwIfAborted();
        if (identity(await this.store.deployment()) !== key) return;
        await client.call(
          "deleteMyCommands",
          { scope, language_code: "" },
          {
            signal,
            timeoutMs: 10000,
          },
        );
      }
      if (identity(await this.store.deployment()) === key)
        this.registered = key;
    } catch (error) {
      this.retryAt =
        this.now() +
        Math.max(
          60000,
          error instanceof TelegramError && error.disposition === "retry"
            ? error.retryAfter * 1000
            : 0,
        );
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
