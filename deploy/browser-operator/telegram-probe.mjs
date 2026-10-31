// node_modules/.cache/browser-deployment/telegram-probe.ts
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

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

// node_modules/.cache/browser-deployment/telegram-probe.ts
var pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const credentials = (await pool.query("SELECT data->'credentials' AS credentials FROM deployment LIMIT 1")).rows[0]?.credentials;
  const key = process.env.ENCRYPTION_KEY ?? (await readFile(process.env.ENCRYPTION_KEY_FILE ?? "/run/secrets/encryption_key", "utf8")).trim();
  const token = decrypt(key, "bot", credentials.bot);
  const get = async (method) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.result)
      throw Error("telegram_probe_failed");
    return result.result;
  };
  const me = await get("getMe"), menu = await get("getChatMenuButton");
  console.log(JSON.stringify({ telegramBotReady: true, mainMiniAppConfigured: me.has_main_web_app === true, webAppMenuConfigured: menu.type === "web_app" }));
} catch {
  console.error("telegram_browser_entry_unverified");
  process.exitCode = 1;
} finally {
  await pool.end();
}
