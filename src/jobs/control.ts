import type { Store } from "../db/repositories.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "../telegram/client.ts";
import { eligible } from "../workspaces/policy.ts";
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
      const workspace = row.workspace_id
        ? await store.read(row.workspace_id)
        : undefined;
      const chatId = row.chat_id ?? row.actor;
      if (
        workspace?.deletion ||
        (chatId !== row.actor &&
          !workspace?.chats.some((c) => c.active && c.id === chatId))
      ) {
        await store.pool.query(
          "UPDATE control_deliveries SET state='cancelled' WHERE bot_id=$1 AND update_id=$2",
          [row.bot_id, row.update_id],
        );
        continue;
      }
      const request = workspace?.accessRequests?.find(
        (r) => r.actor === row.actor,
      );
      const allowed = workspace && eligible(workspace, row.actor);
      const rejected =
        request?.status === "rejected" &&
        Date.parse(request.decidedAt ?? "") > Date.now() - 86400000;
      const text = allowed
        ? deployment.active
          ? "You already have access. Send /help to get started."
          : "RepoDesk is not active yet. Ask a deployment admin to activate it in Model settings."
        : request?.status === "pending"
          ? "Your access request is pending. A workspace admin will review it."
          : rejected
            ? "Your access request was rejected. Contact your workspace admin or request again after 24 hours."
            : workspace
              ? "You do not have access to this workspace yet. Tap Request access to ask an admin to approve you."
              : "You do not have workspace access yet. Ask your admin for the workspace's request-access link, then open it to request access. First-time owners verify their identity from web setup.";
      const result = await (await setup.client()).call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: chatId,
          message_thread_id: row.topic_id ?? undefined,
          text,
          reply_markup:
            workspace && !allowed && request?.status !== "pending" && !rejected
              ? {
                  inline_keyboard: [
                    [
                      {
                        text: "Request access",
                        callback_data: `request_access:${workspace.id}`,
                      },
                    ],
                  ],
                }
              : undefined,
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
