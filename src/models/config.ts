import { z } from "zod";
import { modelOptionsSchema } from "../agent/model-settings.ts";

export const providerBaseUrl = modelOptionsSchema.shape.modelBaseUrl
  .unwrap()
  .transform((value) =>
    new URL(value).pathname === "/" ? `${value}/v1` : value,
  );
export const modelId = z.string().trim().min(1).max(200).regex(/^\S+$/);
export const modelSelectionSchema = modelOptionsSchema
  .omit({ modelBaseUrl: true })
  .extend({
    providerId: z.uuid(),
    model: modelId,
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export interface ModelProvider {
  id: string;
  operatorId: string;
  version: number;
  name: string;
  baseUrl: string;
  credential: string;
  models: string[];
  fetchedAt: string;
}
export type ProviderView = Omit<ModelProvider, "credential" | "operatorId"> & {
  apiKeyConfigured: boolean;
};
export interface ProviderCatalog {
  version: number;
  providers: ProviderView[];
}
export interface WorkspaceModels extends ProviderCatalog {
  revision: number;
  selection: ModelSelection | null;
  legacy: boolean;
  configured: boolean;
}
export const providerInput = z
  .object({
    version: z.number().int().positive(),
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(100),
    baseUrl: providerBaseUrl,
    apiKey: z.string().trim().min(1).max(8192).optional(),
  })
  .strict();
export const discoveryInput = providerInput.omit({ name: true });
export const runtimeProviderSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    name: z.string().min(1).max(100),
    baseUrl: providerBaseUrl,
    model: modelId,
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  })
  .strict();
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;
