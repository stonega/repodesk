import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { selectedModel } from "../../src/agent/runtime.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Admin, Deployment, Workspace } from "../../src/domain.ts";
import { NowledgeClient } from "../../src/nowledge-mem/client.ts";
import { emptyNowledge, nowledgeUrl } from "../../src/nowledge-mem/config.ts";
import { nowledgeReadAllowed } from "../../src/nowledge-mem/policy.ts";
import {
  authoredMemory,
  NowledgeService,
} from "../../src/nowledge-mem/service.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const key = "ab".repeat(32),
  secret = "nmem_fixture_private_key";
function fixture(transport?: typeof fetch) {
  let w = workspace();
  w.operatorId = "operator";
  w.plugins = {
    revision: 1,
    entries: [],
    nowledgeMem: {
      settings: {
        enabled: true,
        apiUrl: "https://mem.example",
        memberId: "101",
        spaceId: "private-space",
        spaceName: "Private",
      },
      credential: encrypt(key, `nowledge-mem:${w.id}`, secret),
      botId: "999",
    },
  };
  const run = createRun(
    w,
    "101",
    "Save to Nowledge Mem: We use PostgreSQL.",
    "101",
    0,
    "gpt-4.1-mini",
  );
  run.status = "running";
  run.fence = 1;
  const d = { active: true, paused: false, bot: { id: "999" } } as Deployment;
  const store = {
    read: async (id: string) => {
      expect(id).toBe(w.id);
      return structuredClone(w);
    },
    change: async <T>(id: string, fn: (w: Workspace) => T | Promise<T>) => {
      expect(id).toBe(w.id);
      const next = structuredClone(w);
      const result = await fn(next);
      w = next;
      return result;
    },
    deployment: async () => d,
  } as unknown as Store;
  const service = new NowledgeService(store, key, transport);
  return {
    service,
    store,
    runId: run.id,
    d,
    admin: { id: "operator", operator: true } as Admin,
    get w() {
      return w;
    },
    tool: (action: "query" | "save", value: unknown, signal?: AbortSignal) =>
      service.tool(w.id, run.id, "101", 1, 1, action, value, signal),
  };
}
const transport = (
  fn: (url: string, init: RequestInit) => Response | Promise<Response>,
) =>
  Object.assign(
    (url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(fn(String(url), init ?? {})),
    { preconnect() {} },
  ) as typeof fetch;
const memory = {
  id: "m1",
  space_id: "private-space",
  title: "Database",
  content: "PostgreSQL",
};

describe("Nowledge Mem application adapter", () => {
  test("production Pi factory invokes the scoped query through a deterministic model turn", async () => {
    let network = 0,
      turns = 0;
    const f = fixture(
      transport(() => {
        network++;
        return Response.json(memory);
      }),
    );
    const plugins = new PluginService(
      f.store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.service,
    );
    const model = selectedModel("gpt-4.1-mini");
    const runner = await plugins.runner(f.d, f.w.id, (_model, context) => {
      const toolTurn = turns++ === 0;
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "historical reference",
      );
      if (!toolTurn) {
        const result = context.messages.find((m) => m.role === "toolResult");
        expect(JSON.stringify(result)).toContain("PostgreSQL");
      }
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: toolTurn
          ? [
              {
                type: "toolCall",
                id: "query-1",
                name: "query_nowledge_mem",
                arguments: { id: "m1" },
              },
            ]
          : [{ type: "text", text: "Your memory says PostgreSQL." }],
        stopReason: toolTurn ? "toolUse" : "stop",
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
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
      return stream;
    });
    const result = await runner.run({
      workspaceId: f.w.id,
      runId: f.runId,
      actor: "101",
      model,
      apiKey: "synthetic",
      system: "Application policy",
      prompt: "Read memory m1",
      transcript: [],
      tools: [],
      maxTurns: 2,
      signal: AbortSignal.timeout(5000),
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    });
    expect(result.text).toBe("Your memory says PostgreSQL.");
    expect(network).toBe(1);
    expect(turns).toBe(2);
  });
  test("accepts documented server bases and rejects credential-bearing/MCP URLs", () => {
    for (const url of [
      "https://mem.example",
      "http://127.0.0.1:14242",
      "http://[::1]:14242",
    ])
      expect(nowledgeUrl.safeParse(url).success).toBe(true);
    for (const url of [
      "http://mem.example",
      "https://a:b@mem.example",
      "https://mem.example?api_key=secret",
      "https://mem.example/mcp/",
    ])
      expect(nowledgeUrl.safeParse(url).success).toBe(false);
  });
  test("projects bounded search evidence and pins the Space in every request", async () => {
    let calls = 0;
    const f = fixture(
      transport((url, init) => {
        calls++;
        expect(url).toBe("https://mem.example/memories/search");
        expect(new Headers(init.headers).get("authorization")).toBe(
          `Bearer ${secret}`,
        );
        expect(init.redirect).toBe("error");
        expect(JSON.parse(String(init.body))).toEqual({
          query: "database",
          limit: 5,
          space_id: "private-space",
          include_entities: false,
          mode: "fast",
        });
        return Response.json([
          {
            memory: {
              ...memory,
              content: "x".repeat(2000),
              metadata: { private: secret },
            },
            extra: secret,
          },
        ]);
      }),
    );
    const result = await f.tool("query", { query: "database" });
    expect(result).toMatchObject({
      referenceOnly: true,
      memories: [{ id: "m1", truncated: true }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(calls).toBe(1);
    expect(f.w.runs[0]?.nowledgeRead).toEqual({ revision: 1, botId: "999" });
  });
  test("lists and reads with exact Space and memory identity guards", async () => {
    const paths: string[] = [];
    const f = fixture(
      transport((url) => {
        paths.push(url);
        return Response.json(
          url.includes("/memories/m1?") ? memory : { memories: [memory] },
        );
      }),
    );
    await f.tool("query", {});
    await f.tool("query", { id: "m1" });
    expect(paths).toEqual([
      "https://mem.example/memories?space_id=private-space&limit=5",
      "https://mem.example/memories/m1?space_id=private-space",
    ]);
    const denied = fixture(
      transport(() => Response.json({ ...memory, space_id: "elsewhere" })),
    );
    await expect(denied.tool("query", { id: "m1" })).rejects.toMatchObject({
      code: "nowledge_mem_invalid_response",
    });
  });
  test("blocks groups, workflows, other actors, revoked members, stale revisions/fences and bot changes before network", async () => {
    let calls = 0;
    for (const mutate of [
      (w: Workspace) => {
        const r = w.runs[0];
        if (r) r.chatId = "-100100";
      },
      (w: Workspace) => {
        const r = w.runs[0];
        if (r) r.workflowId = "scheduled";
      },
      (w: Workspace) => {
        if (w.plugins?.nowledgeMem)
          w.plugins.nowledgeMem.settings.memberId = "202";
      },
      (w: Workspace) => {
        const m = w.members[0];
        if (m) m.active = false;
      },
      (w: Workspace) => {
        if (w.plugins) w.plugins.revision++;
      },
      (w: Workspace) => {
        const r = w.runs[0];
        if (r) r.fence++;
      },
      (w: Workspace) => {
        if (w.plugins?.nowledgeMem) w.plugins.nowledgeMem.botId = "888";
      },
    ]) {
      const f = fixture(
        transport(() => {
          calls++;
          return Response.json(memory);
        }),
      );
      mutate(f.w);
      await expect(f.tool("query", { id: "m1" })).rejects.toBeDefined();
    }
    expect(calls).toBe(0);
  });
  test("discards responses after membership or configuration revocation", async () => {
    const f = fixture(
      transport(() => {
        if (f.w.plugins) f.w.plugins.revision++;
        return Response.json(memory);
      }),
    );
    await expect(f.tool("query", { id: "m1" })).rejects.toBeDefined();
    const run = f.w.runs[0];
    if (!run) throw Error("Missing fixture run");
    expect(runAllowed(f.w, run)).toBe(false);
  });
  test("only explicit current-message exact content can be saved; repeats reuse receipt", async () => {
    let calls = 0;
    const f = fixture(
      transport((_url, init) => {
        calls++;
        const body = JSON.parse(String(init.body));
        expect(body.content).toBe("We use PostgreSQL.");
        expect(body.space_id).toBe("private-space");
        return Response.json({ memory: { ...memory, id: body.id } });
      }),
    );
    const sourceId = f.w.runs[0]?.sources.find((s) => s.role === "user")?.id;
    expect(sourceId).toBeDefined();
    const first = await f.tool("save", { sourceId });
    expect(await f.tool("save", { sourceId })).toEqual(first);
    expect(calls).toBe(1);
    expect(first).toMatchObject({ status: "saved" });
    const foreign = fixture(
      transport(() => {
        calls++;
        return Response.json({});
      }),
    );
    await expect(foreign.tool("save", { sourceId })).rejects.toMatchObject({
      code: "nowledge_mem_explicit_save_required",
    });
    for (const text of [
      "Do not save to Nowledge Mem: no",
      'He said "Save to Nowledge Mem: no"',
      "Could you summarize and remember this?",
      "How do I save to Nowledge Mem: text?",
    ])
      expect(() => authoredMemory(text)).toThrow();
    expect(authoredMemory("保存到 Nowledge Mem：使用 PostgreSQL。 ")).toBe(
      "使用 PostgreSQL。",
    );
  });
  test("forwarded commands cannot authorize saves, and inactive members can still be disconnected", async () => {
    let calls = 0;
    const f = fixture(
      transport(() => {
        calls++;
        return Response.json({});
      }),
    );
    const source = f.w.messages.find((s) => s.role === "user");
    if (!source) throw Error("Missing human source");
    source.forwarded = true;
    await expect(f.tool("save", { sourceId: source.id })).rejects.toMatchObject(
      { code: "nowledge_mem_explicit_save_required" },
    );
    expect(calls).toBe(0);
    const member = f.w.members.find((m) => m.id === "101");
    if (member) member.active = false;
    const page = await f.service.view(f.admin, f.w.id);
    await f.service.configure(f.admin, f.w.id, {
      revision: 1,
      settings: { ...page.settings, enabled: false },
      removeCredential: true,
    });
    expect(f.w.plugins?.nowledgeMem?.credential).toBeUndefined();
  });
  test("unknown write outcomes remain reserved across new invocations", async () => {
    let calls = 0;
    const f = fixture(
      transport(() => {
        calls++;
        throw Error(`upstream leaked ${secret}`);
      }),
    );
    const sourceId = f.w.runs[0]?.sources.find((s) => s.role === "user")?.id;
    await expect(f.tool("save", { sourceId })).rejects.toMatchObject({
      code: "nowledge_mem_unavailable",
    });
    await expect(f.tool("save", { sourceId })).rejects.toMatchObject({
      code: "nowledge_mem_save_uncertain",
    });
    expect(calls).toBe(1);
  });
  test("credentials stay encrypted; changes require fresh keys; saves use optimistic revisions", async () => {
    const f = fixture();
    const page = await f.service.view(f.admin, f.w.id);
    expect(JSON.stringify(page)).not.toContain(secret);
    await expect(
      f.service.view({ ...f.admin, id: "other" }, f.w.id),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      f.service.configure(f.admin, f.w.id, {
        revision: 0,
        settings: page.settings,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      f.service.configure(f.admin, f.w.id, {
        revision: 1,
        settings: { ...page.settings, memberId: "202" },
      }),
    ).rejects.toMatchObject({ code: "nowledge_mem_not_configured" });
    await f.service.configure(f.admin, f.w.id, {
      revision: 1,
      settings: { ...page.settings, memberId: "202" },
      apiKey: secret,
    });
    expect(f.w.plugins?.nowledgeMem?.credential).not.toContain(secret);
    expect(f.w.plugins?.nowledgeMem?.settings.memberId).toBe("202");
    expect(f.w.plugins?.revision).toBe(2);
  });
  test("private evidence cannot cross actors, groups, bot identity or disabled connections transitively", async () => {
    const f = fixture(transport(() => Response.json(memory)));
    await f.tool("query", { id: "m1" });
    const original = f.w.runs[0];
    if (!original) throw Error("Missing fixture run");
    const followup = structuredClone(original);
    followup.id = "followup";
    delete followup.nowledgeRead;
    followup.sources = [
      {
        ...original.sources[0],
        role: "assistant",
        runId: original.id,
      } as (typeof original.sources)[number],
    ];
    expect(nowledgeReadAllowed(f.w, followup, "999")).toBe(true);
    expect(nowledgeReadAllowed(f.w, followup, "other-bot")).toBe(false);
    followup.actor = "202";
    followup.chatId = "202";
    expect(nowledgeReadAllowed(f.w, followup)).toBe(false);
    followup.actor = "101";
    followup.chatId = "-100100";
    expect(nowledgeReadAllowed(f.w, followup)).toBe(false);
    if (f.w.plugins?.nowledgeMem)
      f.w.plugins.nowledgeMem.settings.enabled = false;
    expect(runAllowed(f.w, original)).toBe(false);
  });
  test("discovery uses current operator scope and never returns saved key", async () => {
    let calls = 0;
    const f = fixture(
      transport((url) => {
        calls++;
        expect(url).toBe("https://mem.example/spaces");
        return Response.json({
          spaces: [
            {
              id: "private-space",
              name: "Private",
              instructions: "untrusted",
              key: secret,
            },
          ],
        });
      }),
    );
    await expect(
      f.service.spaces({ ...f.admin, operator: false }, f.w.id, {
        apiUrl: "https://mem.example",
      }),
    ).rejects.toBeDefined();
    expect(
      await f.service.spaces(f.admin, f.w.id, {
        apiUrl: "https://mem.example",
      }),
    ).toEqual([{ id: "private-space", name: "Private" }]);
    expect(calls).toBe(1);
    const configured = await f.service.view(f.admin, f.w.id);
    await f.service.configure(f.admin, f.w.id, {
      revision: 1,
      settings: { ...configured.settings, enabled: false },
      removeCredential: true,
    });
    expect(f.w.plugins?.nowledgeMem?.credential).toBeUndefined();
    expect(emptyNowledge.enabled).toBe(false);
  });
  test("bounds responses, rejects redirects/HTML/auth failures, and honors cancellation", async () => {
    const cases = [
      [Response.json({}, { status: 401 }), "nowledge_mem_access_denied"],
      [Response.json({}, { status: 429 }), "nowledge_mem_rate_limited"],
      [new Response("html gateway failure"), "nowledge_mem_unavailable"],
      [new Response("x".repeat(513 * 1024)), "nowledge_mem_response_too_large"],
    ] as const;
    for (const [response, code] of cases)
      await expect(
        new NowledgeClient(transport(() => response)).request(
          "https://mem.example",
          secret,
          "/memories",
        ),
      ).rejects.toMatchObject({ code });
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      new NowledgeClient(
        transport(() => {
          calls++;
          return Response.json({});
        }),
      ).request(
        "https://mem.example",
        secret,
        "/memories",
        undefined,
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
});
