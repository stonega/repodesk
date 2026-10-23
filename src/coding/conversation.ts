import { z } from "zod";
import type { LocalStart } from "./local/protocol.ts";

/** Questions are reference data, never additions to an implementation grant. */
export const taskMessage = z
  .object({
    id: z.uuid(),
    question: z.string().trim().min(1).max(4000),
  })
  .strict();
export type TaskMessage = z.infer<typeof taskMessage>;
export const conversationPage = z.object({
  offset: z.number().int().min(0).max(100).default(0),
  limit: z.number().int().min(1).max(20).default(20),
});
export const runnerMessage = taskMessage.extend({
  state: z.enum([
    "queued",
    "dispatching",
    "accepted",
    "read",
    "answered",
    "unknown",
    "cancelled",
  ]),
  sessionId: z.uuid().optional(),
  answer: z.string().min(1).max(6000).optional(),
});
export type RunnerMessage = z.infer<typeof runnerMessage>;
export const taskConversation = z.object({
  messages: z.array(runnerMessage).max(64),
  progress: z
    .object({ id: z.uuid(), text: z.string().min(1).max(2000) })
    .optional(),
});
export type TaskConversation = z.infer<typeof taskConversation>;
export const channelEvent = z
  .object({
    action: z.enum([
      "claim",
      "release",
      "accepted",
      "read",
      "answer",
      "progress",
    ]),
    sessionId: z.uuid(),
    id: z.uuid(),
    text: z.string().trim().min(1).max(6000).optional(),
  })
  .strict();
export type ChannelEvent = z.infer<typeof channelEvent>;

export interface TaskExchange extends TaskMessage {
  actor: string;
  runId: string;
  sourceIds: string[];
  sourceKey: string;
  state: "queued" | "received" | "read" | "answered" | "unknown" | "cancelled";
  answer?: string;
  answeredAt?: string;
  error?: string;
  attemptId?: string;
  route?: "active" | "readonly";
  cleanup?: boolean;
  start?: Omit<LocalStart, "readToken" | "referenceToken" | "providerApiKey">;
  createdAt: string;
  lease?: string;
  leaseUntil?: string;
}
