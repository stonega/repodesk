import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const branch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !v.startsWith("-") &&
      !v.includes("..") &&
      !Array.from(v).some(
        (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
      ) &&
      !/[~^:?*[\\]/.test(v) &&
      !/[/.]$/.test(v),
  );
export const codeRepositorySchema = z
  .object({
    id: identifier.default(() => `repo-${crypto.randomUUID()}`),
    repositoryUrl: z
      .string()
      .max(2048)
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(?:\.git)?$/,
      ),
    description: z.string().trim().max(2000).optional(),
    networks: z
      .record(identifier, branch)
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 8)
      .optional(),
    workspaces: z.array(z.uuid()).max(500),
  })
  .strict()
  // Accept saved legacy mappings, but repository settings now follow GitHub's default branch.
  .transform(({ networks: _, ...repository }) => repository);
export const codeTruthSchema = z
  .object({
    enabled: z.boolean(),
    repositories: z.array(codeRepositorySchema).max(12),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.repositories.map((r) => r.id)).size === v.repositories.length &&
      new Set(
        v.repositories.map((r) =>
          r.repositoryUrl.toLowerCase().replace(/\.git$/, ""),
        ),
      ).size === v.repositories.length,
  );
export const codeTruthSaveSchema = z
  .object({
    revision: z.number().int().min(0),
    settings: codeTruthSchema,
  })
  .strict();
export type CodeTruthSettings = z.infer<typeof codeTruthSchema>;
export type CodeRepository = z.infer<typeof codeRepositorySchema>;
export type CodeTarget = Omit<CodeRepository, "workspaces"> & {
  networks: Record<string, string>;
};
export const codeTruthTools = [
  "list_code_targets",
  "search_code",
  "search_code_batch",
  "get_code_context",
  "get_symbol_source",
  "get_file_excerpt",
  "get_dependency_manifests",
  "get_file_tree",
] as const;
export const emptyCodeTruth: CodeTruthSettings = {
  enabled: false,
  repositories: [],
};
export interface CodeTruthPage {
  revision: number;
  settings: CodeTruthSettings;
  serviceConfigured: boolean;
  workspaces: { id: string; name: string }[];
}
export interface CodeTruthStatus {
  syncing: boolean;
  targets: {
    target: string;
    repositoryUrl?: string;
    description?: string;
    networks: {
      network: string;
      branch: string;
      status: string;
      commit?: string;
      indexedAt?: string;
      error?: string;
    }[];
  }[];
}
export function targetsFor(
  settings: CodeTruthSettings,
  workspaceId: string,
): CodeTarget[] {
  return settings.repositories
    .filter((r) => r.workspaces.includes(workspaceId))
    .map(({ id, repositoryUrl, description }) => ({
      id,
      repositoryUrl,
      ...(description ? { description } : {}),
      // The upstream MCP protocol still uses a named snapshot selector.
      networks: { default: "HEAD" },
    }));
}
