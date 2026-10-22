import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { ExtensionCatalog } from "../src/agent/extensions.ts";
import {
  type AgentInput,
  PiRunner,
  selectedModel,
} from "../src/agent/runtime.ts";
import { assistantSoul } from "../src/agent/soul.ts";
import { database } from "../src/db/pool.ts";
import { Store } from "../src/db/repositories.ts";
import { GitHubApp } from "../src/github/app.ts";
import { githubExtension } from "../src/github/extension.ts";
import { GitHubMetadata } from "../src/github/metadata.ts";
import { GitHubPullRequests } from "../src/github/pull-requests.ts";
import { exportVault } from "../src/obsidian/archive.ts";
import { obsidianExtension } from "../src/obsidian/extension.ts";
import { importArchive } from "../src/obsidian/import.ts";
import { ObsidianService } from "../src/obsidian/service.ts";
import { initialVault } from "../src/obsidian/vault.ts";
import { extractWebPage, requestPage } from "../src/web-reader/service.ts";

assert.ok(assistantSoul.includes("小伙伴"));
assert.ok(assistantSoul.includes("Friendliness never grants access"));

const webPage = await extractWebPage(
  "<html><head><title>Node reader</title></head><body><main><p>A useful article about reading public web pages with <strong>Defuddle</strong> and preserving the main content for readers.</p></main></body></html>",
  "https://example.com/article",
  AbortSignal.timeout(10000),
);
assert.equal(webPage.title, "Node reader");
assert.ok(webPage.markdown.includes("**Defuddle**"));
const webServer = createServer((req, res) => {
  assert.ok(req.headers.host?.startsWith("unresolvable.invalid:"));
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, undefined);
  res.end("pinned socket");
});
await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
try {
  const address = webServer.address();
  assert.ok(address && typeof address !== "string");
  const page = await requestPage(
    new URL(`http://unresolvable.invalid:${address.port}/`),
    { address: "127.0.0.1", family: 4 },
    AbortSignal.timeout(1000),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of page.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "pinned socket");
  page.cancel();
} finally {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
}

