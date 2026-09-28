import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readDependencyManifests } from "../codegraph/dependency-manifests.ts";
import type {
  RepositoryManager,
  Snapshot,
} from "../codegraph/repository-manager.ts";
import type { CodeGraphRunner, SymbolKind } from "../codegraph/runner.ts";

const targetInput = {
  target: z.string().min(1).max(64).describe("Configured code target ID"),
  network: z
    .string()
    .min(1)
    .max(64)
    .describe("Configured logical network, such as devnet"),
};

const targetMetadataSchema = z.object({
  target: z.string(),
  network: z.string(),
  branch: z.string(),
  commit: z.string(),
  indexedAt: z.string(),
});

const toolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DEFAULT_CONTEXT_FILES = 6;
const MAX_CONTEXT_FILES = 12;
const DEFAULT_CONTEXT_CHARACTERS = 60_000;
const MAX_CONTEXT_CHARACTERS = 120_000;
const DEFAULT_SOURCE_CHARACTERS = 40_000;
const MAX_SOURCE_CHARACTERS = 80_000;
const MAX_TREE_CHARACTERS = 40_000;

type McpDependencies = {
  repositories: RepositoryManager;
  codegraph: CodeGraphRunner;
};

export function createCodeTruthMcpServer(
  dependencies: McpDependencies,
): McpServer {
  const server = new McpServer({
    name: "repodesk-code-truth",
    version: "1.0.0",
  });

  server.registerTool(
    "list_code_targets",
    {
      title: "List code targets",
      description:
        "List configured repositories, networks, branches, commits, and readiness. Call once at the start of a thread and reuse the result until the user requests a refresh.",
      outputSchema: {
        targets: z.array(
          z.object({
            target: z.string(),
            networks: z.array(
              z.discriminatedUnion("status", [
                targetMetadataSchema.extend({ status: z.literal("ready") }),
                z.object({
                  target: z.string(),
                  network: z.string(),
                  branch: z.string(),
                  status: z.literal("unavailable"),
                  error: z.string().optional(),
                }),
              ]),
            ),
          }),
        ),
      },
      annotations: toolAnnotations,
    },
    async (extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      const output = { targets: dependencies.repositories.statuses() };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(output, null, 2) },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code symbols",
      description:
        "Search one known symbol or identifier. Do not guess or spray synonyms; use get_code_context first for architecture or discovery questions.",
      inputSchema: {
        ...targetInput,
        query: z.string().trim().min(1).max(500),
        kind: z
          .enum([
            "function",
            "method",
            "class",
            "interface",
            "type",
            "variable",
            "route",
            "component",
          ])
          .optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, query, kind, limit }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const result = await dependencies.codegraph.search(
              snapshot.path,
              query,
              {
                limit,
                ...(kind ? { kind: kind as SymbolKind } : {}),
              },
            );
            const output = { target: publicMetadata(snapshot), result };
            return {
              content: evidenceSummary(snapshot, "Symbol matches", "result"),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "search_code_batch",
    {
      title: "Search known code symbols in one batch",
      description:
        "Search 2-8 known identifiers in one MCP round trip. Use only identifiers supplied by the user or returned by get_code_context; do not use it for speculative synonyms.",
      inputSchema: {
        ...targetInput,
        queries: z
          .array(z.string().trim().min(1).max(500))
          .min(2)
          .max(8)
          .refine(
            (queries) => new Set(queries).size === queries.length,
            "queries must be unique",
          ),
        kind: z
          .enum([
            "function",
            "method",
            "class",
            "interface",
            "type",
            "variable",
            "route",
            "component",
          ])
          .optional(),
        limitPerQuery: z.number().int().min(1).max(10).default(5),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, queries, kind, limitPerQuery }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const results = await Promise.all(
              queries.map(async (query) => ({
                query,
                result: await dependencies.codegraph.search(
                  snapshot.path,
                  query,
                  {
                    limit: limitPerQuery,
                    ...(kind ? { kind: kind as SymbolKind } : {}),
                  },
                ),
              })),
            );
            const output = { target: publicMetadata(snapshot), results };
            return {
              content: evidenceSummary(
                snapshot,
                `${queries.length} symbol searches`,
                "results",
              ),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "get_code_context",
    {
      title: "Get question-focused code context",
      description:
        "Primary tool for architecture, behavior, control-flow, debugging, or discovery. Ask one focused question; it returns related symbols and source in one call and is usually sufficient without follow-up searches.",
      inputSchema: {
        ...targetInput,
        question: z.string().trim().min(3).max(4_000),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTEXT_FILES)
          .default(DEFAULT_CONTEXT_FILES),
        maxCharacters: z
          .number()
          .int()
          .min(5_000)
          .max(MAX_CONTEXT_CHARACTERS)
          .default(DEFAULT_CONTEXT_CHARACTERS),
      },
      outputSchema: {
        target: targetMetadataSchema,
        synthesis: z.literal("client_llm"),
        context: z.string(),
        truncated: z.boolean(),
        originalCharacters: z.number().int().nonnegative(),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, question, maxFiles, maxCharacters }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const context = await dependencies.codegraph.context(
              snapshot.path,
              question,
              {
                maxFiles,
              },
            );
            const bounded = boundText(context, maxCharacters);
            const output = {
              target: publicMetadata(snapshot),
              synthesis: "client_llm" as const,
              context: bounded.text,
              truncated: bounded.truncated,
              originalCharacters: bounded.originalCharacters,
            };
            return {
              content: evidenceSummary(
                snapshot,
                "Question-focused code context",
                "context",
                bounded,
              ),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "get_symbol_source",
    {
      title: "Get exact symbol source",
      description:
        "Return source and relationships for one exact symbol. Use after get_code_context or search_code identifies the symbol; do not call repeatedly to survey an area.",
      inputSchema: {
        ...targetInput,
        symbol: z.string().trim().min(1).max(500),
        file: safeRelativeFilter()
          .optional()
          .describe("Optional file to disambiguate the symbol"),
        maxCharacters: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_SOURCE_CHARACTERS)
          .default(DEFAULT_SOURCE_CHARACTERS),
      },
      outputSchema: {
        target: targetMetadataSchema,
        symbol: z.string(),
        source: z.string(),
        truncated: z.boolean(),
        originalCharacters: z.number().int().nonnegative(),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, symbol, file, maxCharacters }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const source = await dependencies.codegraph.node(
              snapshot.path,
              symbol,
              {
                ...(file ? { file } : {}),
              },
            );
            const bounded = boundText(source, maxCharacters);
            const output = {
              target: publicMetadata(snapshot),
              symbol,
              source: bounded.text,
              truncated: bounded.truncated,
              originalCharacters: bounded.originalCharacters,
            };
            return {
              content: evidenceSummary(
                snapshot,
                `Source for ${symbol}`,
                "source",
                bounded,
              ),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "get_file_excerpt",
    {
      title: "Get an exact file excerpt",
      description:
        "Return a bounded, line-numbered excerpt when the file and relevant line range are already known. Prefer this over another broad context query.",
      inputSchema: {
        ...targetInput,
        file: safeRelativeFilter(),
        offset: z.number().int().min(1).max(10_000_000).default(1),
        limit: z.number().int().min(1).max(400).default(160),
      },
      outputSchema: {
        target: targetMetadataSchema,
        file: z.string(),
        offset: z.number().int().positive(),
        limit: z.number().int().positive(),
        excerpt: z.string(),
        truncated: z.boolean(),
        originalCharacters: z.number().int().nonnegative(),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, file, offset, limit }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const excerpt = await dependencies.codegraph.fileExcerpt(
              snapshot.path,
              file,
              {
                offset,
                limit,
              },
            );
            const bounded = boundText(excerpt, MAX_SOURCE_CHARACTERS);
            const output = {
              target: publicMetadata(snapshot),
              file,
              offset,
              limit,
              excerpt: bounded.text,
              truncated: bounded.truncated,
              originalCharacters: bounded.originalCharacters,
            };
            return {
              content: evidenceSummary(
                snapshot,
                `Excerpt from ${file}`,
                "excerpt",
                bounded,
              ),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "get_dependency_manifests",
    {
      title: "Get dependency manifests",
      description:
        "Fetch only dependency manifests (package.json, Cargo.toml, pyproject.toml, go.mod, and other common language equivalents) from the selected snapshot, including nested workspaces. Use for declared dependency/version and build configuration questions. Excludes lockfiles and generated/vendor directories; does not resolve installed versions or execute build scripts. Narrow directory if truncated.",
      inputSchema: {
        ...targetInput,
        directory: safeRelativeFilter()
          .optional()
          .describe(
            "Repository-relative subtree; defaults to the repository root",
          ),
        maxFiles: z.number().int().min(1).max(100).default(20),
        maxBytes: z
          .number()
          .int()
          .min(1_000)
          .max(80_000)
          .default(40_000)
          .describe("Total UTF-8 content byte budget across all manifests"),
      },
      outputSchema: {
        target: targetMetadataSchema,
        manifests: z.array(
          z.object({
            file: z.string(),
            ecosystem: z.string(),
            content: z.string(),
            startLine: z.number().int().positive(),
            endLine: z.number().int().nonnegative(),
            originalBytes: z.number().int().nonnegative(),
            truncated: z.boolean(),
          }),
        ),
        truncated: z.boolean(),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, directory, maxFiles, maxBytes }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const result = await readDependencyManifests(snapshot.path, {
              ...(directory ? { directory } : {}),
              maxFiles,
              maxBytes,
            });
            const label = `${result.manifests.length} dependency manifests${result.truncated ? " (truncated; narrow directory or increase limits)" : ""}`;
            return {
              content: evidenceSummary(snapshot, label, "manifests"),
              structuredContent: {
                target: publicMetadata(snapshot),
                ...result,
              },
            };
          },
        );
      });
    },
  );

  server.registerTool(
    "get_file_tree",
    {
      title: "Get indexed file tree",
      description:
        "Inspect an unfamiliar repository area. Do not call when get_code_context or an exact symbol/path already identifies the relevant files.",
      inputSchema: {
        ...targetInput,
        filter: safeRelativeFilter().optional(),
        pattern: z.string().trim().min(1).max(200).optional(),
        maxDepth: z.number().int().min(1).max(10).default(4),
      },
      outputSchema: {
        target: targetMetadataSchema,
        tree: z.string(),
        truncated: z.boolean(),
        originalCharacters: z.number().int().nonnegative(),
      },
      annotations: toolAnnotations,
    },
    async ({ target, network, filter, pattern, maxDepth }, extra) => {
      requireAuthenticatedIdentity(extra.authInfo?.extra);
      return toolBoundary(async () => {
        return dependencies.repositories.withSnapshot(
          target,
          network,
          async (snapshot) => {
            const tree = await dependencies.codegraph.files(snapshot.path, {
              ...(filter ? { filter } : {}),
              ...(pattern ? { pattern } : {}),
              maxDepth,
            });
            const bounded = boundText(tree, MAX_TREE_CHARACTERS);
            const output = {
              target: publicMetadata(snapshot),
              tree: bounded.text,
              truncated: bounded.truncated,
              originalCharacters: bounded.originalCharacters,
            };
            return {
              content: evidenceSummary(
                snapshot,
                "Indexed file tree",
                "tree",
                bounded,
              ),
              structuredContent: output,
            };
          },
        );
      });
    },
  );

  return server;
}

function publicMetadata(snapshot: Snapshot): Omit<Snapshot, "path"> {
  const { path: _path, ...metadata } = snapshot;
  return metadata;
}

type BoundedText = {
  text: string;
  truncated: boolean;
  originalCharacters: number;
};

function boundText(value: string, maxCharacters: number): BoundedText {
  if (value.length <= maxCharacters) {
    return { text: value, truncated: false, originalCharacters: value.length };
  }
  const marker =
    "\n\n[Output truncated. Request one exact symbol or file excerpt for more evidence.]";
  return {
    text: `${value.slice(0, Math.max(0, maxCharacters - marker.length))}${marker}`,
    truncated: true,
    originalCharacters: value.length,
  };
}

function evidenceSummary(
  snapshot: Snapshot,
  label: string,
  field: string,
  bounded?: BoundedText,
): Array<{ type: "text"; text: string }> {
  const truncation = bounded?.truncated
    ? ` Truncated from ${bounded.originalCharacters} characters; use an exact follow-up.`
    : "";
  return [
    {
      type: "text",
      text: `${label} for ${snapshot.target}/${snapshot.network} at ${snapshot.branch} (${snapshot.commit}). Full evidence is in structuredContent.${field}.${truncation}`,
    },
  ];
}

function requireAuthenticatedIdentity(
  extra: Record<string, unknown> | undefined,
): void {
  if (!extra || typeof extra.localPrincipal !== "string") {
    throw new Error("Authenticated local service identity is missing");
  }
}

async function toolBoundary<T>(
  operation: () => Promise<T>,
): Promise<T | ToolErrorResult> {
  try {
    return await operation();
  } catch (error) {
    const message = publicToolError(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

type ToolErrorResult = {
  isError: true;
  content: [{ type: "text"; text: string }];
};

function publicToolError(error: unknown): string {
  if (!(error instanceof Error)) return "The code query failed";
  if (
    error.message === "Unknown code target or network" ||
    error.message === "The requested code target is not indexed yet"
  ) {
    return error.message;
  }
  return "The code query failed; retry or select another ready target";
}

function safeRelativeFilter(): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((value) => !value.startsWith("/"), "must be relative")
    .refine((value) => !/^[A-Za-z]:\//.test(value), "must be relative")
    .refine((value) => !value.includes("\\"), "must use forward slashes")
    .refine(
      (value) => !value.split("/").some((segment) => segment === ".."),
      "must stay within the selected repository",
    )
    .refine(
      (value) =>
        ![...value].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
          );
        }),
      "contains control characters",
    );
}
