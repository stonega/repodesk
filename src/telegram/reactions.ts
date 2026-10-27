import { Type } from "typebox";
import { z } from "zod";
import {
  type Delivery,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { deliver } from "../workspaces/service.ts";

const emojis = [
  "👍",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "🎉",
  "😁",
  "🤔",
  "👀",
  "🙏",
  "💯",
  "🤝",
  "🤗",
  "🫡",
] as const;
const argumentsSchema = z.strictObject({
  emoji: z
    .string()
    .transform((value) => value.replaceAll("\uFE0F", ""))
    .pipe(z.enum(emojis)),
});
export const reactionParameters = Type.Object(
  { emoji: Type.String({ enum: [...emojis, "❤️"] }) },
  { additionalProperties: false },
);

/** The model chooses only an emoji; application state owns the message and bot. */
function reactionTarget(w: Workspace, r: Run) {
  const thread = w.threads?.find((t) => t.id === r.threadId);
  requireThat(
    !r.workflowId &&
      thread?.botId &&
      thread.chatId === r.chatId &&
      (r.chatId === r.actor
        ? thread.actor === r.actor
        : thread.participants?.includes(r.actor)) &&
      (thread.topicId ?? 0) === r.topicId &&
      r.replyTo &&
      Number.isSafeInteger(r.replyTo) &&
      r.replyTo > 0,
    "reaction_target_denied",
    403,
  );
  const sourceId = `${r.chatId === r.actor ? `${thread.botId}:` : ""}${r.chatId}:${r.replyTo}`;
  const matches = (s: Run["sources"][number]) =>
    s.id === sourceId &&
    s.runId === r.id &&
    s.role === "user" &&
    s.author === r.actor &&
    s.chatId === r.chatId &&
    s.topicId === r.topicId &&
    s.threadId === r.threadId &&
    Date.parse(s.expiresAt) > Date.now();
  requireThat(
    r.sources.some(matches) && w.messages.some(matches),
    "reaction_target_denied",
    403,
  );
  return { sourceId, messageId: r.replyTo, botId: thread.botId };
}

export function authorizeReaction(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  const parsed = argumentsSchema.parse(args);
  reactionTarget(w, r);
  return parsed;
}

export function queueReaction(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
  botId?: string,
) {
  const { emoji } = authorizeReaction(w, r, args);
  const target = reactionTarget(w, r);
  requireThat(target.botId === botId, "reaction_bot_changed", 403);
  const id = `run:${r.id}:reaction`;
  const prior = w.deliveries.find((d) => d.id === id);
  requireThat(
    !prior || prior.reaction?.emoji === emoji,
    "reaction_already_chosen",
    409,
  );
  if (!prior) {
    deliver(w, r.actor, r.chatId, emoji, {
      id,
      runId: r.id,
      topicId: r.topicId,
    });
    const intent = w.deliveries.find((d) => d.id === id);
    requireThat(intent, "reaction_intent_missing");
    intent.botId = target.botId;
    intent.reaction = {
      sourceId: target.sourceId,
      messageId: target.messageId,
      emoji,
    };
  }
  return {
    status: !prior || prior.state === "pending" ? "queued" : prior.state,
    emoji,
  };
}

export function reactionDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.reaction) return true;
  const r = w.runs.find((r) => r.id === d.runId);
  if (!r || r.status === "failed") return false;
  try {
    const target = reactionTarget(w, r);
    return (
      d.id === `run:${r.id}:reaction` &&
      d.actor === r.actor &&
      d.chatId === r.chatId &&
      d.topicId === r.topicId &&
      d.botId === botId &&
      target.botId === botId &&
      target.sourceId === d.reaction.sourceId &&
      target.messageId === d.reaction.messageId &&
      emojis.some((emoji) => emoji === d.reaction?.emoji)
    );
  } catch {
    return false;
  }
}
