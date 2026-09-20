import type { Store } from "../db/repositories.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "../telegram/client.ts";
export async function deliverAccessHelp(store: Store, setup: SetupService) {
  const deployment = await store.deployment();
  if (!deployment.bot || deployment.paused) return;
  await store.pool.query(
    "UPDATE control_deliveries SET state='delivery_unknown' WHERE state='sending' AND started_at<now()-interval '30 seconds'",
  );
  const claimed = await store.pool.query(
    "UPDATE control_deliveries SET state='sending',started_at=now(),attempts=attempts+1 WHERE (bot_id,update_id) IN (SELECT bot_id,update_id FROM control_deliveries WHERE state='pending' AND next_at<=now() ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *",
  );
  for (const row of claimed.rows) {
    try {
      const result = await (await setup.client()).call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: row.actor,
          text: "DeepX is a team assistant with explicit workspace access. Ask your workspace admin to enroll and allow your Telegram user ID. First-time owners verify their identity from the web setup wizard. This pilot supports text requests and approved recurring recaps; no old chat history is available.",
        },
      );
      await store.pool.query(
        "UPDATE control_deliveries SET state='sent',remote_id=$3 WHERE bot_id=$1 AND update_id=$2",
        [row.bot_id, row.update_id, result.message_id],
      );
    } catch (error) {
      store.log.write("delivery_failed", { error });
      const retry =
        error instanceof TelegramError &&
        error.disposition === "retry" &&
        row.attempts < 5;
      const state = retry
        ? "pending"
        : error instanceof TelegramError && error.disposition === "permanent"
          ? "failed"
          : "delivery_unknown";
      await store.pool.query(
        "UPDATE control_deliveries SET state=$3,next_at=now()+($4::int * interval '1 second') WHERE bot_id=$1 AND update_id=$2",
        [
          row.bot_id,
          row.update_id,
          state,
          error instanceof TelegramError ? error.retryAfter : 0,
        ],
      );
    }
  }
  await store.pool.query(
    "DELETE FROM control_deliveries WHERE created_at<now()-interval '1 day'",
  );
}
