import type { Store } from "../db/repositories.ts";
import type { Deployment } from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "./client.ts";

const commonCommands = [
  { command: "repos", description: "Choose a repository" },
  { command: "ask", description: "Ask about your repository or team" },
  {
    command: "status",
    description: "Check requests and tasks in this conversation",
  },
  { command: "cancel", description: "Cancel a request or task" },
  { command: "help", description: "Show commands and help" },
] as const;
export const commandMenus = [
  { scope: { type: "default" }, commands: commonCommands },
  { scope: { type: "all_group_chats" }, commands: commonCommands },
  {
    scope: { type: "all_private_chats" },
    commands: [
      commonCommands[0],
      { command: "github", description: "Connect your GitHub account" },
      ...commonCommands.slice(1),
    ],
  },
];

function identity(d: Deployment) {
  return d.active && !d.paused && d.bot && d.credentials.bot
    ? `${d.bot.id}:${d.credentials.bot}`
    : undefined;
}

/** Publish discovery menus once per worker/credential; command handlers still authorize every request. */
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
      for (const menu of commandMenus) {
        signal.throwIfAborted();
        if (identity(await this.store.deployment()) !== key) return;
        await client.call(
          "setMyCommands",
          { ...menu, language_code: "" },
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
