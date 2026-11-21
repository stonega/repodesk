import type { Pool } from "pg";
import { attemptCost } from "../agent/limits.ts";
import { selectedModel } from "../agent/runtime.ts";
import type { DevelopmentTask } from "../coding/development.ts";
import type { Sql } from "../db/pool.ts";
import type { Run, Workspace } from "../domain.ts";
import type { ReviewTask } from "../review-bot/config.ts";

export const USAGE_SOURCE_KINDS = [
  "chat",
  "workflow",
  "mission",
  "compaction",
  "followup",
  "research_subagent",
  "memory_extract",
  "memory_consolidate",
  "skill_extract",
  "self_check",
  "coding_task",
  "coding_conversation",
  "review_bot",
] as const;

export type UsageSourceKind = (typeof USAGE_SOURCE_KINDS)[number];

export const USAGE_SOURCE_LABELS: Record<UsageSourceKind, string> = {
  chat: "Chat",
  workflow: "Workflow",
  mission: "Mission",
  compaction: "Compaction",
  followup: "Follow-up",
  research_subagent: "Research subagent",
  memory_extract: "Memory extract",
  memory_consolidate: "Memory consolidate",
  skill_extract: "Skill extract",
  self_check: "Admin self-check",
  coding_task: "Codex task",
  coding_conversation: "Codex Q&A",
  review_bot: "Review Bot",
};

export interface TokenUsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  total?: number;
}

export interface ModelUsageEvent {
  workspaceId: string;
  id: string;
  recordedAt: string;
  sourceKind: UsageSourceKind;
  sourceId: string;
  sourceLabel: string;
  sourcePath?: string;
  actor: string;
  providerId?: string;
  providerName: string;
  model: string;
  status: "settled" | "reserved" | "unknown" | "failed";
  stopReason?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedInputTokens?: number;
  tokenBreakdownKnown: boolean;
  reservedUsd: number;
  actualUsd?: number;
  accountedUsd: number;
  pricingUnknown: boolean;
  latencyMs?: number;
  toolCalls: number;
  metadata: Record<string, unknown>;
}

export type UsageRange = "24h" | "7d" | "30d" | "90d" | "all";

export interface ModelUsageQuery {
  range: UsageRange;
  source?: UsageSourceKind;
  model?: string;
  status?: "settled" | "reserved" | "unknown" | "failed";
  actor?: string;
  offset: number;
  limit: number;
}

