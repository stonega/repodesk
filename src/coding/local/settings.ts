import { z } from "zod";

export const runnerSettings = z.object({
  CODEX_CONTAINER_ENGINE: z.enum(["podman", "docker"]).default("podman"),
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
    }, "Use an HTTPS provider URL without credentials or query parameters"),
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
    .default("unix:///run/podman/podman.sock"),
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
) {
  const quote = (value: string) => JSON.stringify(value);
  if (authMode === "device_code")
    return [
      `model_reasoning_effort = ${quote(settings.CODEX_REASONING_EFFORT)}`,
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'cli_auth_credentials_store = "file"',
      "",
    ].join("\n");
  return [
    `model = ${quote(settings.CODEX_MODEL)}`,
    'model_provider = "proxy"',
    `model_reasoning_effort = ${quote(settings.CODEX_REASONING_EFFORT)}`,
    'approval_policy = "never"',
    // The outer container is the execution boundary; nested sandboxes vary by host.
    'sandbox_mode = "danger-full-access"',
    "[model_providers.proxy]",
    `name = ${quote(settings.CODEX_PROVIDER_NAME)}`,
    `base_url = ${quote(`${settings.CODEX_RUNNER_PROXY_URL.replace(/\/$/, "")}/v1`)}`,
    'env_key = "CODEX_TASK_TOKEN"',
    'wire_api = "responses"',
    "",
  ].join("\n");
}
