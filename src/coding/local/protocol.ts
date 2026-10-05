import { z } from "zod";
import { codingPayload } from "../config.ts";
import { developmentResult, developmentRun } from "../development.ts";

export const localStart = z
  .object({
    workspaceId: z.uuid(),
    taskId: z.uuid(),
    payload: codingPayload,
    issue: z
      .object({
        number: z.number().int().positive(),
        url: z.string().url(),
      })
      .optional(),
    development: developmentRun.optional(),
    providerApiKey: z.string().trim().min(1).max(8192).optional(),
    readToken: z.string().min(1).max(8192),
  })
  .strict();
export type LocalStart = z.infer<typeof localStart>;
export const localStatus = z.object({
  state: z.enum([
    "auth_required",
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
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  publishedSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  checkPassed: z.boolean().optional(),
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
  erase?(workspaceId: string, taskId: string): Promise<void>;
  start(input: LocalStart): Promise<void>;
  resumeAuth?(workspaceId: string, taskId: string): Promise<void>;
  status(workspaceId: string, taskId: string): Promise<LocalStatus>;
  publish(workspaceId: string, taskId: string, token: string): Promise<void>;
  cancel(workspaceId: string, taskId: string): Promise<void>;
}
