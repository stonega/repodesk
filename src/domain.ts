import { z } from "zod";
import type { ModelOptions } from "./agent/model-settings.ts";
import type { PluginSettings } from "./agent/plugin-config.ts";
import type { CodingConfig } from "./coding/config.ts";
import { currencies } from "./currency.ts";
import type { GitHubConnection } from "./github/config.ts";
import type { GitHubUserAccess } from "./github/user-access.ts";
import type { GooglePlugin, GoogleUser } from "./google/config.ts";
import type { MemoryContext, MemoryState } from "./memory/types.ts";
import type { ModelProvider, ModelSelection } from "./models/config.ts";
import type { ReviewConfig, ReviewTask } from "./review-bot/config.ts";
import type { SearchPin, SearchProvider } from "./search/config.ts";

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
    delete settings.maxTurns;
    return settings;
  },
  z
    .object({
      name: z.string().trim().min(1).max(80),
      timezone,
      currency: z.enum(currencies).default("USD"),
      retentionDays: z.number().int().min(1).max(90).default(30),
      monthlyBudgetUsd: z.number().finite().min(0).nullable().default(null),
      runBudgetUsd: z.number().finite().min(0).nullable().default(null),
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
export const repositorySourcesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    repositoryIds: z.array(z.number().int().positive().safe()).min(1).max(6),
  })
  .strict()
  .refine((s) => new Set(s.repositoryIds).size === s.repositoryIds.length);
