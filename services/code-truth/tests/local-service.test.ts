import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { create } from "tar";
import { ExtensionCatalog } from "../../../src/agent/extensions.ts";
import {
  type AgentInput,
  PiRunner,
  selectedModel,
} from "../../../src/agent/runtime.ts";
import { CodeTruthClient } from "../../../src/code-truth/client.ts";
import { codeTruthExtension } from "../../../src/code-truth/extension.ts";
import { createLocalService } from "../src/service.ts";
import type { CodeGraphRunner } from "../src/upstream/codegraph/runner.ts";

let root: string;
let server: Server;
let service: ReturnType<typeof createLocalService>;
let url: string;
let client: CodeTruthClient;
const token = "local-service-test-secret-".repeat(2);
const scope = randomUUID();
const targets: [import("../../../src/code-truth/config.ts").CodeTarget] = [
  {
    id: "frontend",
    repositoryUrl: "https://github.com/example/frontend.git",
    networks: { devnet: "devnet-develop" },
  },
];
const signal = new AbortController().signal;
let syncs = 0;
let clock = Date.now();
const credentialReads: (string | undefined)[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "code-truth-local-test-"));
  await mkdir(join(root, "archive"));
  await writeFile(
    join(root, "archive", "source.ts"),
    "export function hello() { return 'hello'; }",
  );
  const archive = join(root, "repo.tar");
  await create({ cwd: root, file: archive }, ["archive"]);
  const graph = {
    async initialize(path: string) {
      await mkdir(join(path, ".codegraph"));
    },
    async closeProject() {},
    async closeAll() {},
    async context() {
      return "source.ts:1 export function hello() { return 'hello'; }";
    },
  } as unknown as CodeGraphRunner;
  service = createLocalService({
    token,
    clock: () => clock,
    repositorySourceFor: (getToken) => ({
      async resolveBranch() {
        const token = getToken();
        credentialReads.push(token);
        if (!token)
          throw new Error("Private repository requires authentication");
        return "b".repeat(40);
      },
      async downloadArchive() {
        return createReadStream(archive);
      },
    }),
    dataDir: join(root, "data"),
    codegraph: graph,
    repositorySource: {
      async resolveBranch() {
        syncs++;
        return "a".repeat(40);
      },
      async downloadArchive() {
        return createReadStream(archive);
      },
    },
  });
  server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
  client = new CodeTruthClient(url, token);
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await service.close();
  await rm(root, { recursive: true, force: true });
});

test("private management rejects missing credentials, origins and arbitrary repository locations", async () => {
  expect((await fetch(`${url}/configure`, { method: "POST" })).status).toBe(
    401,
  );
  expect(
    (
      await fetch(`${url}/configure`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost",
        },
      })
    ).status,
  ).toBe(403);
  for (const repositoryUrl of [
    "file:///etc",
    "https://github.com@example.invalid/repo",
    "http://127.0.0.1/repo",
  ]) {
    expect(
      (
        await fetch(`${url}/configure`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: scope,
            targets: [{ ...targets[0], repositoryUrl }],
          }),
        })
      ).status,
    ).toBe(400);
  }
  expect(syncs).toBe(0);
});

