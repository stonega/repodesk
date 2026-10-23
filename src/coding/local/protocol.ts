import { z } from "zod";
import { runtimeProviderSchema } from "../../models/config.ts";
import { codingPayload } from "../config.ts";
import {
  type TaskMessage,
  taskConversation,
  taskMessage,
} from "../conversation.ts";
import { developmentResult, developmentRun } from "../development.ts";
import { resultIssues } from "../result-validation.ts";
import { transcriptPage } from "../transcript.ts";

export const localStart = z
  .object({
    workspaceId: z.uuid(),
    taskId: z.uuid(),
    payload: codingPayload,
    development: developmentRun,
    messages: z.array(taskMessage).max(64).optional(),
    modelProvider: runtimeProviderSchema.optional(),
    providerApiKey: z.string().trim().min(1).max(8192).optional(),
    readToken: z.string().min(1).max(8192),
    referenceToken: z.string().min(1).max(8192).optional(),
    recoverOnInterruption: z.literal(true).optional(),
  })
  .strict();
export type LocalStart = z.infer<typeof localStart>;
export const localRecovery = z
  .object({
    recoveryId: z.uuid(),
    providerApiKey: z.string().trim().min(1).max(8192).optional(),
    readToken: z.string().min(1).max(8192).optional(),
    referenceToken: z.string().min(1).max(8192).optional(),
  })
  .strict();
export type LocalRecovery = z.infer<typeof localRecovery>;
export const localStatus = z.object({
  transcript: transcriptPage.optional(),
  conversation: taskConversation.optional(),
  state: z.enum([
    "auth_required",
    "interrupted",
    "preparing",
    "running",
    "ready",
    "publishing",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
  ]),
  threadId: z.string().max(100).optional(),
  phase: z
    .enum(["prepare", "setup", "implement", "check", "publish"])
    .optional(),
  result: developmentResult.optional(),
  tokens: z.number().int().nonnegative().optional(),
  usageUnknown: z.boolean().optional(),
  resultIssues: resultIssues.optional(),
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  publishedSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  checkPassed: z.boolean().optional(),
  hasChanges: z.boolean().optional(),
  repairCount: z.number().int().nonnegative().optional(),
  recoveryId: z.uuid().optional(),
  prUrl: z.string().url().optional(),
  error: z
    .string()
    .regex(/^coding_[a-z_]+$/)
    .optional(),
});
export type LocalStatus = z.infer<typeof localStatus>;
export const deviceAuthStatus = z.object({
  state: z.enum([
    "disconnected",
    "pending",
    "connected",
    "auth_required",
    "failed",
  ]),
  verificationUrl: z.string().url().optional(),
  userCode: z
    .string()
    .regex(/^[A-Z0-9-]{4,32}$/)
    .optional(),
});
export type DeviceAuthStatus = z.infer<typeof deviceAuthStatus>;
export interface LocalDeviceAuth {
  deviceStatus(workspaceId: string): Promise<DeviceAuthStatus>;
  deviceStart(workspaceId: string): Promise<DeviceAuthStatus>;
  deviceLogout(workspaceId: string): Promise<DeviceAuthStatus>;
}
export interface LocalRunner {
  message?(
    workspaceId: string,
    taskId: string,
    input: TaskMessage,
  ): Promise<void>;
  erase?(workspaceId: string, taskId: string): Promise<void>;
  start(input: LocalStart): Promise<void>;
  resumeAuth?(workspaceId: string, taskId: string): Promise<void>;
  resumeInterrupted?(
    workspaceId: string,
    taskId: string,
    input: LocalRecovery,
  ): Promise<void>;
  status(
    workspaceId: string,
    taskId: string,
    transcriptOffset?: number,
  ): Promise<LocalStatus>;
  publish(workspaceId: string, taskId: string, token: string): Promise<void>;
  cancel(workspaceId: string, taskId: string): Promise<void>;
}
