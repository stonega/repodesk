import { z } from "zod";

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
export const codingRepositorySchema = z
  .object({
    repositoryId: z.number().int().positive(),
    baseBranch: branchName,
    workflowFile: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.ya?ml$/)
      .max(100)
      .default("repodesk-codex.yml"),
    setupCommand: z.string().trim().max(2000).optional(),
    checkCommand: z.string().trim().max(2000).optional(),
    maintainers: z
      .array(z.string().regex(/^[1-9]\d{0,15}$/))
      .min(1)
      .max(100),
  })
  .strict();
export const codingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    backend: z.enum(["github-actions", "podman"]).optional(),
    repositories: z.array(codingRepositorySchema).max(12),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.repositories.map((r) => r.repositoryId)).size ===
      s.repositories.length,
    "Select each repository only once",
  )
  .refine(
    (s) =>
      !s.enabled ||
      s.backend !== "podman" ||
      s.repositories.every((r) => r.checkCommand?.trim()),
    "Local repositories require a check command",
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
export const emptyCoding: CodingSettings = { enabled: false, repositories: [] };
export const codingInput = z
  .object({
    repositoryId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2500),
  })
  .strict();
export const codingPayload = codingInput.extend({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  githubRevision: z.number().int().nonnegative(),
  configRevision: z.number().int().positive(),
  baseBranch: branchName,
  workflowFile: codingRepositorySchema.shape.workflowFile,
  backend: z.enum(["github-actions", "podman"]).optional(),
  setupCommand: codingRepositorySchema.shape.setupCommand,
  checkCommand: codingRepositorySchema.shape.checkCommand,
});
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
  cancellationSent?: boolean;
}
export interface CodingPage {
  providerApiKeyConfigured: boolean;
  revision: number;
  settings: CodingSettings;
  repositories: { id: number; full_name: string }[];
  members: { id: string; active: boolean }[];
  tasks: CodingTask[];
}
export const codingTerminal = (state: CodingState) =>
  ["succeeded", "failed", "unknown", "cancelled"].includes(state);
