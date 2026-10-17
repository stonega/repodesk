import { requireThat } from "../../domain.ts";
import type {
  ChannelEvent,
  TaskConversation,
  TaskMessage,
} from "../conversation.ts";

export function enqueueMessage(
  mailbox: TaskConversation,
  message: TaskMessage,
) {
  const prior = mailbox.messages.find((m) => m.id === message.id);
  if (prior) {
    requireThat(
      prior.question === message.question,
      "coding_message_conflict",
      409,
    );
    return;
  }
  requireThat(mailbox.messages.length < 64, "coding_message_capacity", 429);
  mailbox.messages.push({ ...message, state: "queued" });
}

export function applyChannelEvent(
  mailbox: TaskConversation,
  event: ChannelEvent,
) {
  if (event.action === "progress") {
    requireThat(
      event.text && event.text.length <= 2000,
      "coding_message_invalid",
      400,
    );
    mailbox.progress = { id: event.id, text: event.text };
    return;
  }
  const message = mailbox.messages.find((m) => m.id === event.id);
  requireThat(message, "coding_message_not_found", 404);
  if (event.action === "claim" && message.state === "queued") {
    message.sessionId = event.sessionId;
    message.state = "dispatching";
    return;
  }
  requireThat(
    message.sessionId === event.sessionId,
    "coding_message_session_changed",
    409,
  );
  if (event.action === "release" && message.state === "dispatching") {
    message.state = "queued";
    message.sessionId = undefined;
    return;
  }
  requireThat(
    !["unknown", "cancelled"].includes(message.state),
    "coding_message_closed",
    409,
  );
  if (event.action === "accepted" && message.state === "dispatching")
    message.state = "accepted";
  if (
    event.action === "read" &&
    ["dispatching", "accepted"].includes(message.state)
  )
    message.state = "read";
  if (event.action === "answer") {
    requireThat(event.text, "coding_message_invalid", 400);
    requireThat(
      !message.answer || message.answer === event.text,
      "coding_message_conflict",
      409,
    );
    message.answer = event.text;
    message.state = "answered";
  }
}

export function closeMailbox(
  mailbox: TaskConversation | undefined,
  cancelled = false,
) {
  for (const message of mailbox?.messages ?? [])
    if (!["answered", "cancelled", "unknown"].includes(message.state))
      message.state = cancelled
        ? "cancelled"
        : message.state === "queued"
          ? "queued"
          : "unknown";
}
