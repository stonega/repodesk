import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import {
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { audit } from "../workspaces/policy.ts";
import { retainedSource } from "../workspaces/threads.ts";

export const inputHash = (source: Source) =>
  createHash("sha256").update(JSON.stringify(source)).digest("hex");

export function liveSource(w: Workspace, run: Run) {
  const pending = run.pendingInputs?.[0];
  if (!pending) return;
  const source = w.messages.find((s) => s.id === pending.sourceId);
  requireThat(
    source &&
      source.runId === run.id &&
      source.threadId === run.threadId &&
      source.author === run.actor &&
      source.chatId === run.chatId &&
      source.topicId === run.topicId &&
      source.role === "user" &&
      retainedSource(w, source),
    "live_input_source_changed",
    409,
  );
  return { pending, source };
}

// Receiving input and acknowledging its model message are separate durable steps.
// A crash before message_end leaves it pending; after it, recovery uses transcript.
export function checkpointLiveInput(
  w: Workspace,
  run: Run,
  message: AgentMessage,
) {
  if (message.role !== "user") return;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.find((part) => part.type === "text")?.text;
  if (!text) return;
  let payload: { liveInput?: { sourceId: string; hash: string } };
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!payload?.liveInput) return;
  const input = liveSource(w, run);
  requireThat(
    input &&
      payload.liveInput.sourceId === input.source.id &&
      payload.liveInput.hash === inputHash(input.source),
    "live_input_source_changed",
    409,
  );
  if (!run.sources.some((s) => s.id === input.source.id))
    run.sources.push(structuredClone(input.source));
  run.task = input.pending.task;
  run.replyTo = input.pending.messageId;
  run.coverage = `${run.sources.length} retained messages in this conversation. Other conversations are searched only when needed. Earlier messages may have expired.`;
  run.pendingInputs?.shift();
  audit(w, run.actor, "run.input_consumed", run.id);
}

export function liveMessage(
  run: Run,
  source: Source,
  task: string,
  attachments: { prompt: string; images: ImageContent[]; requestText?: string },
): UserMessage {
  return {
    role: "user",
    timestamp: Date.parse(source.at),
    content: [
      {
        type: "text",
        text: JSON.stringify({
          liveInput: { sourceId: source.id, hash: inputHash(source) },
          request: attachments.requestText ?? task,
          sources: [
            {
              id: source.id,
              text: source.text,
              author: source.author,
              role: source.role,
            },
          ],
          attachments: attachments.prompt || undefined,
          actor: run.actor,
          runId: run.id,
          chatId: run.chatId,
          topicId: run.topicId,
        }),
      },
      ...attachments.images,
    ],
  };
}

/** Native reply context is opt-in through an explicit, authorized source citation. */
export function answerReference(run: Run, text: string, botId?: string) {
  if (run.workflowId) return;
  for (const match of text.matchAll(/\[source:([^\]]+)\]/g)) {
    const source = run.sources.find((s) => s.id === match[1]);
    if (
      source?.role !== "user" ||
      source.chatId !== run.chatId ||
      source.topicId !== run.topicId
    )
      continue;
    const messageId = Number(source.id.split(":").at(-1));
    const prefix =
      run.chatId === run.actor ? `${botId}:${run.chatId}:` : `${run.chatId}:`;
    if (
      Number.isSafeInteger(messageId) &&
      messageId > 0 &&
      source.id === `${prefix}${messageId}`
    )
      return messageId;
  }
}
