import { z } from "zod";
import type { ModelOptions } from "./agent/model-settings.ts";
import type { PluginSettings } from "./agent/plugin-config.ts";
import type { CodingConfig, CodingTask } from "./coding/config.ts";
import type { GitHubConnection } from "./github/config.ts";

export class Fault extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function requireThat(
  value: unknown,
  code: string,
  status = 400,
): asserts value {
  if (!value) throw new Fault(code, status);
}
export const userId = z.string().regex(/^[1-9]\d{0,15}$/);
export const chatId = z.string().regex(/^-?[1-9]\d{0,15}$/);
export const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, "Use an IANA timezone");
export const settingsSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    // Older clients may still send these removed controls. Discard them on save.
    const settings = { ...value } as Record<string, unknown>;
    delete settings.language;
    delete settings.maxInputChars;
    delete settings.maxOutputTokens;
    return settings;
  },
  z
    .object({
      name: z.string().trim().min(1).max(80),
      timezone,
      retentionDays: z.number().int().min(1).max(90).default(30),
      monthlyBudgetUsd: z.number().finite().min(0).default(10),
      runBudgetUsd: z.number().finite().min(0).default(0.1),
      maxTurns: z.number().int().min(1).max(20).default(3),
      missedRunMinutes: z.literal(5).default(5),
      paused: z.boolean().default(false),
    })
    .strict(),
);
export type Settings = z.infer<typeof settingsSchema>;
export const recurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(1).max(7).optional(),
    timezone,
  })
  .strict()
  .refine(
    (s) => s.frequency !== "weekly" || s.weekday !== undefined,
    "Weekly schedules need a weekday (Monday=1)",
  );
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const workflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    task: z.string().min(1).max(2000),
    chatId,
    topicId: z.number().int().nonnegative().default(0),
    recurrence: recurrenceSchema,
    format: z
      .string()
      .max(2000)
      .default("Decisions, blockers, next steps. Cite source IDs."),
    budgetUsd: z.number().min(0.001).max(5),
    skillId: z.string().min(1),
    windowDays: z.number().int().min(1).max(30).default(7),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof workflowSchema>;
export const TOOLS = [
  "query_model_cost",
  "query_chat_history",
  "read_chat_context",
  "read_instructions",
  "propose_workflow",
  "propose_instruction",
  "load_skill",
] as const;
export const skillSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,49}$/),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(12000),
    tools: z.array(z.enum(TOOLS)).max(TOOLS.length),
    settings: z
      .object({
        sections: z
          .string()
          .max(1000)
          .default("Decisions, blockers, next steps"),
        maxWords: z.number().int().min(50).max(1000).default(400),
      })
      .strict()
      .default({ sections: "Decisions, blockers, next steps", maxWords: 400 }),
  })
  .strict();
