import { readFileSync } from "node:fs";
import { z } from "zod";

export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;

const schema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  DATABASE_URL: z.string().url(),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  TELEGRAM_TRANSPORT: z.enum(["webhook", "polling"]).default("webhook"),
  RUN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(DEFAULT_RUN_TIMEOUT_SECONDS),
  CODEX_RUNNER_URL: z.string().url().optional(),
  CODEX_RUNNER_TOKEN: z.string().min(32).optional(),
  CODE_TRUTH_URL: z.string().url().optional(),
  CODE_TRUTH_TOKEN: z.string().min(32).optional(),
  PI_EXTENSIONS_FILE: z.string().trim().min(1).optional(),
  UPDATES_GITHUB_REPOSITORY: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/)
    .default("stonega/repodesk"),
  UPDATES_GITHUB_TOKEN: z.string().trim().min(1).optional(),
  UPDATES_DIRECTORY: z.string().startsWith("/").optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  NODE_ENV: z
    .enum(["production", "development", "test"])
    .default("development"),
});
export function config(env = process.env) {
  const data = schema.parse({
    ...env,
    UPDATES_GITHUB_TOKEN: env.UPDATES_GITHUB_TOKEN_FILE
      ? readFileSync(env.UPDATES_GITHUB_TOKEN_FILE, "utf8").trim()
      : env.UPDATES_GITHUB_TOKEN || undefined,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY_FILE
      ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, "utf8")
      : env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_SECRET: env.GITHUB_APP_CLIENT_SECRET_FILE
      ? readFileSync(env.GITHUB_APP_CLIENT_SECRET_FILE, "utf8").trim()
      : env.GITHUB_APP_CLIENT_SECRET,
    CODE_TRUTH_TOKEN: env.CODE_TRUTH_TOKEN_FILE
      ? readFileSync(env.CODE_TRUTH_TOKEN_FILE, "utf8").trim()
      : env.CODE_TRUTH_TOKEN,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY_FILE
      ? readFileSync(env.ENCRYPTION_KEY_FILE, "utf8").trim()
      : env.ENCRYPTION_KEY,
  });
  if (Boolean(data.CODEX_RUNNER_URL) !== Boolean(data.CODEX_RUNNER_TOKEN))
    throw new Error(
      "CODEX_RUNNER_URL and CODEX_RUNNER_TOKEN must be configured together",
    );
  if (Boolean(data.CODE_TRUTH_URL) !== Boolean(data.CODE_TRUTH_TOKEN))
    throw new Error(
      "CODE_TRUTH_URL and CODE_TRUTH_TOKEN must be configured together",
    );
  const github = [
    data.GITHUB_APP_ID,
    data.GITHUB_APP_CLIENT_ID,
    data.GITHUB_APP_CLIENT_SECRET,
    data.GITHUB_APP_PRIVATE_KEY,
    data.GITHUB_APP_SLUG,
  ];
  if (github.some(Boolean) && !github.every(Boolean))
    throw new Error("Configure all GitHub App credentials together");
  const origin = new URL(data.PUBLIC_ORIGIN);
  if (origin.origin !== data.PUBLIC_ORIGIN)
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without a path or trailing slash",
    );
  if (
    data.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  )
    throw new Error("Production requires HTTPS");
  return data;
}
export type Config = ReturnType<typeof config>;
