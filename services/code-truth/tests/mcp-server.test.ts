import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  RepositoryManager,
  Snapshot,
} from "../src/upstream/codegraph/repository-manager.ts";
import type { CodeGraphRunner } from "../src/upstream/codegraph/runner.ts";
import { createCodeTruthMcpServer } from "../src/upstream/http/mcp-server.ts";

const clients: Client[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Code Truth MCP query contract", () => {
  test("advertises the context-first and exact-evidence tools", async () => {
    const { client } = await connectedClient(recordingCodeGraph());
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_code_targets",
      "search_code",
      "search_code_batch",
      "get_code_context",
      "get_symbol_source",
      "get_file_excerpt",
      "get_dependency_manifests",
      "get_file_tree",
    ]);
    expect(
      tools.tools.find((tool) => tool.name === "get_code_context")?.description,
    ).toContain("Primary tool");
    expect(
      tools.tools.find((tool) => tool.name === "search_code")?.description,
    ).toContain("Do not guess");
  });

  test("keeps the Codex example allowlist aligned with every advertised tool", async () => {
    const { client } = await connectedClient(recordingCodeGraph());
    const advertised = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    const configuration = Bun.TOML.parse(
      await Bun.file(
        new URL("../examples/codex-config.toml", import.meta.url),
      ).text(),
    ) as { mcp_servers: { "deepx-code-truth": { enabled_tools: string[] } } };
    expect(
      configuration.mcp_servers["deepx-code-truth"].enabled_tools.toSorted(),
    ).toEqual(advertised);
  });

  test("returns one bounded copy of large context with explicit truncation metadata", async () => {
    const codegraph = recordingCodeGraph({ context: "x".repeat(6_000) });
    const { client } = await connectedClient(codegraph);
    const result = await client.callTool({
      name: "get_code_context",
      arguments: {
        target: "deepx-web",
        network: "testnet",
        question: "Where are contract addresses configured?",
        maxCharacters: 5_000,
      },
    });

    expect(result.isError).not.toBeTrue();
    const structured = result.structuredContent as {
      context: string;
      truncated: boolean;
      originalCharacters: number;
    };
    expect(structured.context).toHaveLength(5_000);
    expect(structured.context).toEndWith(
      "Request one exact symbol or file excerpt for more evidence.]",
    );
    expect(structured.truncated).toBeTrue();
    expect(structured.originalCharacters).toBe(6_000);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(content)).not.toContain("x".repeat(1_000));
    expect(codegraph.calls.context).toEqual([
      {
        projectPath: "/snapshots/deepx-web/testnet/abc123",
        question: "Where are contract addresses configured?",
        maxFiles: 6,
      },
    ]);
  });

  test("batches known searches and supports exact symbol and file follow-ups", async () => {
    const codegraph = recordingCodeGraph();
    const { client } = await connectedClient(codegraph);

    const batch = await client.callTool({
      name: "search_code_batch",
      arguments: {
        target: "deepx-web",
        network: "testnet",
        queries: ["RouterAddress", "MarketAddress"],
      },
    });
    const symbol = await client.callTool({
      name: "get_symbol_source",
      arguments: {
        target: "deepx-web",
        network: "testnet",
        symbol: "RouterAddress",
        file: "src/contracts.ts",
      },
    });
    const excerpt = await client.callTool({
      name: "get_file_excerpt",
      arguments: {
        target: "deepx-web",
        network: "testnet",
        file: "src/contracts.ts",
        offset: 30,
        limit: 20,
      },
    });

    expect(
      (batch.structuredContent as { results: unknown[] }).results,
    ).toHaveLength(2);
    expect((symbol.structuredContent as { source: string }).source).toBe(
      "symbol source",
    );
    expect((excerpt.structuredContent as { excerpt: string }).excerpt).toBe(
      "file excerpt",
    );
    expect(codegraph.calls.search.map((call) => call.query)).toEqual([
      "RouterAddress",
      "MarketAddress",
    ]);
    expect(codegraph.calls.node).toEqual([
      {
        projectPath: "/snapshots/deepx-web/testnet/abc123",
        symbol: "RouterAddress",
        file: "src/contracts.ts",
      },
    ]);
    expect(codegraph.calls.fileExcerpt).toEqual([
      {
        projectPath: "/snapshots/deepx-web/testnet/abc123",
        file: "src/contracts.ts",
        offset: 30,
        limit: 20,
      },
    ]);
  });

  test("rejects file traversal before invoking CodeGraph", async () => {
    const codegraph = recordingCodeGraph();
    const { client } = await connectedClient(codegraph);

    for (const file of ["../secrets", "..\\secrets", "C:/secrets"]) {
      const result = await client.callTool({
        name: "get_file_excerpt",
        arguments: {
          target: "deepx-web",
          network: "testnet",
          file,
        },
      });
      expect(result.isError).toBeTrue();
    }
    expect(codegraph.calls.fileExcerpt).toHaveLength(0);
  });

  test("fetches manifests directly from the selected snapshot with provenance and one content copy", async () => {
    const path = await mkdtemp(join(tmpdir(), "code-truth-mcp-manifests-"));
    directories.push(path);
    const content = '{"dependencies":{"react":"^19"}}';
    await writeFile(join(path, "package.json"), content);
    const codegraph = recordingCodeGraph();
    const { client } = await connectedClient(codegraph, { path });
    const result = await client.callTool({
      name: "get_dependency_manifests",
      arguments: { target: "deepx-web", network: "testnet" },
    });
    expect(result.isError).not.toBeTrue();
    expect(result.structuredContent).toEqual({
      target: {
        target: "deepx-web",
        network: "testnet",
        branch: "testnet-develop",
        commit: "abc123",
        indexedAt: "2026-09-01T00:00:00.000Z",
      },
      manifests: [
        {
          file: "package.json",
          ecosystem: "javascript",
          content,
          startLine: 1,
          endLine: 1,
          originalBytes: Buffer.byteLength(content),
          truncated: false,
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result.content)).not.toContain("react");
    expect(Object.values(codegraph.calls).flat()).toHaveLength(0);
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "get_dependency_manifests",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("denies manifest queries without an authenticated identity", async () => {
    const { client } = await connectedClient(recordingCodeGraph(), {
      authenticated: false,
    });
    const result = await client.callTool({
      name: "get_dependency_manifests",
      arguments: { target: "deepx-web", network: "testnet" },
    });
    expect(result.isError).toBeTrue();
    expect(result.content).toEqual([
      { type: "text", text: "Authenticated local service identity is missing" },
    ]);
  });

  test("rejects invalid manifest inputs and unknown targets without leaking snapshot paths", async () => {
    const { client } = await connectedClient(recordingCodeGraph());
    for (const invalid of [
      { directory: "../secrets" },
      { directory: "/etc" },
      { directory: "C:/secrets" },
      { directory: "..\\secrets" },
      { maxFiles: 101 },
      { maxBytes: 80_001 },
      { target: "other" },
      { network: "other" },
    ]) {
      const result = await client.callTool({
        name: "get_dependency_manifests",
        arguments: { target: "deepx-web", network: "testnet", ...invalid },
      });
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result)).not.toContain("/snapshots/");
    }
    const failedRead = await client.callTool({
      name: "get_dependency_manifests",
      arguments: { target: "deepx-web", network: "testnet" },
    });
    expect(failedRead.isError).toBeTrue();
    expect(JSON.stringify(failedRead)).not.toContain("/snapshots/");
  });
});