const model = selectedModel("gpt-4.1-mini");
let calls = 0;
const events: string[] = [];
const emit = (
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
) => {
  const s = new AssistantMessageEventStream();
  const m: AssistantMessage = {
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  s.push({ type: "done", reason: stopReason, message: m });
  s.end(m);
  return s;
};
let executed = 0;
const input: AgentInput = {
  actor: "test",
  runId: "node-contract",
  model,
  apiKey: "fake",
  system: "Test",
  prompt: "Test",
  transcript: [],
  maxTurns: 2,
  maxTools: 2,
  maxInputChars: 16000,
  maxOutputTokens: 128,
  signal: new AbortController().signal,
  guard: async () => {},
  reserve: async () => "test",
  checkpoint: async () => {},
  events: (t) => events.push(t),
  tools: [
    {
      name: "read",
      label: "Read",
      description: "Read",
      parameters: Type.Object({}),
      execute: async () => {
        executed++;
        return { content: [{ type: "text", text: "read" }], details: {} };
      },
    },
  ],
};
const result = await new PiRunner(() =>
  ++calls === 1
    ? emit(
        [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
        "toolUse",
      )
    : emit([{ type: "text", text: "done" }], "stop"),
).run(input);
assert.equal(result.text, "done");
assert.equal(executed, 1);
assert.equal(calls, 2);
assert.equal(events.at(-1), "agent_end");
assert.ok(
  events.indexOf("tool_execution_start") < events.indexOf("tool_execution_end"),
);
const restored = result.transcript.slice(0, -1);
const continued = await new PiRunner(() =>
  emit([{ type: "text", text: "restored" }], "stop"),
).run({ ...input, transcript: restored });
assert.equal(continued.text, "restored");
assert.equal(executed, 1);
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(
  new PiRunner(() => {
    throw Error("must not call");
  }).run({ ...input, signal: cancelled.signal }),
);
const midCallAbort = new AbortController();
let propagated = false;
await assert.rejects(
  new PiRunner((_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        propagated = true;
        const result: AssistantMessage = {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "error", reason: "aborted", error: result });
        stream.end(result);
      },
      { once: true },
    );
    setTimeout(() => midCallAbort.abort(), 10);
    return stream;
  }).run({ ...input, signal: midCallAbort.signal }),
);
assert.equal(propagated, true);
const bounded = await new PiRunner(() =>
  emit(
    [{ type: "toolCall", id: "repeat", name: "read", arguments: {} }],
    "toolUse",
  ),
).run({ ...input, maxTurns: 1 });
assert.equal(bounded.status, "partial");
const extensionDir = await mkdtemp(join(tmpdir(), "deepx-extension-contract-"));
try {
  await writeFile(
    join(extensionDir, "plugin.ts"),
    `
    import { defineTool } from "@mariozechner/pi-coding-agent";
    import { Type } from "@sinclair/typebox";
    export default function (pi) {
      pi.registerTool(defineTool({name: "extension_echo", label: "Echo", description: "Echo supplied text",
        parameters: Type.Object({text: Type.String()}),
        async execute(_id, params, _signal, _update, ctx) {
          if (ctx.hasUI) throw Error("Expected headless context");
          return {content: [{type: "text", text: params.text}], details: {}};
        }}));
      pi.on("before_agent_start", event => ({systemPrompt: event.systemPrompt + " Extension active."}));
    }
  `,
  );
  const manifest = join(extensionDir, "extensions.json");
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    manifest,
    JSON.stringify([
      {
        id: "echo-plugin",
        version: "1",
        path: "./plugin.ts",
        workspaces: [workspaceId],
        tools: ["extension_echo"],
        execution: "read-only",
      },
    ]),
  );
  let requests = 0;
  const plugins = await ExtensionCatalog.load(manifest);
  const runner = new PiRunner((_model, context) => {
    assert.ok(context.systemPrompt?.includes("Extension active."));
    return ++requests === 1
      ? emit(
          [
            {
              type: "toolCall",
              id: "extension-1",
              name: "extension_echo",
              arguments: { text: "unchanged-pi-extension" },
            },
          ],
          "toolUse",
        )
      : emit([{ type: "text", text: "extension done" }], "stop");
  }, plugins);
  const result = await runner.run({ ...input, workspaceId });
  assert.equal(result.text, "extension done");
  assert.deepEqual(
    result.transcript.find((m) => m.role === "toolResult")?.content,
    [{ type: "text", text: "unchanged-pi-extension" }],
  );
} finally {
  await rm(extensionDir, { recursive: true, force: true });
}
// No database, GitHub or model calls: verify the packaged default tools and skill in Node.
const githubStore = new Store(database("postgres://unused@127.0.0.1/unused"));
try {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const githubApp = new GitHubApp({
    id: 1,
    clientId: "fake",
    clientSecret: "fake",
    privateKey: "fake",
    slug: "fixture",
  });
  const catalog = ExtensionCatalog.fromSnapshot(
    [],
    [
      githubExtension(
        githubStore,
        workspaceId,
        {
          revision: 1,
          installationId: 1,
          repositories: [{ id: 1, full_name: "example/repository" }],
        },
        new GitHubMetadata(githubStore, githubApp),
        new GitHubPullRequests(githubStore, githubApp),
      ),
    ],
  );
  const runner = new PiRunner((_model, context) => {
    assert.ok(context.systemPrompt?.includes("# RepoDesk GitHub"));
    for (const name of [
      "find_connected_repository",
      "query_github_metadata",
      "propose_github_issue",
      "propose_github_pull_request_action",
    ])
      assert.ok(context.tools?.some((tool) => tool.name === name));
    return emit([{ type: "text", text: "github ready" }], "stop");
  }, catalog);
  assert.equal(
    (await runner.run({ ...input, workspaceId })).text,
    "github ready",
  );
  const vault = initialVault();
  assert.equal(
    importArchive(exportVault(vault)).files.length,
    vault.files.length,
  );
  const obsidian = new ObsidianService(githubStore);
  // No persisted run exists in this packaging probe; integration tests check the fence.
  obsidian.executionFence = async () => 0;
  const notesRunner = new PiRunner(
    (_model, context) => {
      assert.ok(context.systemPrompt?.includes("# RepoDesk Obsidian"));
      for (const name of ["obsidian_query", "obsidian_read", "obsidian_write"])
        assert.ok(context.tools?.some((tool) => tool.name === name));
      return emit([{ type: "text", text: "obsidian ready" }], "stop");
    },
    ExtensionCatalog.fromSnapshot(
      [],
      [obsidianExtension(obsidian, workspaceId, 0)],
    ),
  );
  assert.equal(
    (await notesRunner.run({ ...input, workspaceId })).text,
    "obsidian ready",
  );
} finally {
  await githubStore.pool.end();
}
process.stdout.write(
  `${JSON.stringify({
    node: process.version,
    pi: "0.85.1",
    toolFlow: true,
    restoration: true,
    eventOrdering: true,
    cancellation: true,
    boundedTurns: true,
    piExtensions: true,
    githubDefaults: true,
    obsidianDefaults: true,
    webReader: true,
  })}\n`,
);
