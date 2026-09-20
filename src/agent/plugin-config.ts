import { z } from "zod";
import type { CodeTruthSettings } from "../code-truth/config.ts";

export const pluginSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.string().trim().min(1).max(100),
    path: z.string().trim().min(1).max(2048),
    workspaces: z.array(z.uuid()).max(500),
    tools: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)).max(32),
    execution: z.literal("read-only"),
    enabled: z.boolean().default(true),
  })
  .strict();
export const pluginManifestSchema = z.array(pluginSchema).max(32);
export const pluginSaveSchema = z
  .object({
    revision: z.number().int().min(0),
    entries: pluginManifestSchema,
  })
  .strict();
export type PluginSpec = z.infer<typeof pluginSchema>;
export type PluginRecord = PluginSpec & { hash?: string };
export interface PluginSettings {
  revision: number;
  entries: PluginRecord[];
  codeTruth?: CodeTruthSettings;
}
export interface PluginPage {
  revision: number;
  source: "panel" | "manifest" | "empty";
  notice?: string;
  entries: (PluginSpec & {
    fileStatus: "ready" | "changed" | "unavailable" | "unchecked";
  })[];
  workspaces: { id: string; name: string }[];
  audit: { id: string; action: string; at: string }[];
}