function safeHost(baseUrl?: string): string {
  if (!baseUrl) return "Deployment default";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

export function resolveProviderLabel(
  providerName?: string,
  baseUrl?: string,
  authMode?: string,
): string {
  if (providerName?.trim()) return providerName.trim();
  if (baseUrl?.trim()) return safeHost(baseUrl.trim());
  if (authMode === "chatgpt") return "Codex ChatGPT";
  return "Deployment default";
}

export function deriveRunAttemptUsageEvent(
  w: Workspace,
  run: Run,
  attempt: Run["attempts"][number],
): ModelUsageEvent {
  const purpose = attempt.purpose;
  const sourceKind: UsageSourceKind =
    purpose === "compaction" ||
    purpose === "followup" ||
    purpose === "memory_extract" ||
    purpose === "memory_consolidate" ||
    purpose === "skill_extract" ||
    purpose === "research_subagent"
      ? purpose
      : run.workflowId
        ? "workflow"
        : run.triggerKind === "mission_wakeup" || run.missionId
          ? "mission"
          : "chat";

  const workflow = run.workflowId
    ? w.workflows.find((f) => f.id === run.workflowId)
    : undefined;
  const chat =
    run.chatId !== run.actor
      ? w.chats.find((c) => c.id === run.chatId)
      : undefined;

  let sourceLabel: string;
  if (purpose === "compaction") sourceLabel = "Context compaction";
  else if (purpose === "followup") sourceLabel = "Follow-up classifier";
  else if (purpose === "memory_extract") sourceLabel = "Memory extraction";
  else if (purpose === "memory_consolidate")
    sourceLabel = "Memory consolidation";
  else if (purpose === "skill_extract") sourceLabel = "Skill extraction";
  else if (purpose === "research_subagent") sourceLabel = "Research subagent";
  else if (run.workflowId)
    sourceLabel = workflow
      ? `Workflow · ${workflow.spec.name}`
      : `Workflow · ${run.workflowId}`;
  else if (run.missionId)
    sourceLabel = `Mission · ${run.missionId.slice(0, 8)}`;
  else if (run.chatId === run.actor) sourceLabel = "Private chat";
  else
    sourceLabel = chat?.title
      ? `Group · ${chat.title}`
      : `Group · ${run.chatId}`;

  const tokens = attempt.tokens;
  const inputTokens = Math.max(0, Math.trunc(tokens?.input ?? 0));
  const outputTokens = Math.max(0, Math.trunc(tokens?.output ?? 0));
  const cacheReadTokens = Math.max(0, Math.trunc(tokens?.cacheRead ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(tokens?.cacheWrite ?? 0));
  const reasoningTokens = Math.max(0, Math.trunc(tokens?.reasoning ?? 0));
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  return {
    workspaceId: w.id,
    id: `run:${run.id}:${attempt.id}`,
    recordedAt: attempt.at || run.at || new Date().toISOString(),
    sourceKind,
    sourceId: run.id,
    sourceLabel,
    sourcePath: `/admin/runs/${encodeURIComponent(run.id)}`,
    actor: run.actor ?? "",
    providerId: attempt.providerId ?? run.modelProvider?.id,
    providerName: resolveProviderLabel(
      attempt.providerName,
      run.modelOptions?.modelBaseUrl,
    ),
    model: attempt.model || run.model || "unknown",
    status: attempt.status,
    stopReason: attempt.stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    estimatedInputTokens: attempt.estimatedInputTokens,
    tokenBreakdownKnown: tokens !== undefined,
    reservedUsd: attempt.reserved ?? 0,
    actualUsd: attempt.actual,
    accountedUsd: attemptCost(attempt),
    pricingUnknown: !!attempt.pricingUnknown,
    latencyMs: attempt.latencyMs,
    toolCalls: attempt.toolCalls ?? 0,
    metadata: {
      runId: run.id,
      attemptId: attempt.id,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.workflowId ? { workflowId: run.workflowId } : {}),
      ...(workflow ? { workflowName: workflow.spec.name } : {}),
      ...(run.missionId ? { missionId: run.missionId } : {}),
      ...(purpose ? { purpose } : {}),
      ...(attempt.reconciliation ? { reconciled: true } : {}),
      chatScope: run.chatId === run.actor ? "private" : "group",
    },
  };
}

export function deriveAdminCheckUsageEvent(
  w: Workspace,
  check: NonNullable<Workspace["adminChecks"]>[number],
  attempt: Run["attempts"][number],
): ModelUsageEvent {
  const tokens = attempt.tokens;
  const inputTokens = Math.max(0, Math.trunc(tokens?.input ?? 0));
  const outputTokens = Math.max(0, Math.trunc(tokens?.output ?? 0));
  const cacheReadTokens = Math.max(0, Math.trunc(tokens?.cacheRead ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(tokens?.cacheWrite ?? 0));
  const reasoningTokens = Math.max(0, Math.trunc(tokens?.reasoning ?? 0));
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  return {
    workspaceId: w.id,
    id: `self_check:${check.id}:${attempt.id}`,
    recordedAt: attempt.at || check.at || new Date().toISOString(),
    sourceKind: "self_check",
    sourceId: check.id,
    sourceLabel: "Admin self-check",
    actor: check.actor || check.adminId || "",
    providerId: attempt.providerId ?? check.providerId,
    providerName: resolveProviderLabel(
      attempt.providerName ?? check.providerName,
    ),
    model: attempt.model || check.model || "unknown",
    status: attempt.status,
    stopReason: attempt.stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    estimatedInputTokens: attempt.estimatedInputTokens,
    tokenBreakdownKnown: tokens !== undefined,
    reservedUsd: attempt.reserved ?? 0,
    actualUsd: attempt.actual,
    accountedUsd: attemptCost(attempt),
    pricingUnknown: !!attempt.pricingUnknown,
    latencyMs: attempt.latencyMs,
    toolCalls: attempt.toolCalls ?? 0,
    metadata: {
      checkId: check.id,
      adminId: check.adminId,
      attemptId: attempt.id,
      chatScope: "admin",
    },
  };
}

export function estimateTokenBreakdownCostUsd(
  modelId: string,
  breakdown?: TokenUsageBreakdown,
): { costUsd?: number; pricingUnknown: boolean } {
  if (!breakdown) return { pricingUnknown: true };
  try {
    const info = selectedModel(modelId);
    if (!info.pricingKnown) return { pricingUnknown: true };
    const costUsd =
      (breakdown.input * info.cost.input +
        breakdown.cacheRead * info.cost.cacheRead +
        breakdown.cacheWrite * info.cost.cacheWrite +
        breakdown.output * info.cost.output) /
      1_000_000;
    return { costUsd: Math.max(0, costUsd), pricingUnknown: false };
  } catch {
    return { pricingUnknown: true };
  }
}

export function deriveCodingUsageEvent(params: {
  task: DevelopmentTask;
  attemptId: string;
  kind: "coding_task" | "coding_conversation";
  status: "settled" | "unknown" | "failed";
  tokens?: number;
  tokenUsage?: TokenUsageBreakdown;
  usageUnknown?: boolean;
  latencyMs?: number;
  recordedAt?: string;
}): ModelUsageEvent {
  const { task, attemptId, kind, status, tokens, tokenUsage, usageUnknown } =
    params;
  const model = task.runnerModel?.model || "codex";
  const providerName = resolveProviderLabel(
    task.runnerModel?.name,
    task.runnerModel?.baseUrl,
    task.payload.authMode,
  );
  const breakdownKnown = tokenUsage !== undefined;
  const inputTokens = Math.max(0, Math.trunc(tokenUsage?.input ?? 0));
  const outputTokens = Math.max(0, Math.trunc(tokenUsage?.output ?? 0));
  const cacheReadTokens = Math.max(0, Math.trunc(tokenUsage?.cacheRead ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(tokenUsage?.cacheWrite ?? 0));
  const reasoningTokens = Math.max(0, Math.trunc(tokenUsage?.reasoning ?? 0));
  const totalTokens = Math.max(
    0,
    Math.trunc(
      tokens ??
        tokenUsage?.total ??
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ),
  );
  const priced =
    task.payload.authMode === "provider_key" && breakdownKnown
      ? estimateTokenBreakdownCostUsd(model, tokenUsage)
      : { costUsd: undefined, pricingUnknown: true };

  return {
    workspaceId: task.workspaceId,
    id: `coding:${task.id}:${attemptId}`,
    recordedAt: params.recordedAt ?? new Date().toISOString(),
    sourceKind: kind,
    sourceId: task.id,
    sourceLabel: `${kind === "coding_conversation" ? "Codex Q&A" : "Codex"} · ${task.payload.repository}`,
    sourcePath: "/admin/plugins/codex",
    actor: task.actor ?? "",
    providerId: task.runnerModel?.id,
    providerName,
    model,
    status,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    tokenBreakdownKnown: breakdownKnown,
    reservedUsd: 0,
    actualUsd: priced.costUsd,
    accountedUsd: priced.costUsd ?? 0,
    pricingUnknown: priced.pricingUnknown,
    latencyMs: params.latencyMs,
    toolCalls: 0,
    metadata: {
      taskId: task.id,
      attemptId,
      repository: task.payload.repository,
      phase: task.phase,
      usageUnknown: !!usageUnknown,
      authMode: task.payload.authMode,
    },
  };
}

export function deriveReviewBotUsageEvent(
  w: Workspace,
  task: ReviewTask,
): ModelUsageEvent | undefined {
  const breakdown = task.tokenUsage;
  if (task.tokens === undefined && !breakdown) return undefined;
  const model = task.runnerModel?.model || "codex";
  const providerName = resolveProviderLabel(
    task.runnerModel?.name,
    task.runnerModel?.baseUrl,
    task.payload.authMode,
  );
  const breakdownKnown = breakdown !== undefined;
  const inputTokens = Math.max(0, Math.trunc(breakdown?.input ?? 0));
  const outputTokens = Math.max(0, Math.trunc(breakdown?.output ?? 0));
  const cacheReadTokens = Math.max(0, Math.trunc(breakdown?.cacheRead ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(breakdown?.cacheWrite ?? 0));
  const reasoningTokens = Math.max(0, Math.trunc(breakdown?.reasoning ?? 0));
  const totalTokens = Math.max(
    0,
    Math.trunc(
      task.tokens ??
        breakdown?.total ??
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ),
  );
  const priced =
    task.payload.authMode === "provider_key" && breakdownKnown
      ? estimateTokenBreakdownCostUsd(model, breakdown)
      : { costUsd: undefined, pricingUnknown: true };

  const status: ModelUsageEvent["status"] =
    task.state === "completed"
      ? "settled"
      : task.state === "failed" || task.state === "cancelled"
        ? "failed"
        : task.state === "unknown"
          ? "unknown"
          : "reserved";

  return {
    workspaceId: w.id,
    id: `review:${task.id}:${task.attemptId}`,
    recordedAt: task.updatedAt || task.createdAt || new Date().toISOString(),
    sourceKind: "review_bot",
    sourceId: task.id,
    sourceLabel: `Review Bot · ${task.payload.repository} #${task.number}`,
    sourcePath: "/admin/plugins/review-bot",
    actor: task.actor ?? "",
    providerId: task.runnerModel?.id,
    providerName,
    model,
    status,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    tokenBreakdownKnown: breakdownKnown,
    reservedUsd: 0,
    actualUsd: priced.costUsd,
    accountedUsd: priced.costUsd ?? 0,
    pricingUnknown: priced.pricingUnknown,
    toolCalls: 0,
    metadata: {
      reviewTaskId: task.id,
      attemptId: task.attemptId,
      repository: task.payload.repository,
      prNumber: task.number,
      mode: task.mode,
      usageUnknown: !!task.usageUnknown,
      chatScope: "github",
    },
  };
}

export async function upsertModelUsageEvents(
  sql: Sql,
  events: readonly ModelUsageEvent[],
): Promise<void> {
  if (!events.length) return;
  // Deduplicate by (workspaceId, id) keeping the latest entry.
  const map = new Map<string, ModelUsageEvent>();
  for (const event of events) {
    map.set(`${event.workspaceId}\0${event.id}`, event);
  }
  const unique = [...map.values()];
  await sql.query(
    `INSERT INTO model_usage_events (
      workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
      actor, provider_id, provider_name, model, status, stop_reason,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      estimated_input_tokens, token_breakdown_known,
      reserved_usd, actual_usd, accounted_usd, pricing_unknown,
      latency_ms, tool_calls, metadata
    )
    SELECT
      u.workspace_id, u.id, u.recorded_at, u.source_kind, u.source_id, u.source_label, u.source_path,
      u.actor, u.provider_id, u.provider_name, u.model, u.status, u.stop_reason,
      u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens, u.total_tokens,
      u.estimated_input_tokens, u.token_breakdown_known,
      u.reserved_usd, u.actual_usd, u.accounted_usd, u.pricing_unknown,
      u.latency_ms, u.tool_calls, u.metadata
    FROM UNNEST(
      $1::uuid[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[],
      $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[],
      $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::bigint[], $19::bigint[],
      $20::bigint[], $21::boolean[],
      $22::double precision[], $23::double precision[], $24::double precision[], $25::boolean[],
      $26::integer[], $27::integer[], $28::jsonb[]
    ) AS u(
      workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
      actor, provider_id, provider_name, model, status, stop_reason,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      estimated_input_tokens, token_breakdown_known,
      reserved_usd, actual_usd, accounted_usd, pricing_unknown,
      latency_ms, tool_calls, metadata
    )
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      recorded_at = excluded.recorded_at,
      source_kind = excluded.source_kind,
      source_id = excluded.source_id,
      source_label = excluded.source_label,
      source_path = excluded.source_path,
      actor = excluded.actor,
      provider_id = COALESCE(excluded.provider_id, model_usage_events.provider_id),
      provider_name = CASE WHEN excluded.provider_name <> '' THEN excluded.provider_name ELSE model_usage_events.provider_name END,
      model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE model_usage_events.model END,
      status = excluded.status,
      stop_reason = COALESCE(excluded.stop_reason, model_usage_events.stop_reason),
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens = excluded.total_tokens,
      estimated_input_tokens = COALESCE(excluded.estimated_input_tokens, model_usage_events.estimated_input_tokens),
      token_breakdown_known = excluded.token_breakdown_known OR model_usage_events.token_breakdown_known,
      reserved_usd = excluded.reserved_usd,
      actual_usd = excluded.actual_usd,
      accounted_usd = excluded.accounted_usd,
      pricing_unknown = excluded.pricing_unknown,
      latency_ms = COALESCE(excluded.latency_ms, model_usage_events.latency_ms),
      tool_calls = GREATEST(excluded.tool_calls, model_usage_events.tool_calls),
      metadata = model_usage_events.metadata || excluded.metadata`,
    [
      unique.map((e) => e.workspaceId),
      unique.map((e) => e.id),
      unique.map((e) => e.recordedAt),
      unique.map((e) => e.sourceKind),
      unique.map((e) => e.sourceId),
      unique.map((e) => e.sourceLabel),
      unique.map((e) => e.sourcePath ?? null),
      unique.map((e) => e.actor),
      unique.map((e) => e.providerId ?? null),
      unique.map((e) => e.providerName),
      unique.map((e) => e.model),
      unique.map((e) => e.status),
      unique.map((e) => e.stopReason ?? null),
      unique.map((e) => e.inputTokens),
      unique.map((e) => e.outputTokens),
      unique.map((e) => e.cacheReadTokens),
      unique.map((e) => e.cacheWriteTokens),
      unique.map((e) => e.reasoningTokens),
      unique.map((e) => e.totalTokens),
      unique.map((e) => e.estimatedInputTokens ?? null),
      unique.map((e) => e.tokenBreakdownKnown),
      unique.map((e) => e.reservedUsd),
      unique.map((e) => e.actualUsd ?? null),
      unique.map((e) => e.accountedUsd),
      unique.map((e) => e.pricingUnknown),
      unique.map((e) => e.latencyMs ?? null),
      unique.map((e) => e.toolCalls),
      unique.map((e) => JSON.stringify(e.metadata)),
    ],
  );
}

/**
 * Syncs changed workspace runs, adminChecks, and reviewTasks into the durable
 * `model_usage_events` ledger inside the same transaction as `Store.save`.
 */
export async function syncWorkspaceUsageLedger(
  sql: Sql,
  workspace: Workspace,
  changedRuns: readonly Run[],
  coreChanged: boolean,
): Promise<void> {
  if (workspace.deletion) {
    await sql.query("DELETE FROM model_usage_events WHERE workspace_id=$1", [
      workspace.id,
    ]);
    return;
  }
  const events: ModelUsageEvent[] = [];
  for (const run of changedRuns) {
    for (const attempt of run.attempts) {
      events.push(deriveRunAttemptUsageEvent(workspace, run, attempt));
    }
  }
  if (coreChanged) {
    for (const check of workspace.adminChecks ?? []) {
      for (const attempt of check.attempts) {
        events.push(deriveAdminCheckUsageEvent(workspace, check, attempt));
      }
    }
    for (const reviewTask of workspace.reviewTasks ?? []) {
      const ev = deriveReviewBotUsageEvent(workspace, reviewTask);
      if (ev) events.push(ev);
    }
  }
  if (events.length) {
    await upsertModelUsageEvents(sql, events);
  }
}

export interface ModelUsageSeriesPoint {
  bucket: string;
  label: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  accountedUsd: number;
  cacheHitRate: number | null;
}

export interface ModelUsageGroupSummary {
  key: string;
  label: string;
  sublabel?: string;
  calls: number;
  settledCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  accountedUsd: number;
  cacheHitRate: number | null;
  avgLatencyMs: number | null;
  shareOfTokens: number;
}

export interface ModelUsageLedgerItem {
  id: string;
  recordedAt: string;
  sourceKind: UsageSourceKind;
  sourceKindLabel: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string | null;
  actor: string;
  actorLabel: string;
  providerId: string | null;
  providerName: string;
  model: string;
  status: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedInputTokens: number | null;
  tokenBreakdownKnown: boolean;
  cacheHitRate: number | null;
  reservedUsd: number;
  actualUsd: number | null;
  accountedUsd: number;
  pricingUnknown: boolean;
  latencyMs: number | null;
  toolCalls: number;
  metadata: Record<string, unknown>;
}

export interface ModelUsageAnalyticsResponse {
  range: UsageRange;
  granularity: "hour" | "day";
  from: string | null;
  to: string;
  budget: {
    monthlyLimitUsd: number | null;
    monthAccountedUsd: number;
    utilizationRate: number | null;
  };
  summary: {
    calls: number;
    settledCalls: number;
    reservedCalls: number;
    unknownCalls: number;
    failedCalls: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalInputTokens: number;
    totalTokens: number;
    cacheHitRate: number | null;
    estimatedCacheSavingsUsd: number;
    accountedUsd: number;
    settledUsd: number;
    reservedUsd: number;
    unpricedCalls: number;
    breakdownKnownCalls: number;
    avgTokensPerCall: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    totalToolCalls: number;
    estimatorSampleCount: number;
    avgActualToEstimatedRatio: number | null;
    stopReasons: { reason: string; count: number }[];
  };
  timeseries: ModelUsageSeriesPoint[];
  bySource: ModelUsageGroupSummary[];
  byModel: ModelUsageGroupSummary[];
  byActor: ModelUsageGroupSummary[];
  filters: {
    models: string[];
    sources: { key: UsageSourceKind; label: string }[];
  };
  items: ModelUsageLedgerItem[];
  total: number;
  offset: number;
  limit: number;
}

function rangeBounds(range: UsageRange, now: Date) {
  const to = new Date(now.getTime());
  if (range === "all") return { from: null, to, granularity: "day" as const };
  const hours =
    range === "24h"
      ? 24
      : range === "7d"
        ? 7 * 24
        : range === "30d"
          ? 30 * 24
          : 90 * 24;
  const from = new Date(to.getTime() - hours * 3600_000);
  return {
    from,
    to,
    granularity: range === "24h" ? ("hour" as const) : ("day" as const),
  };
}

function bucketIso(date: Date, granularity: "hour" | "day"): string {
  const copy = new Date(date.getTime());
  copy.setUTCMinutes(0, 0, 0);
  if (granularity === "day") copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

function bucketLabel(iso: string, granularity: "hour" | "day"): string {
  const d = new Date(iso);
  if (granularity === "hour") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  }
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function buildContinuousBuckets(
  rows: Map<string, ModelUsageSeriesPoint>,
  from: Date | null,
  to: Date,
  granularity: "hour" | "day",
): ModelUsageSeriesPoint[] {
  const stepMs = granularity === "hour" ? 3600_000 : 86400_000;
  let startMs: number;
  if (from) {
    startMs = Date.parse(bucketIso(from, granularity));
  } else if (rows.size > 0) {
    startMs = Math.min(...[...rows.keys()].map((k) => Date.parse(k)));
  } else {
    startMs = Date.parse(
      bucketIso(new Date(to.getTime() - 13 * 86400_000), "day"),
    );
  }
  const endMs = Date.parse(bucketIso(to, granularity));
  // Cap continuous buckets to at most 180 points for "all" range readability.
  const maxBuckets = 180;
  const effectiveStart = Math.max(startMs, endMs - (maxBuckets - 1) * stepMs);
  const out: ModelUsageSeriesPoint[] = [];
  for (let ts = effectiveStart; ts <= endMs; ts += stepMs) {
    const key = new Date(ts).toISOString();
    const existing = rows.get(key);
    out.push(
      existing ?? {
        bucket: key,
        label: bucketLabel(key, granularity),
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        accountedUsd: 0,
        cacheHitRate: null,
      },
    );
  }
  return out;
}

export async function queryModelUsageAnalytics(
  pool: Pool,
  workspace: Workspace,
  query: ModelUsageQuery,
  operatorOnly = false,
  now = new Date(),
): Promise<ModelUsageAnalyticsResponse> {
  const { from, to, granularity } = rangeBounds(query.range, now);
  const clauses: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspace.id];
  const push = (val: unknown) => {
    params.push(val);
    return `$${params.length}`;
  };

  if (from) clauses.push(`recorded_at >= ${push(from.toISOString())}`);
  if (query.source) clauses.push(`source_kind = ${push(query.source)}`);
  if (query.model) clauses.push(`model = ${push(query.model)}`);
  if (query.status) clauses.push(`status = ${push(query.status)}`);
  if (query.actor) clauses.push(`actor = ${push(query.actor)}`);

  const where = clauses.join(" AND ");
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  const [
    summaryRes,
    stopReasonRes,
    seriesRes,
    bySourceRes,
    byModelRes,
    byActorRes,
    filtersRes,
    monthBudgetRes,
    itemsRes,
  ] = await Promise.all([
    pool.query<{
      calls: string;
      settled_calls: string;
      reserved_calls: string;
      unknown_calls: string;
      failed_calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
      settled_usd: string;
      reserved_usd: string;
      unpriced_calls: string;
      breakdown_known_calls: string;
      avg_latency_ms: string | null;
      p95_latency_ms: string | null;
      total_tool_calls: string;
      estimator_samples: string;
      avg_est_ratio: string | null;
    }>(
      `SELECT
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_calls,
        COUNT(*) FILTER (WHERE status = 'reserved')::text AS reserved_calls,
        COUNT(*) FILTER (WHERE status = 'unknown')::text AS unknown_calls,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_calls,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(accounted_usd), 0)::text AS accounted_usd,
        COALESCE(SUM(CASE WHEN status = 'settled' THEN accounted_usd ELSE 0 END), 0)::text AS settled_usd,
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'unknown') THEN accounted_usd ELSE 0 END), 0)::text AS reserved_usd,
        COUNT(*) FILTER (WHERE pricing_unknown AND actual_usd IS NULL)::text AS unpriced_calls,
        COUNT(*) FILTER (WHERE token_breakdown_known)::text AS breakdown_known_calls,
        AVG(latency_ms)::text AS avg_latency_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL)::text AS p95_latency_ms,
        COALESCE(SUM(tool_calls), 0)::text AS total_tool_calls,
        COUNT(*) FILTER (WHERE estimated_input_tokens IS NOT NULL AND estimated_input_tokens > 0 AND token_breakdown_known AND (input_tokens + cache_read_tokens + cache_write_tokens) > 0)::text AS estimator_samples,
        AVG((input_tokens + cache_read_tokens + cache_write_tokens)::double precision / NULLIF(estimated_input_tokens, 0)) FILTER (WHERE estimated_input_tokens IS NOT NULL AND estimated_input_tokens > 0 AND token_breakdown_known AND (input_tokens + cache_read_tokens + cache_write_tokens) > 0)::text AS avg_est_ratio
      FROM model_usage_events
      WHERE ${where}`,
      params,
    ),
    pool.query<{ reason: string; count: string }>(
      `SELECT COALESCE(NULLIF(stop_reason, ''), 'unspecified') AS reason, COUNT(*)::text AS count
       FROM model_usage_events
       WHERE ${where}
       GROUP BY 1
       ORDER BY COUNT(*) DESC, 1 ASC`,
      params,
    ),
    pool.query<{
      bucket: Date;
      calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
    }>(
      `SELECT
        date_trunc('${granularity}', recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
        COUNT(*)::text AS calls,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(accounted_usd), 0)::text AS accounted_usd
      FROM model_usage_events
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC`,
      params,
    ),
    pool.query<{
      key: UsageSourceKind;
      calls: string;
      settled_calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
      avg_latency_ms: string | null;
    }>(
      `SELECT
        source_kind AS key,
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_calls,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(accounted_usd), 0)::text AS accounted_usd,
        AVG(latency_ms)::text AS avg_latency_ms
      FROM model_usage_events
      WHERE ${where}
      GROUP BY source_kind
      ORDER BY SUM(total_tokens) DESC, COUNT(*) DESC`,
      params,
    ),
    pool.query<{
      model: string;
      provider_name: string;
      calls: string;
      settled_calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
      avg_latency_ms: string | null;
    }>(
      `SELECT
        model,
        COALESCE(MAX(NULLIF(provider_name, '')), 'Deployment default') AS provider_name,
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_calls,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(accounted_usd), 0)::text AS accounted_usd,
        AVG(latency_ms)::text AS avg_latency_ms
      FROM model_usage_events
      WHERE ${where}
      GROUP BY model
      ORDER BY SUM(total_tokens) DESC, COUNT(*) DESC`,
      params,
    ),
    pool.query<{
      actor: string;
      calls: string;
      settled_calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
      avg_latency_ms: string | null;
    }>(
      `SELECT
        COALESCE(NULLIF(actor, ''), 'system') AS actor,
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_calls,
        COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(accounted_usd), 0)::text AS accounted_usd,
        AVG(latency_ms)::text AS avg_latency_ms
      FROM model_usage_events
      WHERE ${where}
      GROUP BY 1
      ORDER BY SUM(total_tokens) DESC, COUNT(*) DESC
      LIMIT 20`,
      params,
    ),
    pool.query<{ models: string[]; sources: UsageSourceKind[] }>(
      `SELECT
        COALESCE(ARRAY(SELECT DISTINCT model FROM model_usage_events WHERE workspace_id = $1 AND model <> '' ORDER BY model), ARRAY[]::text[]) AS models,
        COALESCE(ARRAY(SELECT DISTINCT source_kind FROM model_usage_events WHERE workspace_id = $1 ORDER BY source_kind), ARRAY[]::text[]) AS sources`,
      [workspace.id],
    ),
    pool.query<{ month_usd: string }>(
      `SELECT COALESCE(SUM(accounted_usd), 0)::text AS month_usd
       FROM model_usage_events
       WHERE workspace_id = $1 AND recorded_at >= $2`,
      [workspace.id, monthStart],
    ),
    pool.query<{
      id: string;
      recorded_at: Date;
      source_kind: UsageSourceKind;
      source_id: string;
      source_label: string;
      source_path: string | null;
      actor: string;
      provider_id: string | null;
      provider_name: string;
      model: string;
      status: string;
      stop_reason: string | null;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      estimated_input_tokens: string | null;
      token_breakdown_known: boolean;
      reserved_usd: number;
      actual_usd: number | null;
      accounted_usd: number;
      pricing_unknown: boolean;
      latency_ms: number | null;
      tool_calls: number;
      metadata: Record<string, unknown>;
    }>(
      `SELECT *
       FROM model_usage_events
       WHERE ${where}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, query.offset],
    ),
  ]);

  const memberLabels = new Map<string, string>();
  for (const member of workspace.members) {
    const label = member.username
      ? `@${member.username}`
      : member.name || member.id;
    memberLabels.set(member.id, label);
  }
  const formatActor = (actor: string) =>
    memberLabels.get(actor) ?? (actor === "system" ? "System" : actor);

  const s = summaryRes.rows[0];
  const calls = Number(s?.calls ?? 0);
  const inputTokens = Number(s?.input_tokens ?? 0);
  const cacheReadTokens = Number(s?.cache_read_tokens ?? 0);
  const cacheWriteTokens = Number(s?.cache_write_tokens ?? 0);
  const outputTokens = Number(s?.output_tokens ?? 0);
  const reasoningTokens = Number(s?.reasoning_tokens ?? 0);
  const totalTokens = Number(s?.total_tokens ?? 0);
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;

  // Estimate cache USD savings across models using catalog/configured price delta (input - cacheRead).
  let estimatedCacheSavingsUsd = 0;
  for (const row of byModelRes.rows) {
    const cached = Number(row.cache_read_tokens);
    if (cached <= 0) continue;
    try {
      const info = selectedModel(row.model);
      if (info.pricingKnown && info.cost.input > info.cost.cacheRead) {
        estimatedCacheSavingsUsd +=
          (cached * (info.cost.input - info.cost.cacheRead)) / 1_000_000;
      }
    } catch {
      /* ignore unknown model pricing */
    }
  }

  const seriesMap = new Map<string, ModelUsageSeriesPoint>();
  for (const row of seriesRes.rows) {
    const iso = bucketIso(new Date(row.bucket), granularity);
    const rInput = Number(row.input_tokens);
    const rCacheRead = Number(row.cache_read_tokens);
    const rCacheWrite = Number(row.cache_write_tokens);
    const rAllInput = rInput + rCacheRead + rCacheWrite;
    seriesMap.set(iso, {
      bucket: iso,
      label: bucketLabel(iso, granularity),
      calls: Number(row.calls),
      inputTokens: rInput,
      cacheReadTokens: rCacheRead,
      cacheWriteTokens: rCacheWrite,
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      totalTokens: Number(row.total_tokens),
      accountedUsd: Number(row.accounted_usd),
      cacheHitRate: rAllInput > 0 ? rCacheRead / rAllInput : null,
    });
  }

  const mapGroup = (
    row: {
      calls: string;
      settled_calls: string;
      input_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      total_tokens: string;
      accounted_usd: string;
      avg_latency_ms: string | null;
    },
    key: string,
    label: string,
    sublabel?: string,
  ): ModelUsageGroupSummary => {
    const gIn = Number(row.input_tokens);
    const gCr = Number(row.cache_read_tokens);
    const gCw = Number(row.cache_write_tokens);
    const gAllIn = gIn + gCr + gCw;
    const gTotal = Number(row.total_tokens);
    return {
      key,
      label,
      ...(sublabel ? { sublabel } : {}),
      calls: Number(row.calls),
      settledCalls: Number(row.settled_calls),
      inputTokens: gIn,
      cacheReadTokens: gCr,
      cacheWriteTokens: gCw,
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      totalTokens: gTotal,
      accountedUsd: Number(row.accounted_usd),
      cacheHitRate: gAllIn > 0 ? gCr / gAllIn : null,
      avgLatencyMs:
        row.avg_latency_ms !== null
          ? Math.round(Number(row.avg_latency_ms))
          : null,
      shareOfTokens: totalTokens > 0 ? gTotal / totalTokens : 0,
    };
  };

  const monthAccountedUsd = Number(monthBudgetRes.rows[0]?.month_usd ?? 0);
  const monthlyLimitUsd = workspace.settings.monthlyBudgetUsd;

  return {
    range: query.range,
    granularity,
    from: from?.toISOString() ?? null,
    to: to.toISOString(),
    budget: {
      monthlyLimitUsd,
      monthAccountedUsd,
      utilizationRate:
        monthlyLimitUsd !== null && monthlyLimitUsd > 0
          ? monthAccountedUsd / monthlyLimitUsd
          : null,
    },
    summary: {
      calls,
      settledCalls: Number(s?.settled_calls ?? 0),
      reservedCalls: Number(s?.reserved_calls ?? 0),
      unknownCalls: Number(s?.unknown_calls ?? 0),
      failedCalls: Number(s?.failed_calls ?? 0),
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalInputTokens,
      totalTokens,
      cacheHitRate:
        totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : null,
      estimatedCacheSavingsUsd,
      accountedUsd: Number(s?.accounted_usd ?? 0),
      settledUsd: Number(s?.settled_usd ?? 0),
      reservedUsd: Number(s?.reserved_usd ?? 0),
      unpricedCalls: Number(s?.unpriced_calls ?? 0),
      breakdownKnownCalls: Number(s?.breakdown_known_calls ?? 0),
      avgTokensPerCall: calls > 0 ? Math.round(totalTokens / calls) : 0,
      avgLatencyMs:
        s?.avg_latency_ms !== null && s?.avg_latency_ms !== undefined
          ? Math.round(Number(s.avg_latency_ms))
          : null,
      p95LatencyMs:
        s?.p95_latency_ms !== null && s?.p95_latency_ms !== undefined
          ? Math.round(Number(s.p95_latency_ms))
          : null,
      totalToolCalls: Number(s?.total_tool_calls ?? 0),
      estimatorSampleCount: Number(s?.estimator_samples ?? 0),
      avgActualToEstimatedRatio:
        s?.avg_est_ratio !== null && s?.avg_est_ratio !== undefined
          ? Number(s.avg_est_ratio)
          : null,
      stopReasons: stopReasonRes.rows.map((r) => ({
        reason: r.reason,
        count: Number(r.count),
      })),
    },
    timeseries: buildContinuousBuckets(seriesMap, from, to, granularity),
    bySource: bySourceRes.rows.map((r) =>
      mapGroup(r, r.key, USAGE_SOURCE_LABELS[r.key] ?? r.key),
    ),
    byModel: byModelRes.rows.map((r) =>
      mapGroup(r, r.model, r.model, r.provider_name),
    ),
    byActor: byActorRes.rows.map((r) =>
      mapGroup(r, r.actor, formatActor(r.actor)),
    ),
    filters: {
      models: filtersRes.rows[0]?.models ?? [],
      sources: (filtersRes.rows[0]?.sources ?? []).map((key) => ({
        key,
        label: USAGE_SOURCE_LABELS[key] ?? key,
      })),
    },
    items: itemsRes.rows.map((row) => {
      const iIn = Number(row.input_tokens);
      const iCr = Number(row.cache_read_tokens);
      const iCw = Number(row.cache_write_tokens);
      const iAllIn = iIn + iCr + iCw;
      const isPrivateChat =
        operatorOnly &&
        row.metadata?.chatScope === "private" &&
        row.source_kind === "chat";
      return {
        id: row.id,
        recordedAt: new Date(row.recorded_at).toISOString(),
        sourceKind: row.source_kind,
        sourceKindLabel:
          USAGE_SOURCE_LABELS[row.source_kind] ?? row.source_kind,
        sourceId: row.source_id,
        sourceLabel: isPrivateChat ? "Private chat" : row.source_label,
        sourcePath: row.source_path,
        actor: row.actor,
        actorLabel: formatActor(row.actor),
        providerId: row.provider_id,
        providerName: row.provider_name || "Deployment default",
        model: row.model || "unknown",
        status: row.status,
        stopReason: row.stop_reason,
        inputTokens: iIn,
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: iCr,
        cacheWriteTokens: iCw,
        reasoningTokens: Number(row.reasoning_tokens),
        totalTokens: Number(row.total_tokens),
        estimatedInputTokens:
          row.estimated_input_tokens !== null
            ? Number(row.estimated_input_tokens)
            : null,
        tokenBreakdownKnown: row.token_breakdown_known,
        cacheHitRate: iAllIn > 0 ? iCr / iAllIn : null,
        reservedUsd: Number(row.reserved_usd),
        actualUsd: row.actual_usd !== null ? Number(row.actual_usd) : null,
        accountedUsd: Number(row.accounted_usd),
        pricingUnknown: row.pricing_unknown,
        latencyMs: row.latency_ms,
        toolCalls: row.tool_calls,
        metadata: isPrivateChat
          ? { chatScope: "private", runId: row.metadata?.runId }
          : (row.metadata ?? {}),
      };
    }),
    total: calls,
    offset: query.offset,
    limit: query.limit,
  };
}
