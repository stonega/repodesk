import { z } from "zod";
import { modelSelectionSchema } from "../models/config.ts";
import type { DevelopmentTask } from "./development.ts";
import { developmentPolicy } from "./development-policy.ts";

// Git branch names, not arbitrary refs, command arguments, or filesystem paths.
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      !s.startsWith("-") &&
      !Array.from(s).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) &&
      !/[~^:?*[\\]/.test(s) &&
      !s.includes("@{") &&
      !s.includes("..") &&
      !s.includes("//") &&
      s
        .split("/")
        .every(
          (part) =>
            part &&
            !part.startsWith(".") &&
            !part.endsWith(".") &&
            !part.endsWith(".lock"),
        ),
    "Enter a branch name such as develop or release/next",
  );
// Discard obsolete command settings when loading old records or saving older clients.
function withoutCommands(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clean = { ...value } as Record<string, unknown>;
  delete clean.setupCommand;
  delete clean.checkCommand;
  return clean;
}
// Older clients cannot restore the retired repository/maintainer grants.
export function withoutRepositoryGrants(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clean = { ...value } as Record<string, unknown>;
  delete clean.repositories;
  return clean;
}
// "podman" is the historical local-runner wire identifier. Keep it stable for
// persisted approvals/fingerprints; the deployment runtime supports Docker/OpenSandbox.
export const codingEngineSchema = z.enum(["codex", "antigravity"]);
export type CodingEngine = z.infer<typeof codingEngineSchema>;

export const antigravityAuthModeSchema = z.enum([
  "google_oauth",
  "gemini_api_key",
]);
export type AntigravityAuthMode = z.infer<typeof antigravityAuthModeSchema>;

export const antigravityEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type AntigravityEffort = z.infer<typeof antigravityEffortSchema>;

export const antigravityModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/-]+$/);

export const antigravityBaseUrlSchema = z
  .string()
  .trim()
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
  }, "Use an HTTPS Gemini API URL without credentials or query parameters");

export const antigravitySettingsSchema = z
  .object({
    enabled: z.boolean(),
    authMode: antigravityAuthModeSchema.default("google_oauth"),
    model: antigravityModelSchema.optional(),
    effort: antigravityEffortSchema.optional(),
    baseUrl: antigravityBaseUrlSchema.optional(),
    development: developmentPolicy.optional(),
  })
  .strict();

export const antigravitySaveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: antigravitySettingsSchema,
    apiKey: z.string().trim().min(1).max(8192).nullable().optional(),
  })
  .strict();

export type AntigravitySettings = z.infer<typeof antigravitySettingsSchema>;
export interface AntigravityConfig {
  apiKey?: string; // Encrypted with the deployment key and workspace-bound AAD.
  revision: number;
  settings: AntigravitySettings;
}
export const emptyAntigravity: AntigravitySettings = {
  enabled: false,
  authMode: "google_oauth",
};

export const codingSettingsSchema = z.preprocess(
  withoutRepositoryGrants,
  z
    .object({
      enabled: z.boolean(),
      backend: z.literal("podman"),
      authMode: z.enum(["provider_key", "device_code"]).default("provider_key"),
      development: developmentPolicy.optional(),
      model: modelSelectionSchema.optional(),
    })
    .strict(),
);
export const codingSaveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: codingSettingsSchema,
    providerApiKey: z.string().trim().min(1).max(8192).nullable().optional(),
  })
  .strict();
export type CodingSettings = z.infer<typeof codingSettingsSchema>;
export interface CodingConfig {
  providerApiKey?: string; // Encrypted with the deployment key and workspace-bound AAD.
  revision: number;
  settings: CodingSettings;
}
export const emptyCoding: CodingSettings = {
  enabled: false,
  backend: "podman",
  authMode: "provider_key",
};
export const codingInput = z
  .object({
    repositoryId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2500),
  })
  .strict();
export const codingPayload = z.preprocess(
  withoutCommands,
  codingInput.extend({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    installationId: z.number().int().positive(),
    githubRevision: z.number().int().nonnegative(),
    githubScope: z
      .object({
        connectionRevision: z.number().int().nonnegative(),
        repositoryRevision: z.number().int().nonnegative(),
        private: z.boolean().nullable(),
      })
      .optional(),
    configRevision: z.number().int().positive(),
    baseBranch: branchName,
    backend: z.literal("podman"),
    engine: codingEngineSchema.optional(),
    authMode: z
      .enum(["provider_key", "device_code", "google_oauth", "gemini_api_key"])
      .default("provider_key"),
    model: antigravityModelSchema.optional(),
    effort: antigravityEffortSchema.optional(),
    baseUrl: antigravityBaseUrlSchema.optional(),
  }),
);
export type CodingPayload = z.infer<typeof codingPayload>;

export function codingEngineOf(
  payload?: Pick<CodingPayload, "engine">,
): CodingEngine {
  return payload?.engine === "antigravity" ? "antigravity" : "codex";
}

export function codingEngineLabel(
  payload?: Pick<CodingPayload, "engine">,
): string {
  return codingEngineOf(payload) === "antigravity"
    ? "Antigravity CLI"
    : "Codex";
}

export function codingEnabled(w: {
  coding?: CodingConfig;
  antigravity?: AntigravityConfig;
}): boolean {
  return Boolean(w.coding?.settings.enabled || w.antigravity?.settings.enabled);
}

export function codingRevisionStamp(w: {
  coding?: CodingConfig;
  antigravity?: AntigravityConfig;
}): number | undefined {
  if (!w.antigravity) return w.coding?.revision;
  return (w.coding?.revision ?? 0) + w.antigravity.revision * 1_000_000;
}

export interface CodingPage {
  repositoryRefreshError?: string;
  providerApiKeyConfigured: boolean;
  deviceAuth?: {
    state:
      | "disconnected"
      | "pending"
      | "connected"
      | "auth_required"
      | "failed"
      | "unavailable";
    verificationUrl?: string;
    userCode?: string;
  };
  legacyActionsConfiguration: boolean;
  revision: number;
  settings: CodingSettings;
  repositories: { id: number; full_name: string; private?: boolean }[];
  tasks: DevelopmentTask[];
}

export interface AntigravityPage {
  repositoryRefreshError?: string;
  apiKeyConfigured: boolean;
  oauthAuth?: {
    state:
      | "disconnected"
      | "pending"
      | "connected"
      | "auth_required"
      | "failed"
      | "unavailable";
    verificationUrl?: string;
  };
  revision: number;
  settings: AntigravitySettings;
  repositories: { id: number; full_name: string; private?: boolean }[];
  tasks: DevelopmentTask[];
}
