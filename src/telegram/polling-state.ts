import type { Sql } from "../db/pool.ts";
import type { Deployment } from "../domain.ts";
import { hash } from "../setup/credentials.ts";

export type TelegramTransport = "webhook" | "polling";

export async function pollingStatus(sql: Sql, deployment: Deployment) {
  if (!deployment.bot || !deployment.credentials.bot)
    return { ready: false, error: "bot_not_configured" };
  const row = (
    await sql.query<{ ready: boolean; error: string | null }>(
      "SELECT (ready_at > now()-interval '60 seconds') AS ready, error FROM telegram_polling WHERE bot_id=$1 AND credential_hash=$2",
      [deployment.bot.id, hash(deployment.credentials.bot)],
    )
  ).rows[0];
  return { ready: row?.ready === true, error: row?.error ?? undefined };
}
