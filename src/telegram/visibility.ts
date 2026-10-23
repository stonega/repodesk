import { type Telegram, TelegramError } from "./client.ts";

/** Group administrators receive ordinary messages even when global privacy is on. */
export async function groupVisibility(
  client: Telegram,
  chatId: string,
  botId: string,
) {
  const me = await client.call<{ can_read_all_group_messages?: boolean }>(
    "getMe",
  );
  if (me.can_read_all_group_messages) return true;
  try {
    const membership = await client.call<{ status: string }>("getChatMember", {
      chat_id: chatId,
      user_id: botId,
    });
    return ["creator", "administrator"].includes(membership.status);
  } catch (error) {
    if (
      error instanceof TelegramError &&
      error.code === "telegram_destination_rejected"
    )
      return false;
    throw error;
  }
}