export type RepositorySources = z.infer<typeof repositorySourcesSchema>;
export const workflowSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    // Older clients and saved workflows may still include the retired override.
    const spec = { ...value } as Record<string, unknown>;
    delete spec.budgetUsd;
    return spec;
  },
  z
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
      skillId: z.string().min(1).optional(),
      windowDays: z.number().int().min(1).max(30).default(7),
      github: repositorySourcesSchema.optional(),
    })
    .strict(),
);
export type WorkflowSpec = z.infer<typeof workflowSchema>;
export const TOOLS = [
  "read_web",
  "query_model_cost",
  "query_chat_history",
  "read_chat_context",
  "read_instructions",
  "propose_workflow",
  "propose_instruction",
  "load_skill",
  "read_skill_source",
  "propose_skill",
  "query_work_handoff",
] as const;
export const skillSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(1024),
    body: z.string().min(1).max(16384),
    tools: z.array(z.enum(TOOLS)).max(TOOLS.length),
    frontmatter: z
      .object({
        license: z.string().max(2000).optional(),
        compatibility: z.string().max(2000).optional(),
        metadata: z
          .record(z.string().max(100), z.string().max(2000))
          .optional(),
      })
      .strict()
      .optional(),
    resources: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(1000)
              .refine(
                (path) =>
                  /\.(md|txt)$/i.test(path) &&
                  !path.includes("\\") &&
                  !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
                  path
                    .split("/")
                    .every((part) => part && part !== "." && part !== ".."),
              ),
            body: z.string().max(65536),
          })
          .strict(),
      )
      .max(32)
      .optional(),
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
  github?: GitHubUserAccess;
  githubAccount?: { id: number; login: string };
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
  browserRead?: BrowserReadStamp;
  browserSealed?: string;
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
export interface Attachment {
  botId: string;
  fileId: string;
  kind: "photo" | "document" | "audio" | "video" | "voice" | "animation";
  name?: string;
  mimeType?: string;
  size?: number;
}
export interface Source {
  browserSealed?: string;
  browserRead?: BrowserReadStamp;
  attachments?: Attachment[];
  forwarded?: boolean;
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
  preset?: boolean;
  githubSource?: {
    repository: string;
    ref: string;
    path: string;
    commit: string;
    blobSha: string;
    bundleHash?: string;
    draftHash: string;
    importedAt: string;
    access: "public" | "connected";
    repositoryId?: number;
    installationId?: number;
  };
  origin?: {
    runId: string;
    actor: string;
    references: MemoryReferences;
    sharedAt: string;
    sourceRemovedAt?: string;
  };
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
  skillVersion?: number;
  versions: { version: number; spec: WorkflowSpec; skillVersion?: number }[];
  nextAt?: string;
  reason?: string;
}
export interface Approval {
  browserRead?: BrowserReadStamp;
  browserSealed?: string;
  runId?: string;
  id: string;
  actor: string;
  kind:
    | "workflow"
    | "instruction"
    | "deletion"
    | "github_issue"
    | "github_pull_request"
    | "cloudflare_action"
    | "skill";
  target: string;
  version: number;
  hash: string;
  payload: unknown;
  expiresAt: string;
  decision?: "approved" | "rejected" | "revoked";
  cloudflare?: {
    state: "sending" | "completed" | "failed" | "unknown";
    startedAt: string;
    error?: string;
  };
  issue?: {
    state: "sending" | "created" | "failed" | "unknown";
    startedAt: string;
    url?: string;
    number?: number;
    error?: string;
  };
  pullRequest?: {
    state: "sending" | "merged" | "closed" | "failed" | "unknown";
    startedAt: string;
    url?: string;
    error?: string;
  };
}
export interface BrowserReadStamp {
  owner: string;
  generation: number;
  epoch: number;
  botId: string;
}
export interface Run {
  browserSealed?: string;
  browserRead?: BrowserReadStamp;
  browserWait?: {
    toolName?: string;
    id: string;
    kind: "site" | "action" | "input" | "control";
    callId: string;
    expiresAt: number;
  };
  browserResumed?: string[];
  obsidianRead?: { generation: number };
  searchProvider?: SearchPin;
  memoryContext?: MemoryContext;
  memoryMutation?: boolean;
  repository?: { id: number; full_name: string; installationId: number };
  githubRead?: RepositorySources;
  cloudflareRead?: { revision: number; accountId: string };
  googleRead?: Partial<
    Record<GooglePlugin, { revision: number; connectionId: string }>
  >;
  searchConsoleRead?: {
    revision: number;
    connectionId?: string;
    selectionRevision?: number;
  };
  handoffRead?: {
    references: MemoryReferences;
    runIds?: string[];
    chatIds: string[];
    repositoryIds: number[];
    codingRevision?: number;
  };
  codingTaskId?: string;
  stopConfirmed?: boolean;
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  replyTo?: number;
  conversation: string;
  threadId?: string;
  threadNotice?: string;
  replyAnchor?: number;
  /** Received during generation; removed atomically with its user checkpoint. */
  pendingInputs?: { sourceId: string; task: string; messageId: number }[];
  followupClosed?: boolean;
  followup?: {
    kind?: "forward";
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
  modelProvider?: {
    id: string;
    version: number;
    operatorId: string;
    chatRevision?: number;
  };
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
    pricingUnknown?: boolean;
    purpose?:
      | "compaction"
      | "followup"
      | "memory_extract"
      | "memory_consolidate";
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
  browserRequest?: { id: string; expiresAt: number; taskId?: string };
  browserRead?: BrowserReadStamp;
  browserSealed?: string;
  /** Sets the bot's reaction on a retained user message; creates no message. */
  reaction?: { sourceId: string; messageId: number; emoji: string };
  googleControl?: {
    botId: string;
    connectionId?: string;
    flow?: { hash: string; phase: "oauth" | "confirm" };
    properties?: string;
  };
  repositoryMenu?: {
    installationId: number;
    revision: number;
    expiresAt: string;
    repositories: { id: number; full_name: string }[];
    consumed?: boolean;
  };
  /** Routine task updates share one Telegram message; each edit is a durable intent. */
  progressMessage?: { owner: "development"; id: string };
  editOf?: string;
  editUnavailable?: boolean;
  /** Stable order of a confirmed task message; text edits keep its place. */
  taskMessageSequence?: number;
  sentButtons?: Delivery["buttons"];
  taskControlsCleanup?: { taskId: string; messageId: number };
  botId?: string;
  cancellationRunId?: string;
  feedback?: {
    owner: "run" | "development";
    id: string;
    key: string;
  };
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  replyTo?: number;
  runId?: string;
  text: string;
  format?: "markdown" | "rich";
  buttons?: (
    | { text: string; callback_data: string; url?: never }
    | { text: string; url: string; callback_data?: never }
  )[][];
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
  /** Revocation counters only. Personal sites, credentials and grants live separately. */
  browserEpochs?: Record<string, number>;
  obsidian?: import("./obsidian/config.ts").VaultState;
  googleUsers?: Record<string, GoogleUser>;
  /** Panel diagnostics accounting only; conversation text is not persisted here. */
  adminChecks?: {
    id: string;
    adminId: string;
    actor: string;
    model: string;
    at: string;
    status: "running" | "succeeded" | "failed";
    attempts: Run["attempts"];
  }[];
  memory?: MemoryState;
  chatModel?: {
    revision: number;
    selection: ModelSelection;
    searchProviderId?: string;
  };
  repositorySelections?: {
    actor: string;
    chatId: string;
    topicId: number;
    botId: string;
    installationId: number;
    repositoryId: number;
    at: string;
  }[];
  reviewBot?: ReviewConfig;
  reviewTasks?: ReviewTask[];
  reviewCleanup?: string[];
  coding?: CodingConfig;
  github?: GitHubConnection;
  plugins?: PluginSettings;
  id: string;
  operatorId: string;
  version: number;
  settings: Settings;
  memberVersion: number;
  members: Member[];
  accessRequests?: AccessRequest[];
  accessLinkClaims?: {
    hash: string;
    actor: string;
    expiresAt: string;
  }[];
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
    botId?: string;
  }[];
  deletion?: {
    requestedAt: string;
    purgedAt?: string;
    deviceAuthPurgedAt?: string;
    providerState: string;
  };
}
export interface Deployment extends ModelOptions {
  searchProviders?: SearchProvider[];
  modelProviders?: ModelProvider[];
  site?: { domain: string | null; revision: number };
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
