import { z } from "zod";

const user = z.object({
  id: z.number().int().positive().safe(),
  is_bot: z.boolean(),
  username: z.string().optional(),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
});
const chat = z.object({
  id: z.number().int().safe(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().max(256).optional(),
});
const file = z.object({
  file_id: z.string().min(1).max(1024),
  file_unique_id: z.string().max(1024).optional(),
  file_size: z.number().int().nonnegative().safe().optional(),
  file_name: z.string().max(1024).optional(),
  mime_type: z.string().max(256).optional(),
});
const entities = z.array(
  z.object({
    type: z.string(),
    offset: z.number().int(),
    length: z.number().int(),
  }),
);
const message = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int(),
  chat,
  from: user.optional(),
  sender_chat: chat.optional(),
  text: z.string().max(20000).optional(),
  caption: z.string().max(20000).optional(),
  caption_entities: entities.optional(),
  photo: z
    .array(
      file.extend({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .max(20)
    .optional(),
  document: file.optional(),
  audio: file.optional(),
  video: file.optional(),
  voice: file.optional(),
  animation: file.optional(),
  new_chat_title: z.string().max(256).optional(),
  message_thread_id: z.number().int().optional(),
  entities: entities.optional(),
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
  stopped_message_generation: z
    .object({
      chat,
      message_thread_id: z.number().int().positive().safe().optional(),
      draft_id: z
        .number()
        .int()
        .safe()
        .refine((value) => value !== 0),
    })
    .optional(),
});
export type Update = z.infer<typeof updateSchema>;
export type Message = z.infer<typeof message>;
export function command(
  message: Message,
  bot: { id: string; username: string },
) {
  if (message.from?.is_bot || message.sender_chat || !message.from) return;
  const text = message.text ?? message.caption ?? "";
  const spans =
    message.text !== undefined ? message.entities : message.caption_entities;
  const entity = spans?.find((e) => e.type === "bot_command" && e.offset === 0);
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
  if (!["group", "supergroup"].includes(message.chat.type)) return;
  const mention = spans?.find(
    (e) =>
      e.type === "mention" &&
      e.offset >= 0 &&
      e.length === bot.username.length + 1 &&
      text.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${bot.username.toLowerCase()}`,
  );
  if (mention)
    return {
      name: "ask",
      args:
        (
          text.slice(0, mention.offset) +
          text.slice(mention.offset + mention.length)
        ).trim() || text,
    };
}
