import { z } from "zod";

const user = z.object({
  id: z.number().int().positive().safe(),
  is_bot: z.boolean(),
  username: z.string().optional(),
});
const chat = z.object({
  id: z.number().int().safe(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});
const message = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int(),
  chat,
  from: user.optional(),
  sender_chat: chat.optional(),
  text: z.string().max(20000).optional(),
  message_thread_id: z.number().int().optional(),
  entities: z
    .array(
      z.object({
        type: z.string(),
        offset: z.number().int(),
        length: z.number().int(),
      }),
    )
    .optional(),
  reply_to_message: z
    .object({ message_id: z.number().int(), from: user.optional() })
    .optional(),
  migrate_to_chat_id: z.number().int().safe().optional(),
  migrate_from_chat_id: z.number().int().safe().optional(),
});
const membership = z.object({
  chat,
  from: user,
  date: z.number().int(),
  new_chat_member: z.object({ status: z.string(), user }),
});
export const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: message.optional(),
  edited_message: message.optional(),
  callback_query: z
    .object({
      id: z.string().max(200),
      from: user,
      data: z.string().max(64).optional(),
      message: message.optional(),
    })
    .optional(),
  my_chat_member: membership.optional(),
  chat_member: membership.optional(),
});
export type Update = z.infer<typeof updateSchema>;
export type Message = z.infer<typeof message>;
export function command(
  message: Message,
  bot: { id: string; username: string },
) {
  if (message.from?.is_bot || message.sender_chat || !message.from) return;
  const text = message.text ?? "";
  const entity = message.entities?.find(
    (e) => e.type === "bot_command" && e.offset === 0,
  );
  if (entity) {
    const value = text.slice(0, entity.length);
    const match = /^\/([a-z_]+)(?:@([a-z0-9_]+))?$/i.exec(value);
    if (
      !match ||
      (match[2] && match[2].toLowerCase() !== bot.username.toLowerCase())
    )
      return;
    return {
      name: match[1]?.toLowerCase() ?? "",
      args: text.slice(entity.length).trim(),
    };
  }
  if (
    message.chat.type === "private" ||
    String(message.reply_to_message?.from?.id) === bot.id
  )
    return { name: "ask", args: text };
}