test("local MCP exposes only configured targets, preserves commit evidence and deduplicates sync", async () => {
  let config = await client.configure(scope, targets);
  for (let i = 0; config.syncing && i < 100; i++) {
    await new Promise((done) => setTimeout(done, 10));
    config = await client.configure(scope, targets);
  }
  expect(config.targets[0]?.networks[0]?.status).toBe("ready");
  expect(syncs).toBe(1);
  const other = await client.configure(randomUUID(), [
    { ...targets[0], id: "backend" },
  ]);
  expect(other.namespace).not.toBe(config.namespace);
  await client.use(scope, targets, signal, async (mcp) => {
    const listed = await mcp.callTool({
      name: "list_code_targets",
      arguments: {},
    });
    expect(JSON.stringify(listed)).toContain("frontend");
    expect(JSON.stringify(listed)).not.toContain("backend");
    const result = await mcp.callTool({
      name: "get_code_context",
      arguments: { target: "frontend", network: "devnet", question: "hello" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      target: {
        target: "frontend",
        branch: "devnet-develop",
        commit: "a".repeat(40),
      },
    });
    expect(JSON.stringify(result.structuredContent)).toContain(
      "export function hello",
    );
    const denied = await mcp.callTool({
      name: "get_code_context",
      arguments: { target: "backend", network: "devnet", question: "hello" },
    });
    expect(denied.isError).toBe(true);
  });
});

test("predefined Pi extension loads the real MCP tools with scoped factories and source text", async () => {
  // The application starts from its project root, including under Docker.
  const cwd = process.cwd();
  process.chdir(resolve(import.meta.dir, "../../.."));
  try {
    const extension = await codeTruthExtension(client, scope, targets);
    const catalog = ExtensionCatalog.fromSnapshot([], [extension]);
    const input: AgentInput = {
      workspaceId: scope,
      actor: "101",
      runId: "test",
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fake",
      system: "policy",
      prompt: "hello",
      transcript: [],
      tools: [],
      maxTurns: 3,
      maxTools: 4,
      maxInputChars: 24000,
      maxOutputTokens: 256,
      signal,
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    expect(
      await catalog.open({ ...input, workspaceId: randomUUID() }),
    ).toBeUndefined();
    const host = await catalog.open(input);
    expect(host?.tools).toHaveLength(8);
    const tool = host?.tools.find((t) => t.name === "get_code_context");
    const result = await tool?.execute(
      "call1",
      { target: "frontend", network: "devnet", question: "hello" },
      signal,
    );
    expect(JSON.stringify(result)).toContain("export function hello");
    expect(JSON.stringify(result)).toContain("a".repeat(40));
    await host?.close();
    let turns = 0;
    const runner = new PiRunner((_model, context) => {
      expect(context.systemPrompt).toContain("## Configured repositories");
      expect(context.tools?.map((tool) => tool.name)).toContain(
        "get_code_context",
      );
      turns++;
      if (turns === 2)
        expect(JSON.stringify(context.messages)).toContain(
          "export function hello",
        );
      const message: AssistantMessage = {
        role: "assistant",
        api: input.model.api,
        provider: input.model.provider,
        model: input.model.id,
        timestamp: 1,
        stopReason: turns === 1 ? "toolUse" : "stop",
        content:
          turns === 1
            ? [
                {
                  type: "toolCall",
                  id: "code-query",
                  name: "get_code_context",
                  arguments: {
                    target: "frontend",
                    network: "devnet",
                    question: "hello",
                  },
                },
              ]
            : [{ type: "text", text: "Verified source" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
      return stream;
    }, catalog);
    expect((await runner.run(input)).text).toBe("Verified source");
    expect(turns).toBe(2);
    const changed = await codeTruthExtension(client, scope, [
      { ...targets[0], networks: { devnet: "other" } },
    ]);
    expect(ExtensionCatalog.fromSnapshot([], [changed]).version).not.toBe(
      catalog.version,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      client.use(scope, targets, aborted.signal, async () => true),
    ).rejects.toThrow();
  } finally {
    process.chdir(cwd);
  }
});

test("workspace installation tokens rotate without sharing snapshots or falling back after disconnect", async () => {
  let token = "fixture-installation-a";
  const scoped = client.withGitHub(async () => ({
    token,
    identity: "app:123:501:1",
  }));
  let first = await scoped.configure(scope, targets);
  for (let i = 0; first.syncing && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    first = await scoped.configure(scope, targets);
  }
  expect(first.targets[0]?.networks[0]?.status).toBe("ready");
  expect(JSON.stringify(first)).not.toContain(token);
  token = "fixture-installation-b";
  clock += 300001;
  let rotated = await scoped.configure(scope, targets);
  for (let i = 0; rotated.syncing && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    rotated = await scoped.configure(scope, targets);
  }
  expect(rotated.namespace).toBe(first.namespace);
  expect(credentialReads).toContain("fixture-installation-b");
  const disconnected = client.withGitHub(async () => ({
    token: null,
    identity: "disconnected:2",
  }));
  let off = await disconnected.configure(scope, targets);
  for (let i = 0; off.syncing && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    off = await disconnected.configure(scope, targets);
  }
  expect(off.namespace).not.toBe(first.namespace);
  expect(off.targets[0]?.networks[0]?.status).toBe("unavailable");
  const sibling = await scoped.configure(randomUUID(), targets);
  expect(sibling.namespace).not.toBe(first.namespace);
});
