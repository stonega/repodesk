import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat } from "../domain.ts";
import { hash } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import { ALLOWED_UPDATES, TelegramError } from "./client.ts";
import { updateSchema } from "./router.ts";
import { Ingress } from "./webhook.ts";

export function pollingRetryDelay(error: unknown) {
  return error instanceof TelegramError && error.disposition === "retry"
    ? Math.max(1000, error.retryAfter * 1000)
    : 5000;
}

export function pollingErrorCode(error: unknown) {
  return error instanceof TelegramError ||
    (error instanceof Fault && error.code.startsWith("polling_"))
    ? error.code
    : error instanceof z.ZodError
      ? "polling_invalid_update"
      : "polling_receive_failed";
}

import type { GitHubUsers } from "../github/users.ts";

export class TelegramPoller {
  private id = randomUUID();
  private ingress: Ingress;
  private connected = false;
  constructor(
    private store: Store,
    private setup: SetupService,
    githubUsers?: GitHubUsers,
  ) {
    this.ingress = new Ingress(store, setup, githubUsers);
  }

  async pollOnce(signal: AbortSignal): Promise<void> {
    requireThat(this.setup.telegramTransport === "polling", "polling_disabled");
    signal.throwIfAborted();
    const d = await this.store.deployment();
    if (!d.bot || !d.credentials.bot) return;
    const botId = d.bot.id;
    const fingerprint = hash(d.credentials.bot);
    const sql = await this.store.pool.connect();
    const connectionLost = new AbortController();
    const abort = AbortSignal.any([signal, connectionLost.signal]);
    const onError = () => connectionLost.abort();
    sql.on("error", onError);
    let locked = false;
    let broken = false;
    try {
      // A session lock spans the HTTP wait and durable acceptance, without a long SQL transaction.
      locked =
        (
          await sql.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [`telegram-polling:${botId}`],
          )
        ).rows[0]?.locked === true;
      if (!locked) return;
      await sql.query(
        "INSERT INTO telegram_polling(bot_id,credential_hash) VALUES($1,$2) ON CONFLICT(bot_id) DO UPDATE SET credential_hash=$2, ready_at=CASE WHEN telegram_polling.credential_hash=$2 THEN telegram_polling.ready_at END, retry_at=CASE WHEN telegram_polling.credential_hash=$2 THEN telegram_polling.retry_at END, error=CASE WHEN telegram_polling.credential_hash=$2 THEN telegram_polling.error END",
        [botId, fingerprint],
      );
      const state = (
        await sql.query<{ offset: string | null; waiting: boolean }>(
          "SELECT CASE WHEN last_update_at > now()-interval '7 days' THEN next_offset END AS offset, retry_at > now() AS waiting FROM telegram_polling WHERE bot_id=$1",
          [botId],
        )
      ).rows[0];
      if (state?.waiting) return;
      const client = await this.setup.client(d);
      const webhook = await client.call<{ url: string }>(
        "getWebhookInfo",
        {},
        { signal: abort },
      );
      // Never silently take over another deployment's webhook or discard its pending updates.
      requireThat(webhook.url === "", "polling_webhook_conflict", 409);
      const updates = z.array(updateSchema).parse(
        await client.call<unknown>(
          "getUpdates",
          {
            ...(state?.offset == null ? {} : { offset: Number(state.offset) }),
            timeout: 25,
            limit: 100,
            allowed_updates: ALLOWED_UPDATES,
          },
          { signal: abort, timeoutMs: 35000 },
        ),
      );
      abort.throwIfAborted();
      requireThat(
        (await this.store.deployment()).credentials.bot === d.credentials.bot,
        "polling_credentials_changed",
        409,
      );
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        abort.throwIfAborted();
        await this.ingress.accept(update);
        abort.throwIfAborted();
        // Crash between acceptance and cursor save causes a replay; inbox deduplication handles it.
        await sql.query(
          "UPDATE telegram_polling SET next_offset=$2, last_update_at=now() WHERE bot_id=$1",
          [botId, update.update_id + 1],
        );
      }
      await sql.query(
        "UPDATE telegram_polling SET ready_at=now(), error=NULL, retry_at=NULL, owner_id=$2 WHERE bot_id=$1",
        [botId, this.id],
      );
      if (!this.connected) this.store.log.write("telegram_polling_connected");
      this.connected = true;
      if (updates.length) this.store.log.write("telegram_updates_received");
    } catch (error) {
      if (locked && !connectionLost.signal.aborted) {
        await sql.query(
          "UPDATE telegram_polling SET ready_at=NULL, error=$2, retry_at=now()+($3 * interval '1 millisecond'), owner_id=$4 WHERE bot_id=$1",
          [
            botId,
            signal.aborted ? null : pollingErrorCode(error),
            pollingRetryDelay(error),
            this.id,
          ],
        );
      }
      throw error;
    } finally {
      try {
        if (locked && !connectionLost.signal.aborted)
          await sql.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [`telegram-polling:${botId}`],
          );
      } catch {
        broken = true;
      }
      sql.removeListener("error", onError);
      sql.release(broken || connectionLost.signal.aborted);
    }
  }

  async run(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        let delay = 1000;
        try {
          await this.pollOnce(signal);
        } catch (error) {
          if (signal.aborted) break;
          delay = pollingRetryDelay(error);
          this.connected = false;
          this.store.log.write("telegram_polling_failed", {
            error: new Fault(pollingErrorCode(error)),
            retryDelayMs: delay,
          });
        }
        await sleep(delay, undefined, { signal }).catch(() => {});
      }
    } finally {
      await this.store.pool.query(
        "UPDATE telegram_polling SET ready_at=NULL WHERE owner_id=$1",
        [this.id],
      );
    }
  }
}
