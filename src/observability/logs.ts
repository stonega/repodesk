import { z } from "zod";
import type { Sql } from "../db/pool.ts";
import { Fault } from "../domain.ts";

// Only fixed catalog messages and explicitly allowed codes reach stdout or storage.
// Never pass error.message, HTTP bodies, URLs, credentials or chat text to the sink.
export const logEvents = {
  app_started: ["info", "API service started."],
  app_stopping: ["info", "API service is stopping."],
  worker_started: ["info", "Background worker started."],
  worker_stopping: ["info", "Background worker is stopping."],
  request_failed: [
    "error",
    "An API request failed. Check service and database health.",
  ],
  queue_error: ["error", "The job queue reported an error."],
  worker_maintenance_failed: [
    "error",
    "Worker maintenance failed; it will retry.",
  ],
  telegram_polling_connected: ["info", "Telegram polling connected."],
  telegram_updates_received: [
    "info",
    "Telegram updates received and processed.",
  ],
  telegram_polling_failed: ["warn", "Telegram polling failed; it will retry."],
  telegram_polling_stopped: ["error", "Telegram polling stopped unexpectedly."],
  telegram_draft_started: ["info", "Telegram accepted a streaming draft."],
  telegram_draft_failed: [
    "warn",
    "Telegram streaming preview failed; final delivery remains enabled.",
  ],
  run_started: ["info", "An assistant run started."],
  run_completed: ["info", "An assistant run finished or paused for approval."],
  run_failed: [
    "error",
    "An assistant run failed. Inspect the run for its status.",
  ],
  delivery_sent: ["info", "Telegram delivery completed."],
  delivery_failed: [
    "warn",
    "Telegram delivery failed or its outcome is uncertain. Inspect delivery status.",
  ],
  log_storage_unavailable: [
    "warn",
    "Some runtime events could not be saved. Container logs remain available.",
  ],
  log_buffer_full: [
    "warn",
    "The runtime log buffer is full. Additional events are available in container logs.",
  ],
} as const;
export type LogEvent = keyof typeof logEvents;
export type LogService = "app" | "worker";
const codes = new Set([
  "code_truth_unavailable",
  "code_truth_tools_changed",
  "code_truth_disabled",
  "code_truth_no_repositories",
  "extension_configuration_invalid",
  "extension_configuration_changed",
  "extension_changed",
  "extension_load_failed",
  "extension_api_unsupported",
  "extension_event_unsupported",
  "extension_tool_collision",
  "extension_tool_not_granted",
  "extension_tool_failed",
  "extension_hook_failed",
  "extension_tool_outcome_unknown",
  "extension_result_too_large",
  "telegram_polling_conflict",
  "polling_webhook_conflict",
  "polling_credentials_changed",
  "polling_invalid_update",
  "polling_receive_failed",
  "telegram_unauthorized",
  "telegram_rate_limited",
  "telegram_unavailable",
  "telegram_outcome_unknown",
  "telegram_invalid_response",
  "telegram_destination_rejected",
  "bot_not_configured",
  "model_not_configured",
  "model_endpoint_changed",
  "provider_outcome_unknown",
  "provider_error",
  "provider_failed",
  "input_budget_exceeded",
  "model_limits_required",
  "model_output_limit_exceeded",
  "model_context_limit_exceeded",
  "model_images_unsupported",
  "attachment_too_large",
  "attachment_context_limit",
  "attachment_unsupported",
  "attachment_invalid",
  "attachment_text_limit",
  "attachment_pdf_no_text",
  "attachment_download_failed",
  "compaction_invalid_summary",
  "compaction_sources_changed",
  "compaction_turn_limit",
  "followup_turn_limit",
  "followup_sources_changed",
  "discussion_sources_changed",
  "custom_model_pricing_required",
  "execution_failed",
  "run_revoked",
  "run_timeout",
  "worker_shutdown",
  "run_budget_exhausted",
  "workspace_budget_exhausted",
  "deployment_paused",
  "delivery_revoked",
  "lease_lost",
  "turn_limit",
  "invalid_source_citation",
  "incomplete_tool_checkpoint",
  "database_unavailable",
  "unexpected_error",
  "invalid_data",
  "cancelled",
]);
export function safeLogCode(error: unknown): string {
  if (error instanceof Fault && codes.has(error.code)) return error.code;
  if (error instanceof z.ZodError) return "invalid_data";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "unexpected_error";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Entry = {
  at: string;
  service: LogService;
  level: "info" | "warn" | "error";
  event: LogEvent;
  code?: string;
  workspace_id?: string;
  run_id?: string;
  retry_delay_ms?: number;
};
type Context = {
  error?: unknown;
  workspaceId?: string;
  runId?: string;
  retryDelayMs?: number;
};

export class RuntimeLogger {
  private pending: Entry[] = [];
  private writing?: Promise<void>;
  private closed = false;
  private overflowReported = false;
  constructor(
    private sql?: Sql,
    private service: LogService = "app",
    private output: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {}
  write(event: LogEvent, context: Context = {}) {
    if (this.closed || !Object.hasOwn(logEvents, event)) return;
    const workspaceId =
      context.workspaceId && uuid.test(context.workspaceId)
        ? context.workspaceId
        : undefined;
    const entry: Entry = {
      at: new Date().toISOString(),
      service: this.service,
      level: logEvents[event][0],
      event,
      ...(context.error === undefined
        ? {}
        : { code: safeLogCode(context.error) }),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(typeof context.retryDelayMs === "number" &&
      Number.isFinite(context.retryDelayMs) &&
      context.retryDelayMs >= 0 &&
      context.retryDelayMs <= 86400000
        ? { retry_delay_ms: Math.round(context.retryDelayMs) }
        : {}),
      ...(workspaceId && context.runId && uuid.test(context.runId)
        ? { run_id: context.runId }
        : {}),
    };
    this.emit(entry);
    if (!this.sql) return;
    if (this.pending.length >= 200) {
      if (!this.overflowReported)
        this.emit({
          at: entry.at,
          service: this.service,
          level: "warn",
          event: "log_buffer_full",
        });
      this.overflowReported = true;
      return;
    }
    this.pending.push(entry);
    this.startDrain();
  }
  private startDrain() {
    if (this.writing || !this.pending.length) return;
    this.writing = this.drain().finally(() => {
      this.writing = undefined;
      this.startDrain();
    });
  }
  private emit(entry: Entry) {
    try {
      this.output(
        `${JSON.stringify({ ...entry, message: logEvents[entry.event][1] })}\n`,
      );
    } catch {
      /* Logging must not break application work. */
    }
  }
  private async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0, 50);
      try {
        await this.sql?.query(
          "INSERT INTO runtime_logs(at,service,level,event,code,workspace_id,run_id,retry_delay_ms) SELECT e.at,e.service,e.level,e.event,e.code,e.workspace_id,e.run_id,e.retry_delay_ms FROM jsonb_to_recordset($1::jsonb) AS e(at timestamptz,service text,level text,event text,code text,workspace_id uuid,run_id uuid,retry_delay_ms int) WHERE e.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=e.workspace_id AND w.data->'deletion' IS NULL)",
          [JSON.stringify(batch)],
        );
      } catch {
        this.pending = [];
        this.emit({
          at: new Date().toISOString(),
          service: this.service,
          level: "warn",
          event: "log_storage_unavailable",
        });
      }
    }
    this.overflowReported = false;
  }
  async flush() {
    while (this.writing) await this.writing;
  }
  async close() {
    this.closed = true;
    await this.flush();
  }
}

