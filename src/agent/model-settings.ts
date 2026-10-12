import { z } from "zod";

export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
// Automatic output allowance for models missing catalog metadata.
export const DEFAULT_MODEL_MAX_OUTPUT = 16384;
export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export const modelLimitsSchema = z
  .object({
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.maxOutputTokens < v.contextWindow, {
    path: ["maxOutputTokens"],
    message:
      "Maximum output must be smaller than the context window to leave room for input.",
  });
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
export const modelLimitOverridesSchema = z
  .object(modelLimitsSchema.shape)
  .partial()
  .strict()
  .refine(
    (v) =>
      v.contextWindow === undefined ||
      v.maxOutputTokens === undefined ||
      v.maxOutputTokens < v.contextWindow,
    {
      path: ["maxOutputTokens"],
      message:
        "Maximum output must be smaller than the context window to leave room for input.",
    },
  );
export type ModelCapabilities = {
  limits: { contextWindow?: number; maxOutputTokens: number };
  source: "catalog" | "operator" | "default";
};
export const modelOptionsSchema = z.object({
  modelBaseUrl: z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Use an HTTP(S) base URL without credentials, query or fragment")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
  modelLimits: modelLimitOverridesSchema.nullable().optional(),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  modelPricing: z
    .object({
      input: z.number().finite().min(0).max(10000).optional(),
      output: z.number().finite().min(0).max(10000).optional(),
    })
    .strict()
    .optional(),
});
export type ModelOptions = z.infer<typeof modelOptionsSchema> & {
  // Run snapshots pin catalog metadata separately from the context enforcement choice.
  providerContext?: boolean;
};
export const credentialsSchema = modelOptionsSchema
  .extend({
    version: z.number().int().positive(),
    botToken: z.string().max(200).optional(),
    modelKey: z.string().trim().min(1).max(4096).optional(),
    model: z.string().trim().min(1).max(200).regex(/^\S+$/).optional(),
  })
  .strict();
