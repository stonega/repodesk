import { deflateSync } from "node:zlib";
import { Type } from "typebox";
import { z } from "zod";
import {
  type Delivery,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { deliver } from "../workspaces/service.ts";

const argumentsSchema = z.strictObject({
  html: z.string().min(1).max(32768),
  caption: z.string().trim().min(1).max(1024),
  width: z.number().int().min(200).max(430).optional(),
  height: z.number().int().min(50).max(600).optional(),
});
export const widgetParameters = Type.Object(
  {
    html: Type.String({ minLength: 1, maxLength: 32768 }),
    caption: Type.String({ minLength: 1, maxLength: 1024 }),
    width: Type.Optional(Type.Integer({ minimum: 200, maximum: 430 })),
    height: Type.Optional(Type.Integer({ minimum: 50, maximum: 600 })),
  },
  { additionalProperties: false },
);

/** The application fixes the audience and disables bot requests and sharing. */
function widgetBot(w: Workspace, r: Run) {
  const thread = w.threads?.find((t) => t.id === r.threadId);
  requireThat(
    !r.workflowId &&
      r.chatId === r.actor &&
      thread?.botId &&
      thread.actor === r.actor &&
      thread.chatId === r.chatId &&
      (thread.topicId ?? 0) === r.topicId,
    "widget_private_chat_required",
    403,
  );
  return thread.botId;
}
export function authorizeWidget(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  widgetBot(w, r);
  const parsed = argumentsSchema.parse(args);
  requireThat(!parsed.html.includes("\0"), "widget_html_invalid");
  requireThat(
    Buffer.byteLength(parsed.html) <= 32768 &&
      deflateSync(parsed.html, { level: 9 }).byteLength <= 4096,
    "widget_too_large",
  );
  return parsed;
}
export function stageWidget(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
  botId?: string,
) {
  const value = authorizeWidget(w, r, args);
  authorizeWidgetBot(w, r, botId);
  r.widget = { ...value, botId: widgetBot(w, r), requestMessageId: r.replyTo };
  return {
    status: "staged",
    guidance:
      "Publishes with a successful answer. Keep the final reply useful as text; do not claim delivery yet.",
  };
}
export function authorizeWidgetBot(w: Workspace, r: Run, botId?: string) {
  requireThat(widgetBot(w, r) === botId, "widget_bot_changed", 403);
}
export function publishWidget(w: Workspace, r: Run, botId?: string) {
  if (
    !r.widget ||
    r.status !== "succeeded" ||
    r.codingTaskId ||
    r.pendingInputs?.length ||
    r.widget.requestMessageId !== r.replyTo
  )
    return;
  requireThat(
    widgetBot(w, r) === botId && r.widget.botId === botId,
    "widget_bot_changed",
    403,
  );
  const id = deliver(w, r.actor, r.chatId, r.widget.caption, {
    id: `run:${r.id}:widget`,
    runId: r.id,
    topicId: r.topicId,
    replyTo: r.replyTo,
  });
  const d = w.deliveries.find((d) => d.id === id);
  requireThat(d, "widget_intent_missing");
  d.botId = botId;
  d.widget = structuredClone(r.widget);
}
export function widgetDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.widget) return true;
  const r = w.runs.find((r) => r.id === d.runId);
  if (r?.status !== "succeeded" || !r.widget || r.codingTaskId) return false;
  try {
    return (
      widgetBot(w, r) === botId &&
      r.widget.botId === botId &&
      d.botId === botId &&
      d.id === `run:${r.id}:widget` &&
      d.actor === r.actor &&
      d.chatId === r.chatId &&
      d.topicId === r.topicId &&
      d.replyTo === r.replyTo &&
      d.text === r.widget.caption &&
      fingerprint(d.widget) === fingerprint(r.widget)
    );
  } catch {
    return false;
  }
}