export async function pruneRuntimeLogs(sql: Sql) {
  await sql.query(
    "DELETE FROM runtime_logs WHERE at < now()-interval '7 days' OR id < (SELECT id FROM runtime_logs ORDER BY id DESC OFFSET 9999 LIMIT 1)",
  );
}
const cursor = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
export const logQuery = z
  .object({
    level: z.enum(["info", "warn", "error"]).optional(),
    service: z.enum(["app", "worker"]).optional(),
    q: z.string().trim().max(100).optional(),
    before: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export async function readRuntimeLogs(
  sql: Sql,
  operatorId: string,
  query: z.infer<typeof logQuery>,
) {
  const rows = (
    await sql.query<Entry & { id: string }>(
      "SELECT l.id::text,l.at,l.service,l.level,l.event,l.code,l.workspace_id,l.run_id,l.retry_delay_ms FROM runtime_logs l WHERE l.at >= now()-interval '7 days' AND (l.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=l.workspace_id AND w.operator_id=$1 AND w.data->'deletion' IS NULL)) AND ($2::text IS NULL OR l.level=$2) AND ($3::text IS NULL OR l.service=$3) AND ($4::bigint IS NULL OR l.id<$4) AND ($5::text IS NULL OR strpos(lower(l.event || ' ' || coalesce(l.code,'') || ' ' || coalesce(l.run_id::text,'')),lower($5))>0) ORDER BY l.id DESC LIMIT $6",
      [
        operatorId,
        query.level ?? null,
        query.service ?? null,
        query.before ?? null,
        query.q || null,
        query.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, query.limit).map((row) => ({
    ...row,
    event: Object.hasOwn(logEvents, row.event) ? row.event : "unknown_event",
    message: Object.hasOwn(logEvents, row.event)
      ? logEvents[row.event][1]
      : "Runtime event.",
    code: row.code && codes.has(row.code) ? row.code : undefined,
  }));
  return {
    items,
    nextBefore: rows.length > query.limit ? items.at(-1)?.id : undefined,
    retentionDays: 7,
    maxEntries: 10000,
  };
}
