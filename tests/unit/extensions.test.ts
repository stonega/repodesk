import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import {
  type BuiltinExtension,
  ExtensionCatalog,
} from "../../src/agent/extensions.ts";
import {
  type AgentInput,
  PiRunner,
  selectedModel,
} from "../../src/agent/runtime.ts";
import { Fault } from "../../src/domain.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function catalog(source?: string, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deepx-extension-test-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "extension.ts"),
    source ?? (await readFile(resolve("examples/pi-extension.ts"), "utf8")),
  );
  const file = join(dir, "extensions.json");
  await writeFile(
    file,
    JSON.stringify([
      {
        id: "test-plugin",
        version: "1",
        path: "./extension.ts",
        workspaces: [workspaceId],
        tools: ["count_words"],
        execution: "read-only",
        ...patch,
      },
    ]),
  );
  return { catalog: await ExtensionCatalog.load(file), dir, file };
}
function input(patch: Partial<AgentInput> = {}): AgentInput {
  return {
    workspaceId,
    actor: "101",
    runId: "test-run",
    model: selectedModel("gpt-4.1-mini"),
    apiKey: "fake",
    system: "Existing policy",
    prompt: "count",
    transcript: [],
    tools: [],
    maxTurns: 3,
    maxTools: 4,
    maxInputChars: 16000,
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    guard: async () => {},
    reserve: async () => "attempt",
    checkpoint: async () => {},
    ...patch,
  };
}
function stream(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" = "stop",
) {
  const model = selectedModel("gpt-4.1-mini");
  const message: AssistantMessage = {
    role: "assistant",
    content,
    stopReason,
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
  stream.push({ type: "done", reason: stopReason, message });
  stream.end(message);
  return stream;
}
const call = {
  type: "toolCall" as const,
  id: "call-1",
  name: "count_words",
  arguments: { text: "two words" },
};

test("only allowlisted built-in fault codes reach the model and raw exception text stays private", async () => {
  for (const error of [
    new Fault("coding_direct_execution_disabled", 409),
    new Fault("unlisted_private_code", 409),
    new Error("private secret"),
  ]) {
    error.message += ": private secret";
    const builtin: BuiltinExtension = {
      id: "builtin-test",
      version: "1",
      path: "<inline:builtin-test>",
      tools: ["count_words"],
      execution: "read-only",
      enabled: true,
      workspaces: [workspaceId],
      hash: "fixture",
      toolErrorCodes: ["coding_direct_execution_disabled"],
      factory: () => async (pi) => {
        pi.registerTool({
          name: "count_words",
          label: "Test",
          description: "Test",
          parameters: Type.Object({ text: Type.String() }),
          execute: async () => {
            throw error;
          },
        });
      },
    };
    const runner = new PiRunner(
      () => stream([call], "toolUse"),
      ExtensionCatalog.fromSnapshot([], [builtin]),
    );
    const result = await runner.run(input({ maxTurns: 1 }));
    const tool = result.transcript.find((m) => m.role === "toolResult");
    expect(tool?.isError).toBe(true);
    expect(tool?.content).toEqual([
      {
        type: "text",
        text:
          error instanceof Fault &&
          error.code === "coding_direct_execution_disabled"
            ? error.code
            : "extension_tool_failed",
      },
    ]);
    expect(JSON.stringify(tool)).not.toContain("private secret");
  }
  const { catalog: filePlugin } = await catalog(
    `import { Type } from "@sinclair/typebox";
     export default pi => pi.registerTool({name:"count_words",label:"Test",description:"Test",parameters:Type.Object({text:Type.String()}),execute:async()=>{throw Error("coding_direct_execution_disabled: private secret");}});`,
  );
  const result = await new PiRunner(
    () => stream([call], "toolUse"),
    filePlugin,
  ).run(input({ maxTurns: 1 }));
  expect(
    result.transcript.find((m) => m.role === "toolResult")?.content,
  ).toEqual([{ type: "text", text: "extension_tool_failed" }]);
});

test("loads an unchanged Pi extension, runs its hook and validated tool, and checkpoints results", async () => {
  const { catalog: plugins } = await catalog();
  const saved: AgentMessage[] = [];
  let calls = 0;
  const runner = new PiRunner((_model, context) => {
    expect(context.systemPrompt).toContain("Existing policy");
    expect(context.systemPrompt).toContain("Use count_words");
    expect(context.tools?.map((tool) => tool.name)).toEqual(["count_words"]);
    return ++calls === 1
      ? stream([call], "toolUse")
      : stream([{ type: "text", text: "Done" }]);
  }, plugins);
  const result = await runner.run(
    input({
      checkpoint: async (message) => {
        saved.push(message);
      },
    }),
  );
  expect(result.tools).toBe(1);
  expect(result.text).toBe("Done");
  expect(
    saved.find((message) => message.role === "toolResult")?.content,
  ).toEqual([{ type: "text", text: "2" }]);
});

test("workspace grants exclude extensions before module import", async () => {
  const { catalog: plugins } = await catalog(
    'throw Error("must not load"); export default function () {}',
  );
  const runner = new PiRunner((_model, context) => {
    expect(context.tools).toEqual([]);
    expect(context.systemPrompt).toBe("Existing policy");
    return stream([{ type: "text", text: "Done" }]);
  }, plugins);
  await runner.run(
    input({ workspaceId: "00000000-0000-4000-8000-000000000002" }),
  );
  await runner.run(input({ workspaceId: undefined }));
});

test("entry file changes fail closed and remote install sources are rejected", async () => {
  const { catalog: plugins, dir } = await catalog();
  await writeFile(join(dir, "extension.ts"), "export default () => {}");
  await expect(plugins.open(input())).rejects.toThrow("extension_changed");
  await expect(catalog(undefined, { path: "npm:untrusted" })).rejects.toThrow(
    "extension_configuration_invalid",
  );
});

test("unsupported hooks, ungranted tools, collisions and load errors fail before provider dispatch", async () => {
  let dispatched = 0;
  const cases = [
    {
      source: 'export default pi => pi.on("input", () => {});',
      patch: {},
      error: "extension_event_unsupported",
    },
    {
      source:
        'export default pi => pi.registerCommand("hello", { handler: async () => {} });',
      patch: {},
      error: "extension_api_unsupported",
    },
    {
      source: 'throw Error("secret"); export default () => {};',
      patch: {},
      error: "extension_load_failed",
    },
    {
      source: undefined,
      patch: { tools: [] },
      error: "extension_tool_not_granted",
    },
  ];
  for (const fixture of cases) {
    const { catalog: plugins } = await catalog(fixture.source, fixture.patch);
    await expect(
      new PiRunner(() => {
        dispatched++;
        return stream([]);
      }, plugins).run(input()),
    ).rejects.toThrow(fixture.error);
  }
  const { catalog: plugins } = await catalog();
  await expect(
    new PiRunner(() => {
      dispatched++;
      return stream([]);
    }, plugins).run(
      input({
        tools: [
          {
            name: "count_words",
            label: "builtin",
            description: "builtin",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: {} }),
          },
        ],
      }),
    ),
  ).rejects.toThrow("extension_tool_collision");
  expect(dispatched).toBe(0);
});

