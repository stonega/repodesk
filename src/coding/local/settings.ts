import { isAbsolute } from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL_BASE_URL } from "../../agent/model-settings.ts";
import type { RuntimeProvider } from "../../models/config.ts";
import { runtimeEngine } from "../runtime-config.ts";

const optionalSetting = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

export const runnerSettings = z.object({
  CODEX_CONTAINER_ENGINE: runtimeEngine.default("docker"),
  CODEX_DOCKER_IMAGE: optionalSetting(z.string().min(1)),
  CODEX_OPENSANDBOX_IMAGE: optionalSetting(z.string().min(1)),
  CODEX_DOCKER_HOST: optionalSetting(z.string().startsWith("unix://")),
  // These paths must refer to the same storage on the supervisor and sandbox host.
  CODEX_SANDBOX_ROOT: optionalSetting(
    z.string().refine(isAbsolute, "Use an absolute sandbox storage path"),
  ),
  CODEX_SANDBOX_HOST_ROOT: optionalSetting(
    z.string().refine(isAbsolute, "Use an absolute sandbox host path"),
  ),
  OPENSANDBOX_URL: optionalSetting(z.string().url()),
  OPENSANDBOX_API_KEY: optionalSetting(z.string().min(1)),
  OPENSANDBOX_SECURE_ACCESS: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((v) => v === "true"),
    ])
    .default(false),
  OPENSANDBOX_ALLOWED_DOMAINS: z
    .string()
    .default(
      "github.com,api.github.com,*.githubusercontent.com,registry.npmjs.org,*.npmjs.org,deb.debian.org,security.debian.org,auth.openai.com,api.openai.com,chatgpt.com,*.openai.com,*.chatgpt.com",
    ),
  CODEX_RUNNER_TOKEN: z.string().min(32),
  CODEX_PROVIDER_API_KEY: z.string().optional(),
  CODEX_PROVIDER_NAME: z.string().min(1).max(100).default("AIAPI"),
  CODEX_PROVIDER_BASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    }, "Use an HTTPS provider URL without credentials or query parameters")
    .default(DEFAULT_MODEL_BASE_URL),
  CODEX_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .default("gpt-6-astra"),
  CODEX_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .default("high"),
  CODEX_RUNNER_IMAGE: z
    .string()
    .min(1)
    .default("localhost/deepx-codex-job:local"),
  CODEX_RUNNER_NETWORK: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("deepx_codex_tasks"),
  CODEX_RUNNER_PROXY_URL: z.string().url().default("http://codex-runner:3020"),
  CODEX_RUNNER_STATE: z.string().default("/var/lib/deepx-codex"),
  CODEX_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  CODEX_RUNNER_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24),
  CODEX_RUNNER_CPUS: z.coerce.number().positive().max(32).default(2),
  CODEX_RUNNER_MEMORY_MB: z.coerce
    .number()
    .int()
    .min(256)
    .max(65536)
    .default(4096),
  CONTAINER_HOST: z
    .string()
    .startsWith("unix://")
    .default("unix:///var/run/docker.sock"),
});
export type RunnerSettings = z.infer<typeof runnerSettings>;

// Provider credentials stay in the supervisor. Each task receives a temporary proxy token.
export function codexConfig(
  settings: Pick<
    RunnerSettings,
    | "CODEX_MODEL"
    | "CODEX_REASONING_EFFORT"
    | "CODEX_PROVIDER_NAME"
    | "CODEX_RUNNER_PROXY_URL"
  >,
  authMode: "provider_key" | "device_code" = "provider_key",
  provider?: RuntimeProvider,
) {
  const quote = (value: string) => JSON.stringify(value);
  if (authMode === "device_code")
    return [
      `model_reasoning_effort = ${quote(provider?.reasoningEffort ?? settings.CODEX_REASONING_EFFORT)}`,
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'cli_auth_credentials_store = "file"',
      "",
    ].join("\n");
  return [
    `model = ${quote(provider?.model ?? settings.CODEX_MODEL)}`,
    'model_provider = "proxy"',
    `model_reasoning_effort = ${quote(provider?.reasoningEffort ?? settings.CODEX_REASONING_EFFORT)}`,
    'approval_policy = "never"',
    // The outer container is the execution boundary; nested sandboxes vary by host.
    'sandbox_mode = "danger-full-access"',
    "[model_providers.proxy]",
    `name = ${quote(provider?.name ?? settings.CODEX_PROVIDER_NAME)}`,
    `base_url = ${quote(`${settings.CODEX_RUNNER_PROXY_URL.replace(/\/$/, "")}/v1`)}`,
    'env_key = "CODEX_TASK_TOKEN"',
    'wire_api = "responses"',
    "",
  ].join("\n");
}
