import { z } from "zod";
import type { DevelopmentTask } from "./development.ts";
import { developmentPolicy } from "./development-policy.ts";

// Git branch names, not arbitrary refs, command arguments, or filesystem paths.
export const branchName = z
  .string()
  .min(1)
  .max(150)
  .refine(
    (s) =>
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) &&
      !s.includes("..") &&
      !s.includes("//") &&
      s
        .split("/")
        .every(
          (part) =>
            part &&
            !part.startsWith(".") &&
            !part.endsWith(".") &&
            !part.endsWith(".lock"),
        ),
    "Enter a branch name such as develop or release/next",
  );
// Discard obsolete command settings when loading old records or saving older clients.
function withoutCommands(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clean = { ...value } as Record<string, unknown>;
  delete clean.setupCommand;
  delete clean.checkCommand;
  return clean;
}
export const codingRepositorySchema = z.preprocess(
  withoutCommands,
  z
    .object({
      repositoryId: z.number().int().positive(),
      baseBranch: branchName,
      development: developmentPolicy.optional(),
      maintainers: z
        .array(z.string().regex(/^[1-9]\d{0,15}$/))
        .min(1)
        .max(100),
    })
    .strict(),
);
export const codingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    backend: z.literal("podman"),
    authMode: z.enum(["provider_key", "device_code"]).default("provider_key"),
    repositories: z.array(codingRepositorySchema).max(12),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.repositories.map((r) => r.repositoryId)).size ===
      s.repositories.length,
    "Select each repository only once",
  );
export const codingSaveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: codingSettingsSchema,
    providerApiKey: z.string().trim().min(1).max(8192).nullable().optional(),
  })
  .strict();
export type CodingSettings = z.infer<typeof codingSettingsSchema>;
export interface CodingConfig {
  providerApiKey?: string; // Encrypted with the deployment key and workspace-bound AAD.
  revision: number;
  settings: CodingSettings;
}
export const emptyCoding: CodingSettings = {
  enabled: false,
  backend: "podman",
  authMode: "provider_key",
  repositories: [],
};
export const codingInput = z
  .object({
    repositoryId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2500),
  })
  .strict();
export const codingPayload = z.preprocess(
  withoutCommands,
  codingInput.extend({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    installationId: z.number().int().positive(),
    githubRevision: z.number().int().nonnegative(),
    configRevision: z.number().int().positive(),
    baseBranch: branchName,
    backend: z.literal("podman"),
    authMode: z.enum(["provider_key", "device_code"]).default("provider_key"),
  }),
);
export type CodingPayload = z.infer<typeof codingPayload>;
export type CodingState =
  | "queued"
  | "creating_issue"
  | "issue_created"
  | "dispatching"
  | "running"
  | "starting_publication"
  | "publishing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";
export interface CodingTask {
  id: string;
  actor: string;
  runId: string;
  chatId: string;
  topicId: number;
  payload: CodingPayload;
  state: CodingState;
  createdAt: string;
  updatedAt: string;
  issue?: { number: number; url: string };
  threadId?: string;
  workflowRunId?: number;
  workflowUrl?: string;
  prUrl?: string;
  error?: string;
  nextPollAt?: string;
  lease?: string;
  cancelRequested?: boolean;
}
export interface CodingPage {
  providerApiKeyConfigured: boolean;
  deviceAuth?: {
    state: "disconnected" | "pending" | "connected" | "failed" | "unavailable";
    verificationUrl?: string;
    userCode?: string;
  };
  legacyActionsConfiguration: boolean;
  revision: number;
  settings: CodingSettings;
  repositories: { id: number; full_name: string; private?: boolean }[];
  members: { id: string; active: boolean; username?: string }[];
  tasks: CodingTask[];
  developmentTasks?: DevelopmentTask[];
}
export const codingTerminal = (state: CodingState) =>
  ["succeeded", "failed", "unknown", "cancelled"].includes(state);
