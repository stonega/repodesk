import { z } from "zod";
import {
  type CodingPayload,
  withoutRepositoryGrants,
} from "../coding/config.ts";
import type {
  DevelopmentResult,
  DevelopmentRun,
} from "../coding/development.ts";
import type { RuntimeProvider } from "../models/config.ts";
import { modelSelectionSchema } from "../models/config.ts";

export const reviewSettings = z.preprocess(
  withoutRepositoryGrants,
  z
    .object({
      enabled: z.boolean(),
      autoReview: z.boolean().default(true),
      acceptRequests: z.boolean().default(true),
      allowFixes: z.boolean().default(false),
      model: modelSelectionSchema.optional(),
    })
    .strict(),
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
export const emptyReview: ReviewSettings = {
  enabled: false,
  autoReview: true,
  acceptRequests: true,
  allowFixes: false,
};
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
  runnerModel?: RuntimeProvider;
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
  tasks: ReviewTask[];
}
