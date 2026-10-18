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
      // Publication is part of every verified implementation. Keep the fixed
      // value in task authority snapshots; saved opt-outs cannot disable it.
      publishByDefault: z
        .boolean()
        .default(true)
        .transform(() => true),
    })
    .strict(),
);
export type DevelopmentPolicy = z.infer<typeof developmentPolicy>;