type RecordingCodeGraph = {
  calls: {
    search: Array<{ projectPath: string; query: string; limit: number }>;
    context: Array<{ projectPath: string; question: string; maxFiles: number }>;
    node: Array<{ projectPath: string; symbol: string; file?: string }>;
    fileExcerpt: Array<{
      projectPath: string;
      file: string;
      offset: number;
      limit: number;
    }>;
  };
  search(
    projectPath: string,
    query: string,
    options: { limit: number; kind?: string },
  ): Promise<unknown>;
  context(
    projectPath: string,
    question: string,
    options: { maxFiles: number },
  ): Promise<string>;
  node(
    projectPath: string,
    symbol: string,
    options: { file?: string },
  ): Promise<string>;
  fileExcerpt(
    projectPath: string,
    file: string,
    options: { offset: number; limit: number },
  ): Promise<string>;
  files(): Promise<string>;
};

function recordingCodeGraph(
  options: { context?: string } = {},
): RecordingCodeGraph {
  const calls: RecordingCodeGraph["calls"] = {
    search: [],
    context: [],
    node: [],
    fileExcerpt: [],
  };
  return {
    calls,
    async search(projectPath, query, searchOptions) {
      calls.search.push({ projectPath, query, limit: searchOptions.limit });
      return [{ name: query, file: "src/contracts.ts", line: 10 }];
    },
    async context(projectPath, question, contextOptions) {
      calls.context.push({
        projectPath,
        question,
        maxFiles: contextOptions.maxFiles,
      });
      return options.context ?? "focused context";
    },
    async node(projectPath, symbol, nodeOptions) {
      calls.node.push({
        projectPath,
        symbol,
        ...(nodeOptions.file ? { file: nodeOptions.file } : {}),
      });
      return "symbol source";
    },
    async fileExcerpt(projectPath, file, excerptOptions) {
      calls.fileExcerpt.push({ projectPath, file, ...excerptOptions });
      return "file excerpt";
    },
    async files() {
      return "src/";
    },
  };
}

async function connectedClient(
  codegraph: RecordingCodeGraph,
  options: { path?: string; authenticated?: boolean } = {},
): Promise<{ client: Client }> {
  const snapshot: Snapshot = {
    target: "deepx-web",
    network: "testnet",
    branch: "testnet-develop",
    commit: "abc123",
    indexedAt: "2026-09-01T00:00:00.000Z",
    path: options.path ?? "/snapshots/deepx-web/testnet/abc123",
  };
  const repositories = {
    statuses: () => [
      {
        target: snapshot.target,
        networks: [{ ...snapshot, path: undefined, status: "ready" }],
      },
    ],
    async withSnapshot<T>(
      target: string,
      network: string,
      operation: (value: Snapshot) => Promise<T>,
    ) {
      if (target !== snapshot.target || network !== snapshot.network) {
        throw new Error("Unknown code target or network");
      }
      return operation(snapshot);
    },
  } as unknown as RepositoryManager;
  const server = createCodeTruthMcpServer({
    repositories,
    codegraph: codegraph as unknown as CodeGraphRunner,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, sendOptions) =>
    send(message, {
      ...sendOptions,
      authInfo: {
        token: "test-token",
        clientId: "test-client",
        scopes: ["code:read"],
        extra:
          options.authenticated === false ? {} : { localPrincipal: "stone" },
      },
    });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}
