import { z } from "zod";

export const developmentPolicy = z
  .object({
    executionMode: z.enum(["reviewed", "direct"]).default("reviewed"),
    publishByDefault: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(20).default(8),
    maxRepairAttempts: z.number().int().min(0).max(5).default(2),
    activeSeconds: z.number().int().min(60).max(7200).default(2700),
    maxTokens: z.number().int().min(1000).max(2000000).default(200000),
  })
  .strict();
export type DevelopmentPolicy = z.infer<typeof developmentPolicy>;
