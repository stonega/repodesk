"""Inspect only the reported private Topic; never print private bodies."""
import subprocess
script = r'''
// deploy/thread-incident/diagnostic.ts
import { readFileSync } from "node:fs";
import { Pool } from "pg";

// src/domain.ts
import { z } from "zod";

// src/currency.ts
var currencies = [
  "USD",
  "CNY",
  "TWD",
  "HKD",
  "EUR",
  "GBP",
  "JPY",
  "SGD"
];

// src/domain.ts
class Fault extends Error {
  code;
  status;
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function requireThat(value, code, status = 400) {
  if (!value)
    throw new Fault(code, status);
}
var userId = z.string().regex(/^[1-9]\d{0,15}$/);
var chatId = z.string().regex(/^-?[1-9]\d{0,15}$/);
var timezone = z.string().max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return !/^[+-]/.test(value);
  } catch {
    return false;
  }
}, "Use an IANA timezone");
var settingsSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const settings = { ...value };
  delete settings.language;
  delete settings.maxInputChars;
  delete settings.maxOutputTokens;
  delete settings.maxTurns;
  return settings;
}, z.object({
  name: z.string().trim().min(1).max(80),
  timezone,
  currency: z.enum(currencies).default("USD"),
  retentionDays: z.number().int().min(1).max(90).default(30),
  monthlyBudgetUsd: z.number().finite().min(0).nullable().default(null),
  runBudgetUsd: z.number().finite().min(0).nullable().default(null),
  missedRunMinutes: z.literal(5).default(5),
  paused: z.boolean().default(false)
}).strict());
var recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly"]),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(1).max(7).optional(),
  timezone
}).strict().refine((s) => s.frequency !== "weekly" || s.weekday !== undefined, "Weekly schedules need a weekday (Monday=1)");
var repositorySourcesSchema = z.object({
  revision: z.number().int().nonnegative(),
  repositoryIds: z.array(z.number().int().positive().safe()).min(1).max(6)
}).strict().refine((s) => new Set(s.repositoryIds).size === s.repositoryIds.length);
var workflowSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const spec = { ...value };
  delete spec.budgetUsd;
  return spec;
}, z.object({
  name: z.string().trim().min(1).max(80),
  task: z.string().min(1).max(2000),
  chatId,
  topicId: z.number().int().nonnegative().default(0),
  recurrence: recurrenceSchema,
  format: z.string().max(2000).default("Decisions, blockers, next steps. Cite source IDs."),
  skillId: z.string().min(1).optional(),
  windowDays: z.number().int().min(1).max(30).default(7),
  github: repositorySourcesSchema.optional()
}).strict());
var TOOLS = [
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
  "query_work_handoff"
];
var skillSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(16384),
  tools: z.array(z.enum(TOOLS)).max(TOOLS.length),
  frontmatter: z.object({
    license: z.string().max(2000).optional(),
    compatibility: z.string().max(2000).optional(),
    metadata: z.record(z.string().max(100), z.string().max(2000)).optional()
  }).strict().optional(),
  resources: z.array(z.object({
    path: z.string().min(1).max(1000).refine((path) => /\.(md|txt)$/i.test(path) && !path.includes("\\") && !Array.from(path).some((char) => char.charCodeAt(0) < 32) && path.split("/").every((part) => part && part !== "." && part !== "..")),
    body: z.string().max(65536)
  }).strict()).max(32).optional(),
  settings: z.object({
    sections: z.string().max(1000).default("Decisions, blockers, next steps"),
    maxWords: z.number().int().min(50).max(1000).default(400)
  }).strict().default({ sections: "Decisions, blockers, next steps", maxWords: 400 })
}).strict();

// src/setup/credentials.ts
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
var derive = promisify(scrypt);
function decrypt(key, name, value) {
  const [version, iv, tag, data] = value.split(".");
  requireThat((version === "v1" || version === "v2") && iv && tag && data, "invalid_ciphertext");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "base64"));
  cipher.setAAD(Buffer.from(`${version === "v1" ? "deepx:v1" : "repodesk:v2"}:${name}`));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "base64")),
    cipher.final()
  ]).toString("utf8");
}

// src/browser/config.ts
import { z as z2 } from "zod";
var browserLimits = {
  leaseMs: 120000,
  requestMs: 10 * 60000,
  operationMs: 30000,
  tabs: 8,
  downloads: 20,
  downloadBytes: 25 * 1024 * 1024,
  resultChars: 24000,
  inputChars: 4096
};
var browserOwner = z2.object({
  workspaceId: z2.uuid(),
  actor: z2.string().regex(/^[1-9]\d{0,15}$/)
}).strict();
var browserController = z2.object({
  kind: z2.enum(["chat", "codex", "plugin", "human"]),
  id: z2.uuid(),
  fence: z2.number().int().nonnegative().safe(),
  pluginId: z2.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
  pluginRevision: z2.number().int().nonnegative().optional()
}).strict().refine((v) => v.kind !== "plugin" || !!v.pluginId);
var browserUrl = z2.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Use an HTTP(S) URL without embedded credentials.");
var browserAction = z2.discriminatedUnion("action", [
  z2.object({ action: z2.literal("request_site"), url: browserUrl }).strict(),
  z2.object({ action: z2.literal("navigate"), url: browserUrl }).strict(),
  z2.object({ action: z2.literal("read") }).strict(),
  z2.object({ action: z2.literal("screenshot") }).strict(),
  z2.object({ action: z2.literal("tabs") }).strict(),
  z2.object({ action: z2.literal("new_tab") }).strict(),
  z2.object({
    action: z2.literal("pointer"),
    requireApproval: z2.literal(true).optional(),
    x: z2.number().int().min(0).max(1280),
    y: z2.number().int().min(0).max(800)
  }).strict(),
  z2.object({ action: z2.literal("select_tab"), tabId: z2.string().uuid() }).strict(),
  z2.object({ action: z2.literal("close_tab"), tabId: z2.string().uuid() }).strict(),
  z2.object({
    action: z2.literal("click"),
    requireApproval: z2.literal(true).optional(),
    selector: z2.string().min(1).max(500)
  }).strict(),
  z2.object({
    action: z2.literal("fill"),
    requireApproval: z2.literal(true).optional(),
    selector: z2.string().min(1).max(500),
    text: z2.string().max(4096)
  }).strict(),
  z2.object({
    action: z2.literal("press"),
    requireApproval: z2.literal(true).optional(),
    key: z2.enum([
      "Enter",
      "Tab",
      "Shift+Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Control+A",
      "Meta+A"
    ])
  }).strict(),
  z2.object({
    action: z2.literal("scroll"),
    x: z2.number().int().min(-4000).max(4000),
    y: z2.number().int().min(-4000).max(4000)
  }).strict(),
  z2.object({
    action: z2.literal("request_input"),
    selector: z2.string().min(1).max(500),
    label: z2.string().trim().min(1).max(100),
    kind: z2.enum(["password", "code", "text"])
  }).strict()
]);
var browserSave = z2.object({
  revision: z2.number().int().nonnegative(),
  settings: z2.object({
    enabled: z2.boolean(),
    previewOrigins: z2.array(browserUrl.refine((value) => {
      const url = new URL(value);
      return url.origin === value && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    })).max(8).optional()
  }).strict()
}).strict();
var browserSession = z2.object({
  action: z2.enum(["status", "acquire", "release", "close"])
}).strict();

// src/browser/storage.ts
var runFields = [
  "task",
  "sources",
  "instructions",
  "transcript",
  "tools",
  "result",
  "contextSummary",
  "compaction",
  "discussionUpdates",
  "pendingInputs",
  "followup",
  "memoryContext",
  "handoffRead"
];
var sourceFields = ["text", "attachments"];
var threadFields = ["summary", "discussions"];
var deliveryFields = ["text", "buttons", "sentButtons"];
var approvalFields = ["payload"];
var record = (value) => value;
var name = (w, kind, id, owner) => `browser-content:${w.id}:${owner}:${kind}:${id}`;
function unseal(value, fields, aad, key) {
  if (!value.browserSealed)
    return;
  requireThat(key, "browser_private_storage_unavailable", 503);
  try {
    const body = JSON.parse(decrypt(key, aad, value.browserSealed));
    requireThat(body && typeof body === "object" && !Array.isArray(body), "browser_private_storage_unavailable", 503);
    for (const field of fields) {
      delete value[field];
      if (Object.hasOwn(body, field))
        value[field] = body[field];
    }
    delete value.browserSealed;
  } catch {
    throw new Fault("browser_private_storage_unavailable", 503);
  }
}
function decodeBrowserWorkspace(w, key) {
  for (const [kind, values, fields] of [
    ["run", w.runs, runFields],
    ["source", w.messages, sourceFields],
    ["thread", w.threads ?? [], threadFields],
    ["delivery", w.deliveries, deliveryFields],
    ["approval", w.approvals, approvalFields]
  ])
    for (const value of values) {
      if (!value.browserSealed)
        continue;
      requireThat(value.browserRead, "browser_private_storage_unavailable", 503);
      unseal(record(value), fields, name(w, kind, value.id, value.browserRead.owner), key);
    }
  return w;
}

// deploy/thread-incident/diagnostic.ts
var pool = new Pool({ connectionString: process.env.DATABASE_URL });
var workspaceId = "3b2dfe82-61c6-444e-8058-7a179f2bf27a";
var safeCode = (v) => typeof v === "string" && /^[a-z][a-z0-9_]{0,90}$/.test(v) ? v : undefined;
function resultMeta(v) {
  if (!v || typeof v !== "object")
    return { type: typeof v };
  return {
    keys: Object.keys(v),
    code: safeCode(v.code ?? v.error),
    status: safeCode(v.status),
    isError: v.isError,
    content: Array.isArray(v.content) ? v.content.map((p) => {
      if (p.type !== "text")
        return { type: p.type };
      try {
        return resultMeta(JSON.parse(p.text));
      } catch {
        return { type: "text", length: p.text?.length };
      }
    }) : undefined
  };
}
try {
  await pool.query("BEGIN READ ONLY");
  const { rows } = await pool.query("SELECT data FROM workspaces WHERE id=$1", [workspaceId]);
  const raw = rows[0]?.data;
  if (!raw)
    throw new Error("workspace_missing");
  const runs = raw.runs.filter((r) => r.actor === "105761681" && r.topicId === 1996398 && r.at >= "2026-11-05T00:00:00");
  const ids = new Set(runs.map((r) => r.id));
  const key = process.env.ENCRYPTION_KEY || readFileSync(process.env.ENCRYPTION_KEY_FILE, "utf8").trim();
  const w = decodeBrowserWorkspace({ ...raw, runs, messages: [], threads: [], approvals: [], deliveries: raw.deliveries.filter((d) => ids.has(d.runId ?? d.cancellationRunId)) }, key);
  console.log(JSON.stringify({
    runs: w.runs.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      at: r.at,
      finishedAt: r.finishedAt,
      status: r.status,
      error: r.error,
      cancelled: r.cancelled,
      browserWait: r.browserWait,
      browserResumed: r.browserResumed,
      resultLength: r.result?.length,
      attempts: r.attempts,
      tools: Object.entries(r.tools).map(([id, t]) => ({ id, name: t.name, state: t.state, action: t.arguments?.action, result: resultMeta(t.result) })),
      transcript: r.transcript.map((m) => ({
        role: m.role,
        stopReason: m.stopReason,
        error: safeCode(m.errorMessage),
        toolName: m.toolName,
        isError: m.isError,
        content: m.content?.map((p) => ({ type: p.type, name: p.name, textLength: p.text?.length, result: p.type === "text" && m.role === "toolResult" ? (() => {
          try {
            return resultMeta(JSON.parse(p.text));
          } catch {
            return;
          }
        })() : undefined }))
      }))
    })),
    deliveries: w.deliveries.map((d) => ({ id: d.id, runId: d.runId, state: d.state, kind: d.kind, error: d.error, remoteId: d.remoteId, browserRequest: d.browserRequest, browserResume: d.browserResume, textLength: d.text?.length }))
  }));
  const { rows: logs } = await pool.query("SELECT at,event,code,run_id FROM runtime_logs WHERE workspace_id=$1 AND run_id::text=ANY($2::text[]) ORDER BY at LIMIT 120", [workspaceId, [...ids]]);
  console.log(JSON.stringify({ logs }));
  await pool.query("ROLLBACK");
} catch {
  console.log(JSON.stringify({ diagnosticCode: "thread_inspection_failed" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}

'''
subprocess.run(['docker','exec','-i','repodesk-app-1','node','--input-type=module'],input=script,text=True,check=True,timeout=60)
