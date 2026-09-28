import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import type { GitHubRepositorySource } from "./upstream/codegraph/github-repository-source.ts";
import { RepositoryManager } from "./upstream/codegraph/repository-manager.ts";
import type { CodeGraphRunner } from "./upstream/codegraph/runner.ts";
import { codeTargetSchema } from "./upstream/config/schema.ts";
import { createCodeTruthMcpServer } from "./upstream/http/mcp-server.ts";

const configuration = z
  .object({
    workspaceId: z.string().uuid(),
    github: z
      .object({
        token: z.string().min(1).max(8192).nullable(),
        identity: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    targets: z
      .array(codeTargetSchema)
      .min(1)
      .max(12)
      .refine((v) => new Set(v.map((t) => t.id)).size === v.length),
  })
  .strict();
type Entry = {
  repositories: RepositoryManager;
  touched: number;
  synced: number;
  syncing?: Promise<unknown>;
  requests: number;
  githubToken?: string | null;
};
export function createLocalService(options: {
  token: string;
  dataDir: string;
  codegraph: CodeGraphRunner;
  repositorySource: GitHubRepositorySource;
  repositorySourceFor?: (
    getToken: () => string | undefined,
  ) => GitHubRepositorySource;
  clock?: () => number;
}) {
  if (options.token.length < 32)
    throw new Error("CODE_TRUTH_TOKEN must contain at least 32 characters");
  const entries = new Map<string, Entry>();
  const now = options.clock ?? Date.now;
  const app = express();
  app.disable("x-powered-by");
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use((req, res, next) => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Service-to-service only; never accept browser-origin requests.
    if (req.headers.origin) {
      res.status(403).json({ error: "origin_denied" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const sync = (entry: Entry) => {
    if (entry.syncing) return;
    entry.synced = now();
    entry.syncing = entry.repositories
      .syncAll()
      .catch(() => undefined)
      .finally(() => {
        entry.syncing = undefined;
      });
  };
  app.post("/configure", (req, res) => {
    const parsed = configuration.safeParse(req.body);
    if (
      !parsed.success ||
      parsed.data.targets.some((t) => Object.keys(t.networks).length > 8)
    ) {
      res.status(400).json({ error: "invalid_configuration" });
      return;
    }
    const { github, ...data } = parsed.data;
    if (github && !options.repositorySourceFor) {
      res.status(503).json({ error: "workspace_credentials_unsupported" });
      return;
    }
    const namespace = createHash("sha256")
      .update(
        JSON.stringify(
          github ? { ...data, githubIdentity: github.identity } : data,
        ),
      )
      .digest("hex");
    let entry = entries.get(namespace);
    if (!entry) {
      // Evict only idle managers; immutable disk snapshots remain for later reuse.
      for (const [id, candidate] of entries) {
        if (
          !candidate.requests &&
          !candidate.syncing &&
          now() - candidate.touched > 3600_000
        )
          entries.delete(id);
      }
      if (entries.size >= 128) {
        res.status(503).json({ error: "capacity_reached" });
        return;
      }
      const credentials = { token: github?.token };
      entry = {
        repositories: new RepositoryManager({
          dataDir: join(options.dataDir, namespace),
          targets: data.targets,
          snapshotRetention: 2,
          codegraph: options.codegraph,
          repositorySource:
            github && options.repositorySourceFor
              ? options.repositorySourceFor(
                  () => credentials.token ?? undefined,
                )
              : options.repositorySource,
        }),
        touched: now(),
        synced: 0,
        requests: 0,
        get githubToken() {
          return credentials.token;
        },
        set githubToken(value) {
          credentials.token = value;
        },
      };
      entries.set(namespace, entry);
      sync(entry);
    }
    if (github) entry.githubToken = github.token;
    entry.touched = now();
    if (now() - entry.synced >= 300_000) sync(entry);
    res.json({
      namespace,
      syncing: Boolean(entry.syncing),
      targets: entry.repositories.statuses(),
    });
  });
  app.post("/mcp/:namespace", async (req, res) => {
    const entry = entries.get(req.params.namespace);
    if (!entry) {
      res.status(404).json({ error: "configuration_unavailable" });
      return;
    }
    entry.touched = now();
    entry.requests++;
    // Identity is established above, never taken from MCP arguments.
    Object.assign(req, {
      auth: {
        token: "internal",
        clientId: "repodesk",
        scopes: ["code:read"],
        extra: { localPrincipal: req.params.namespace },
      },
    });
    const server = createCodeTruthMcpServer({
      repositories: entry.repositories,
      codegraph: options.codegraph,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "mcp_request_failed" });
    } finally {
      entry.requests--;
      await server.close();
    }
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "invalid_request" });
    },
  );
  return {
    app,
    close: async () => {
      await Promise.all([...entries.values()].map((e) => e.syncing));
      await options.codegraph.closeAll();
    },
  };
}
