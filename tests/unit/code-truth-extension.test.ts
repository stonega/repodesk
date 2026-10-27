import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { codeTruthToolCatalog } from "../../services/code-truth/src/tool-catalog.ts";
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
  toolCalls = 0;
  tools = structuredClone(codeTruthToolCatalog) as unknown as Tool[];
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
    return action({
      listTools: async () => ({ tools: this.tools }),
      callTool: async () => {
        this.toolCalls++;
        return { content: [{ type: "text", text: "source" }] };
      },
    } as unknown as Client);
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
  test(`${code} cannot affect greetings and is enforced when source is requested`, async () => {
    const client = new RepositoryClient();
    const error = new Fault(code, 503);
    error.message += ": private diagnostic secret";
    let resolutions = 0;
    const reported: unknown[] = [];
    const extension = await codeTruthExtension(
      client,
      workspaceId,
      targets,
      1,
      code === "code_truth_unavailable"
        ? undefined
        : async () => {
            resolutions++;
            throw error;
          },
      (runId, failure) => reported.push({ runId, failure }),
    );
    if (code === "code_truth_unavailable") client.error = error;
    const catalog = ExtensionCatalog.fromSnapshot([], [extension]);
    const runner = new PiRunner((_model, context) => {
      expect(context.tools?.map((tool) => tool.name)).toEqual([
        "unrelated_tool",
        ...codeTruthTools,
      ]);
      expect(context.systemPrompt).not.toContain("private diagnostic secret");
      return reply();
    }, catalog);
    expect((await runner.run(input())).text).toBe("Hello");
    expect(client.calls).toBe(0);
    expect(resolutions).toBe(0);
    const host = await catalog.open(input());
    try {
      await expect(
        host?.tools[0]?.execute("source-1", {}, input().signal),
      ).rejects.toMatchObject({ code, message: code });
      expect(client.toolCalls).toBe(0);
      expect(reported).toEqual([{ runId: "test-run", failure: error }]);
    } finally {
      await host?.close();
    }
  });
}

test("source permissions are rechecked on every call and recover without a new chat host", async () => {
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
      if (!allowed) throw new Fault("github_user_access_denied", 403);
      return { client, targets };
    },
  );
  const host = await ExtensionCatalog.fromSnapshot([], [extension]).open(
    input(),
  );
  try {
    const tool = host?.tools[0];
    expect(host?.tools.map((tool) => tool.name)).toEqual([...codeTruthTools]);
    expect(resolutions).toBe(0);
    await expect(tool?.execute("denied", {}, input().signal)).rejects.toThrow(
      "github_user_access_denied",
    );
    allowed = true;
    expect(
      (await tool?.execute("allowed", {}, input().signal))?.content,
    ).toEqual([{ type: "text", text: '[{"type":"text","text":"source"}]' }]);
    allowed = false;
    await expect(tool?.execute("revoked", {}, input().signal)).rejects.toThrow(
      "github_user_access_denied",
    );
    expect(resolutions).toBe(3);
    expect(client.toolCalls).toBe(1);
    expect(client.calls).toBe(1);
  } finally {
    await host?.close();
  }
});

test("unknown upstream errors never enter startup and stay private on source calls", async () => {
  const client = new RepositoryClient();
  client.error = new Error("private upstream secret");
  const extension = await codeTruthExtension(client, workspaceId, targets);
  const host = await ExtensionCatalog.fromSnapshot([], [extension]).open(
    input(),
  );
  try {
    expect(client.calls).toBe(0);
    await expect(
      host?.tools[0]?.execute("source", {}, input().signal),
    ).rejects.toMatchObject({
      code: "extension_tool_failed",
      message: "extension_tool_failed",
    });
  } finally {
    await host?.close();
  }
});

test("missing Code Truth configuration is reported only when source is requested", async () => {
  const extension = await codeTruthExtension(undefined, workspaceId, targets);
  const host = await ExtensionCatalog.fromSnapshot([], [extension]).open(
    input(),
  );
  try {
    await expect(
      host?.tools[0]?.execute("source", {}, input().signal),
    ).rejects.toThrow("code_truth_unavailable");
  } finally {
    await host?.close();
  }
});

test("remote catalog and schema mismatches deny source execution before calling any tool", async () => {
  for (const mismatch of ["missing", "duplicate", "schema"]) {
    const client = new RepositoryClient();
    if (mismatch === "missing") client.tools.pop();
    if (mismatch === "duplicate") client.tools[1] = client.tools[0] as Tool;
    if (mismatch === "schema")
      client.tools[0] = {
        ...(client.tools[0] as Tool),
        inputSchema: { type: "object", required: ["unexpected"] },
      };
    const extension = await codeTruthExtension(client, workspaceId, targets);
    const host = await ExtensionCatalog.fromSnapshot([], [extension]).open(
      input(),
    );
    try {
      await expect(
        host?.tools[0]?.execute("source", {}, input().signal),
      ).rejects.toThrow("code_truth_tools_changed");
      expect(client.toolCalls).toBe(0);
    } finally {
      await host?.close();
    }
  }
});

test("cancelled source calls cannot contact repositories or permissions services", async () => {
  const controller = new AbortController();
  const client = new RepositoryClient();
  let resolutions = 0;
  const extension = await codeTruthExtension(
    client,
    workspaceId,
    targets,
    1,
    async () => {
      resolutions++;
      return { client, targets };
    },
  );
  const host = await ExtensionCatalog.fromSnapshot([], [extension]).open(
    input({ signal: controller.signal }),
  );
  try {
    controller.abort();
    await expect(
      host?.tools[0]?.execute("source", {}, controller.signal),
    ).rejects.toThrow();
    expect(client.calls).toBe(0);
    expect(resolutions).toBe(0);
  } finally {
    await host?.close();
  }
});