export type SkillSpec = z.infer<typeof skillSchema>;
export interface AccessRequest {
  id: string;
  actor: string;
  username?: string;
  name?: string;
  chatId: string;
  topicId?: number;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  decidedBy?: string;
}
export interface Member {
  id: string;
  username?: string;
  name?: string;
  profileUpdatedAt?: string;
  role: "owner" | "admin" | "member";
  active: boolean;
}
export interface Chat {
  id: string;
  title?: string;
  active: boolean;
  collection: boolean;
  consentBy?: string;
  consentAt?: string;
  linkedAt: string;
  visibleAll: boolean;
}
export interface ConversationThread {
  kind?: "group";
  participants?: string[];
  id: string;
  actor: string;
  chatId: string;
  botId?: string;
  topicId?: number;
  at: string;
  summary?: ConversationSummary;
  discussions?: Discussion[];
  activeDiscussionId?: string;
}
export interface MemoryReferences {
  sourceIds: string[];
  sourceHash: string;
}
export interface ConversationSummary extends MemoryReferences {
  text: string;
  version: number;
  throughRunId: string;
}
export interface Discussion extends MemoryReferences {
  id: string;
  title: string;
  summary: string;
  decisions: string[];
  todos: string[];
  relatedIds: string[];
  messageIds: string[];
  updatedAt: string;
}
export interface Source {
  threadId?: string;
  runId?: string;
  role?: "user" | "assistant";
  retentionOriginAt?: string;
  id: string;
  chatId: string;
  topicId: number;
  author: string;
  text: string;
  at: string;
  expiresAt: string;
  directed: boolean;
}
export interface Instruction {
  id: string;
  version: number;
  scope: "personal" | "workspace" | "workflow";
  workflowId?: string;
  author: string;
  body: string;
  active: boolean;
  at: string;
  provenance: string;
}
export interface Skill {
  id: string;
  version: number;
  enabled: boolean;
  archived: boolean;
  published: SkillSpec[];
  draft: SkillSpec;
  tests: { at: string; hash: string; output: string }[];
}
export interface Workflow {
  id: string;
  version: number;
  owner: string;
  status: "draft" | "active" | "paused" | "suspended" | "deleted";
  spec: WorkflowSpec;
  skillVersion: number;
  versions: { version: number; spec: WorkflowSpec; skillVersion: number }[];
  nextAt?: string;
  reason?: string;
}
export interface Approval {
  runId?: string;
  id: string;
  actor: string;
  kind:
    | "workflow"
    | "instruction"
    | "deletion"
    | "github_issue"
    | "coding_task";
  target: string;
  version: number;
  hash: string;
  payload: unknown;
  expiresAt: string;
  decision?: "approved" | "rejected" | "revoked";
  issue?: {
    state: "sending" | "created" | "failed" | "unknown";
    startedAt: string;
    url?: string;
    number?: number;
    error?: string;
  };
}
export interface Run {
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  replyTo?: number;
  conversation: string;
  threadId?: string;
  threadNotice?: string;
  replyAnchor?: number;
  followupClosed?: boolean;
  followup?: {
    anchorRunId: string;
    expiresAt: string;
    decision?: "reply" | "ignore";
    transcript: unknown[];
    references?: MemoryReferences;
  };
  contextSummary?: ConversationSummary;
  discussionUpdates?: Discussion[];
  compaction?: {
    state: "started" | "done";
    transcript: unknown[];
    summary: ConversationSummary;
    maxBytes: number;
    outputTokens: number;
  };
  status:
    | "queued"
    | "running"
    | "awaiting_approval"
    | "succeeded"
    | "partial"
    | "failed"
    | "cancelled";
  task: string;
  at: string;
  finishedAt?: string;
  workflowId?: string;
  workflowVersion?: number;
  settings: Settings;
  settingsVersion: number;
  model: string;
  modelOptions?: ModelOptions;
  extensionVersion?: string;
  skillPins: { id: string; version: number }[];
  instructions: Instruction[];
  sources: Source[];
  coverage: string;
  cancelled: boolean;
  fence: number;
  telegramDraft?: { id: number; botId: string; fence: number };
  leaseUntil?: string;
  transcript: unknown[];
  transcriptVersion: 1;
  tools: Record<
    string,
    {
      name: string;
      state: "started" | "done";
      result?: unknown;
      arguments?: Record<string, unknown>;
    }
  >;
  attempts: {
    id: string;
    reserved: number;
    actual?: number;
    purpose?: "compaction" | "followup";
    tokens?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    reconciliation?: { actor: string; reference: string; at: string };
    status: "reserved" | "settled" | "unknown";
    at: string;
  }[];
  result?: string;
  error?: string;
}
export interface Delivery {
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  replyTo?: number;
  runId?: string;
  text: string;
  format?: "markdown" | "rich";
  buttons?: { text: string; callback_data: string }[][];
  state:
    | "pending"
    | "sending"
    | "sent"
    | "failed"
    | "delivery_unknown"
    | "cancelled";
  at: string;
  startedAt?: string;
  nextAt?: string;
  remoteId?: number;
  attempts: number;
}
export interface Audit {
  id: string;
  actor: string;
  action: string;
  target: string;
  at: string;
  version?: number;
}
export interface Workspace {
  coding?: CodingConfig;
  codingTasks?: CodingTask[];
  github?: GitHubConnection;
  plugins?: PluginSettings;
  id: string;
  operatorId: string;
  version: number;
  settings: Settings;
  policy: { mode: "whitelist" | "members"; version: number; allowed: string[] };
  members: Member[];
  accessRequests?: AccessRequest[];
  chats: Chat[];
  messages: Source[];
  threads?: ConversationThread[];
  instructions: Instruction[];
  skills: Skill[];
  workflows: Workflow[];
  approvals: Approval[];
  runs: Run[];
  deliveries: Delivery[];
  audit: Audit[];
  occurrences: {
    key: string;
    workflowId: string;
    version: number;
    at: string;
    status: "queued" | "skipped";
    runId?: string;
  }[];
  tokens: {
    hash: string;
    actor: string;
    expiresAt: string;
    kind: "group" | "identity";
    adminId?: string;
  }[];
  deletion?: { requestedAt: string; purgedAt?: string; providerState: string };
}
export interface Deployment extends ModelOptions {
  version: number;
  active: boolean;
  bot?: { id: string; username: string; visibleAll: boolean };
  model: string;
  credentials: Record<string, string>;
  webhookReady: boolean;
  ownerVerified: boolean;
  paused: boolean;
}
export interface Admin {
  id: string;
  username: string;
  telegramId?: string;
  operator: boolean;
}
export interface Session {
  admin: Admin;
  csrf: string;
  expiresAt: string;
}
export const iso = () => new Date().toISOString();
