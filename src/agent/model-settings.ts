import { z } from "zod";

export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
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
  thinkingLevel: z.enum(thinkingLevels).optional(),
  modelPricing: z
    .object({
      input: z.number().finite().min(0).max(10000),
      output: z.number().finite().min(0).max(10000),
    })
    .strict()
    .optional(),
});
export type ModelOptions = z.infer<typeof modelOptionsSchema>;
export const credentialsSchema = modelOptionsSchema
  .extend({
    version: z.number().int().positive(),
    botToken: z.string().max(200).optional(),
    modelKey: z.string().trim().min(1).max(4096).optional(),
    model: z.string().trim().min(1).max(200).regex(/^\S+$/).optional(),
  })
  .strict();
