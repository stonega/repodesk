import { z } from "zod";

export const qwenModel = "Qwen/Qwen3-ASR-0.6B";
export const qwenRevision = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0";
export const audioLimits = { maxBytes: 5 * 1024 * 1024, maxSeconds: 120 };
export interface TranscriptionSettings {
  enabled: boolean;
  generation: number;
}
export const transcriptionSave = z
  .object({ revision: z.number().int().min(0), enabled: z.boolean() })
  .strict();
export const modelStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_downloaded") }),
  z.object({ state: z.literal("downloading") }),
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("error"), error: z.string().max(100) }),
  z.object({ state: z.literal("unavailable") }),
]);
export type ModelStatus = z.infer<typeof modelStatus>;
export interface TranscriptionPage {
  revision: number;
  settings: TranscriptionSettings;
  model: string;
  status: ModelStatus;
  limits: typeof audioLimits;
}