test("tool_call veto blocks execution and hook errors never reach model as raw exceptions", async () => {
  const base = await readFile("examples/pi-extension.ts", "utf8");
  const { catalog: plugins } = await catalog(
    base.replace(
      "  pi.registerTool({",
      '  pi.on("tool_call", () => ({block: true, reason: "Denied", terminate: true}));\n  pi.registerTool({',
    ),
  );
  const runner = new PiRunner(() => stream([call], "toolUse"), plugins);
  const result = await runner.run(input({ maxTurns: 1 }));
  expect(
    result.transcript.find((m) => m.role === "toolResult")?.content,
  ).toEqual([{ type: "text", text: "Denied" }]);
  const { catalog: failing } = await catalog(
    'export default pi => pi.on("context", () => { throw Error("private secret"); });',
    { tools: [] },
  );
  let calls = 0;
  await expect(
    new PiRunner(() => {
      calls++;
      return stream([]);
    }, failing).run(input()),
  ).rejects.toThrow("extension_hook_failed");
  expect(calls).toBe(0);
});

test("each run gets fresh factory state; invalid arguments, revocation and approval waits cannot execute tools", async () => {
  const { catalog: plugins } =
    await catalog(`import { Type } from "@sinclair/typebox";
    export default pi => {
      let count = 0;
      pi.registerTool({name:"count_words", label:"Count", description:"Count", parameters:Type.Object({text:Type.String()}),
        async execute(){return {content:[{type:"text",text:String(++count)}], details:{}};}});
    }`);
  for (let run = 0; run < 2; run++) {
    let calls = 0;
    const runner = new PiRunner(
      () =>
        ++calls === 1
          ? stream([call], "toolUse")
          : stream([{ type: "text", text: "Done" }]),
      plugins,
    );
    const result = await runner.run(input());
    expect(
      result.transcript.find((m) => m.role === "toolResult")?.content,
    ).toEqual([{ type: "text", text: "1" }]);
  }
  let executed = 0;
  for (const patch of [{ shouldPause: async () => true }, { maxTools: 0 }]) {
    const runner = new PiRunner(() => stream([call], "toolUse"), plugins);
    try {
      await runner.run(
        input({
          ...patch,
          maxTurns: 1,
          extensionTool: async (_name, _id, execute) => {
            executed++;
            return execute();
          },
        }),
      );
    } catch {}
  }
  expect(executed).toBe(0);
  const runner = new PiRunner(
    () => stream([{ ...call, arguments: { text: {} } }], "toolUse"),
    plugins,
  );
  const invalid = await runner.run(input({ maxTurns: 1 }));
  expect(
    invalid.transcript.some((m) => m.role === "toolResult" && m.isError),
  ).toBe(true);
  await expect(
    plugins.open(
      input({
        guard: async () => {
          throw Error("revoked");
        },
      }),
    ),
  ).rejects.toThrow("revoked");
});

test("context hook changes count against input budget before any provider request", async () => {
  const { catalog: plugins } = await catalog(
    `export default pi => pi.on("context", event => ({messages: [...event.messages, {role:"user",content:"x".repeat(20000),timestamp:1}]}));`,
    { tools: [] },
  );
  let calls = 0;
  await expect(
    new PiRunner(() => {
      calls++;
      return stream([]);
    }, plugins).run(input()),
  ).rejects.toThrow("input_budget_exceeded");
  expect(calls).toBe(0);
});
