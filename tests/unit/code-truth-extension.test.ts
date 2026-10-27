import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Type } from "typebox";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import {
  type AgentInput,
  PiRunner,
  selectedModel,
} from "../../src/agent/runtime.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { codeTruthTools } from "../../src/code-truth/config.ts";
import { codeTruthExtension } from "../../src/code-truth/extension.ts";
import { Fault } from "../../src/domain.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const targets = [
  {
    id: "source",
    repositoryUrl: "https://github.com/example/source",
    networks: { default: "HEAD" },
  },
];
function input(patch: Partial<AgentInput> = {}): AgentInput {
  return {
    workspaceId,
    actor: "101",
    runId: "test-run",
    model: selectedModel("gpt-4.1-mini"),
    apiKey: "fake",
    system: "Existing policy",
    prompt: "hi",
    transcript: [],
    tools: [
      {
        name: "unrelated_tool",
        label: "Unrelated tool",
        description: "A tool independent of repository access",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: {} }),
      },
    ],
    maxTurns: 1,
    maxTools: 1,
    maxInputChars: 16000,
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async () => "attempt",
    checkpoint: async () => {},
    ...patch,
  };
}
function reply() {
  const model = selectedModel("gpt-4.1-mini");
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
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
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}
class RepositoryClient extends CodeTruthClient {
  calls = 0;
  error?: Error;
  tools = codeTruthTools.map((name) => ({
    name,
    inputSchema: { type: "object", properties: {} },
  }));
  constructor() {
    super("http://unused.invalid", "unused");
  }
  override async use<T>(
    _workspaceId: string,
    _targets: typeof targets,
    _signal: AbortSignal,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    this.calls++;
    if (this.error) throw this.error;
    return action({ listTools: async () => ({ tools: this.tools }) } as Client);
  }
}

for (const code of [
  "github_user_access_denied",
  "github_user_access_unavailable",
  "github_app_not_configured",
  "github_repository_not_connected",
  "github_app_permissions_missing",
  "github_access_denied",
  "github_rate_limited",
  "github_unavailable",
  "code_truth_unavailable",
]) {
  test(`${code} leaves unrelated chat working without exposing source tools or private errors`, async () => {
    const client = new RepositoryClient();
    const error = new Fault(code, 503);
    error.message += ": private diagnostic secret";
    const extension = await codeTruthExtension(
      client,
      workspaceId,
      targets,
      1,
      code === "code_truth_unavailable"
        ? undefined
        : async () => {
            throw error;
          },
    );
    if (code === "code_truth_unavailable") client.error = error;
    let dispatched = 0;
    const runner = new PiRunner(
      (_model, context) => {
        dispatched++;
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          "unrelated_tool",
        ]);
        expect(context.systemPrompt).toContain(
          `unavailable for this run (${code})`,
        );
        expect(context.systemPrompt).toContain(
          "Do not claim to have inspected",
        );
        expect(context.systemPrompt).not.toContain("private diagnostic secret");
        expect(context.systemPrompt).not.toContain(
          "## Configured repositories",
        );
        return reply();
      },
      ExtensionCatalog.fromSnapshot([], [extension]),
    );
    expect((await runner.run(input())).text).toBe("Hello");
    expect(dispatched).toBe(1);
    expect(client.calls).toBe(code === "code_truth_unavailable" ? 1 : 0);
  });
}

test("recovery is retried per run, and repository permission is rechecked before every source call", async () => {
  const client = new RepositoryClient();
  let allowed = false;
  let resolutions = 0;
  const extension = await codeTruthExtension(
    client,
    workspaceId,
    targets,
    1,
    async (actor) => {
      expect(actor).toBe("101");
      resolutions++;
      if (!allowed) {
        const error = new Fault("github_user_access_denied", 403);
        error.message += ": private secret";
        throw error;
      }
      return { client, targets };
    },
  );
  const catalog = ExtensionCatalog.fromSnapshot([], [extension]);
  const denied = await catalog.open(input());
  try {
    expect(denied?.tools).toEqual([]);
  } finally {
    await denied?.close();
  }
  allowed = true;
  const recovered = await catalog.open(input());
  try {
    expect(recovered?.tools.map((tool) => tool.name)).toEqual([
      ...codeTruthTools,
    ]);
    allowed = false;
    const error = await recovered?.tools[0]
      ?.execute("read-1", {}, input().signal)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "github_user_access_denied" });
    expect(error).toHaveProperty("message", "github_user_access_denied");
    expect(client.calls).toBe(1);
    expect(resolutions).toBe(3);
    allowed = true;
    client.error = new Fault("code_truth_unavailable", 503);
    client.error.message += ": private secret";
    await expect(
      recovered?.tools[0]?.execute("read-2", {}, input().signal),
    ).rejects.toMatchObject({
      code: "code_truth_unavailable",
      message: "code_truth_unavailable",
    });
  } finally {
    await recovered?.close();
  }
});

test("unexpected faults and tool contract changes still fail before model dispatch", async () => {
  const client = new RepositoryClient();
  for (const error of [
    new Error("private secret"),
    new Fault("unlisted", 409),
  ]) {
    client.error = error;
    const extension = await codeTruthExtension(client, workspaceId, targets);
    await expect(
      ExtensionCatalog.fromSnapshot([], [extension]).open(input()),
    ).rejects.toThrow("extension_load_failed");
  }
  client.error = undefined;
  client.tools.pop();
  const extension = await codeTruthExtension(client, workspaceId, targets);
  await expect(
    ExtensionCatalog.fromSnapshot([], [extension]).open(input()),
  ).rejects.toThrow("extension_load_failed");
});

test("aborting repository setup cannot turn cancellation into a degraded model turn", async () => {
  const controller = new AbortController();
  const client = new RepositoryClient();
  const extension = await codeTruthExtension(
    client,
    workspaceId,
    targets,
    1,
    async () => {
      controller.abort();
      throw new Fault("code_truth_unavailable", 503);
    },
  );
  let dispatched = 0;
  const runner = new PiRunner(
    () => {
      dispatched++;
      return reply();
    },
    ExtensionCatalog.fromSnapshot([], [extension]),
  );
  await expect(
    runner.run(input({ signal: controller.signal })),
  ).rejects.toThrow();
  expect(dispatched).toBe(0);
  expect(client.calls).toBe(0);
});
