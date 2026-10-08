import { z } from "zod";
import type { CodingPayload } from "../coding/config.ts";
import type {
  DevelopmentResult,
  DevelopmentRun,
} from "../coding/development.ts";

export const reviewRepository = z
  .object({
    repositoryId: z.number().int().positive(),
    reviewer: z.string().regex(/^[1-9]\d{0,15}$/),
    autoReview: z.boolean().default(true),
    acceptRequests: z.boolean().default(true),
    allowFixes: z.boolean().default(false),
  })
  .strict();
export const reviewSettings = z
  .object({
    enabled: z.boolean(),
    repositories: z.array(reviewRepository).max(12),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.repositories.map((r) => r.repositoryId)).size ===
      s.repositories.length,
    "Select each repository only once",
  );
export const reviewSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: reviewSettings,
  })
  .strict();
export type ReviewSettings = z.infer<typeof reviewSettings>;
export interface ReviewConfig {
  revision: number;
  settings: ReviewSettings;
}
export const emptyReview: ReviewSettings = { enabled: false, repositories: [] };
export type ReviewState =
  | "queued"
  | "starting"
  | "running"
  | "auth_required"
  | "waiting"
  | "ready"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export interface ReviewTask {
  id: string;
  key: string;
  actor: string;
  githubUserId?: number;
  payload: CodingPayload;
  reviewRevision: number;
  number: number;
  mode: "review" | "answer" | "fix";
  statusOnly?: boolean;
  automatic: boolean;
  inputs: DevelopmentRun["inputs"];
  sources: {
    id: number;
    kind: "issue" | "review";
    hash: string;
    githubId: number;
  }[];
  revision: number;
  consumedRevision: number;
  state: ReviewState;
  attemptId: string;
  attemptIds?: string[];
  previousAttemptId?: string;
  run?: DevelopmentRun;
  result?: DevelopmentResult;
  headSha?: string;
  baseSha?: string;
  publishedSha?: string;
  publicationReserved?: boolean;
  prUrl?: string;
  reviewId?: number;
  tokens?: number;
  usageUnknown?: boolean;
  error?: string;
  cancelRequested?: boolean;
  lease?: string;
  leaseUntil?: string;
  nextPollAt?: string;
  createdAt: string;
  updatedAt: string;
  progress?: {
    state: "pending" | "sending" | "sent" | "unknown";
    id?: number;
    body?: string;
  };
}
export const reviewTerminal = (state: ReviewState) =>
  ["completed", "failed", "cancelled", "unknown"].includes(state);
export interface ReviewPage {
  revision: number;
  settings: ReviewSettings;
  botHandle?: string;
  webhookUrl: string;
  webhookConfigured: boolean;
  repositories: {
    id: number;
    full_name: string;
    maintainers: { id: string; name: string }[];
  }[];
  tasks: ReviewTask[];
}
