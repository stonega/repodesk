import { z } from "zod";

export function withoutDevelopmentLimits(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clean = { ...value } as Record<string, unknown>;
  for (const key of [
    "maxAttempts",
    "maxRepairAttempts",
    "activeSeconds",
    "maxTokens",
  ])
    delete clean[key];
  return clean;
}

export const developmentPolicy = z.preprocess(
  withoutDevelopmentLimits,
  z
    .object({
      executionMode: z.enum(["reviewed", "direct"]).default("reviewed"),
      publishByDefault: z.boolean().default(false),
    })
    .strict(),
);
export type DevelopmentPolicy = z.infer<typeof developmentPolicy>;
