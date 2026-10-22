import { z } from "zod";

export const vaultLimits = {
  files: 500,
  fileBytes: 100_000,
  totalBytes: 5_000_000,
};
export const obsidianTools = [
  "obsidian_query",
  "obsidian_read",
  "obsidian_write",
] as const;
// Portable vault paths only. Never interpret a user path as a server filesystem path.
export const vaultPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      path === path.normalize("NFC") &&
      !/[\\:*?"<>|#[\]^%]/.test(path) &&
      [...path].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      path
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
            !part.startsWith(".") &&
            part.trim() === part &&
            !part.endsWith("."),
        ) &&
      /\.(md|canvas|base)$/.test(path),
    "Use a relative .md, .canvas or .base vault path without hidden folders or reserved characters.",
  );
export const fileInput = z
  .object({ path: vaultPath, content: z.string().max(vaultLimits.fileBytes) })
  .strict();
const revision = z.number().int().nonnegative();
export const vaultMutation = z.discriminatedUnion("action", [
  fileInput.extend({ action: z.literal("save"), revision }).strict(),
  z
    .object({
      action: z.literal("rename"),
      revision,
      path: vaultPath,
      destination: vaultPath,
    })
    .strict(),
  z
    .object({ action: z.enum(["trash", "restore"]), revision, path: vaultPath })
    .strict(),
  z
    .object({
      action: z.literal("template"),
      revision,
      path: vaultPath,
      template: vaultPath,
      date: z.iso.date(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default("00:00"),
    })
    .strict(),
  z
    .object({
      action: z.literal("daily"),
      revision,
      date: z.iso.date(),
      content: z.string().max(vaultLimits.fileBytes).default(""),
    })
    .strict(),
  z
    .object({
      action: z.literal("import"),
      revision,
      files: z.array(fileInput).min(1).max(vaultLimits.files),
      overwrite: z.boolean().default(false),
    })
    .strict(),
]);
export const vaultQuery = z
  .object({
    query: z.string().max(200).default(""),
    folder: z.string().max(240).optional(),
    tag: z.string().max(100).optional(),
    property: z.string().max(100).optional(),
    value: z.string().max(200).optional(),
    tasks: z.enum(["open", "done"]).optional(),
    trash: z.boolean().default(false),
    offset: z.number().int().min(0).max(vaultLimits.files).default(0),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .strict();
export interface VaultFile {
  path: string;
  content: string;
  version: number;
  updatedAt: string;
  trashed?: boolean;
}
export interface VaultState {
  revision: number;
  files: VaultFile[];
  receipts: { id: string; hash: string; revision: number; path?: string }[];
}
export interface ObsidianSettings {
  enabled: boolean;
  generation: number;
}
export interface NoteSummary {
  path: string;
  title: string;
  version: number;
  updatedAt: string;
  trashed?: boolean;
  properties: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  headings: { level: number; text: string }[];
  tasks: { line: number; text: string; done: boolean }[];
  links: { target: string; embed: boolean; resolved?: string }[];
  backlinks: string[];
}
export interface ObsidianPage {
  revision: number;
  settings: ObsidianSettings;
  vaultRevision: number;
  files: NoteSummary[];
  total: number;
  nextOffset?: number;
  limits: typeof vaultLimits;
}
