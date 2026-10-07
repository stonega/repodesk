import { expect, test } from "bun:test";
import { queryChatHistory } from "../../src/agent/chat-history.ts";
import { compactionPlan } from "../../src/agent/compaction.ts";
import { buildContext } from "../../src/agent/context.ts";
import {
  queryDiscussions,
  recordDiscussion,
} from "../../src/agent/discussions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import {
  commitDiscussions,
  memoryReferences,
} from "../../src/workspaces/conversation-memory.ts";
import { createRun } from "../../src/workspaces/service.ts";
import {
  recordThreadAnswer,
  refreshThreadContext,
} from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function ask(w: Workspace, text: string, topic = 10, actor = "101") {
  return createRun(w, actor, text, actor, topic, "gpt-4.1-mini", {
    botId: "999",
  });
}
function answer(w: Workspace, r: Run, text = "answer") {
  r.result = text;
  r.status = "succeeded";
  recordThreadAnswer(w, r);
  commitDiscussions(w, r);
}
function entry(r: Run, title = "Deployment") {
  return {
    title,
    summary: "One server with 4 GB memory",
    decisions: ["Use one server"],
    todos: ["Choose backup storage"],
    messageIds: [r.sources.at(-1)?.id],
  };
}
function input(window = 50000) {
  return {
    model: {
      ...selectedModel("gpt-4.1-mini"),
      contextWindow: window,
      maxTokens: 4000,
    },
    tools: [],
  } as unknown as AgentInput;
}

test("discussion changes stay at the tail while history and fixed summaries retain their prefix", () => {
  const w = workspace();
  const a = ask(w, "Deployment question");
  const first = buildContext(w, a);
  recordDiscussion(w, a, entry(a));
  answer(w, a);
  const b = ask(w, "Why?");
  const second = buildContext(w, b);
  expect(second.system).toBe(first.system);
  // The complete source object remains byte-identical before the growing array's closing bracket.
  const historyEnd = first.prompt.indexOf('],"request"');
  expect(historyEnd).toBeGreaterThan(0);
  expect(second.prompt.startsWith(first.prompt.slice(0, historyEnd))).toBe(
    true,
  );
  expect(second.prompt.indexOf('"discussions"')).toBeGreaterThan(
    second.prompt.indexOf('"request"'),
  );
  expect(second.system).toContain(
    "Ask one concise clarification only when essential information is missing",
  );
  expect(second.system).toContain("without asking to create or switch");
});

test("record, revise, overlap and retrieve discussions without changing the native thread", () => {
  const w = workspace();
  const a = ask(w, "Deployment");
  const recorded = recordDiscussion(w, a, entry(a));
  expect(w.threads?.[0]?.discussions).toBeUndefined();
  answer(w, a);
  const b = ask(w, "Hiring");
  recordDiscussion(w, b, { ...entry(b, "Hiring"), relatedIds: [recorded.id] });
  answer(w, b);
  const c = ask(w, "Back to deployment");
  const found = queryDiscussions(w, c, { query: "deployment" });
  expect(found.discussions[0]?.id).toBe(recorded.id);
  expect(
    queryChatHistory(w, c, { discussionId: recorded.id })
      .messages.map((m) => m.text)
      .sort(),
  ).toEqual(["Deployment", "answer"].sort());
  recordDiscussion(w, c, {
    ...entry(c),
    id: recorded.id,
    todos: ["Test restore"],
  });
  answer(w, c);
  expect(w.threads).toHaveLength(1);
  expect(w.threads?.[0]?.discussions).toHaveLength(2);
  expect(w.threads?.[0]?.activeDiscussionId).toBe(recorded.id);
  const d = ask(w, "Continue");
  expect(
    queryDiscussions(w, d, { id: recorded.id }).discussions[0]?.todos,
  ).toEqual(["Test restore"]);
});

test("discussion tools reject other topics, actors, fabricated sources and group requests", () => {
  const w = workspace();
  const a = ask(w, "secret");
  const { id } = recordDiscussion(w, a, entry(a));
  answer(w, a);
  for (const r of [
    ask(w, "other topic", 20),
    ask(w, "other actor", 10, "202"),
  ]) {
    expect(() => queryDiscussions(w, r, { id })).toThrow(
      "discussion_not_found",
    );
    expect(() => queryChatHistory(w, r, { discussionId: id })).toThrow(
      "discussion_not_found",
    );
    expect(() => recordDiscussion(w, r, { ...entry(r), id })).toThrow(
      "discussion_not_found",
    );
  }
  const current = ask(w, "continue");
  expect(() =>
    recordDiscussion(w, current, {
      ...entry(current),
      messageIds: ["invented"],
    }),
  ).toThrow("discussion_source_denied");
  const group = createRun(w, "101", "group", "-100100", 10, "gpt-4.1-mini");
  expect(() => queryDiscussions(w, group, {})).toThrow("private_topic_only");
});

test("discussion tools enforce replay conflicts and revocation using existing grants", async () => {
  const w = workspace();
  const run = ask(w, "deploy");
  run.status = "running";
  const store = {
    change: async (_: string, fn: (w: Workspace) => unknown) => fn(w),
  } as Store;
  const tool = applicationTools(store, w.id, run.id, run.fence).find(
    (t) => t.name === "record_discussion",
  );
  if (!tool) throw Error("missing tool");
  const args = entry(run);
  const first = await tool.execute("record", args);
  expect(await tool.execute("record", args)).toEqual(first);
  expect(run.discussionUpdates).toHaveLength(1);
  await expect(
    tool.execute("record", { ...args, title: "changed" }),
  ).rejects.toThrow("tool_call_conflict");
  w.members.forEach((member) => {
    member.active = false;
  });
  await expect(tool.execute("record", args)).rejects.toThrow(
    "tool_policy_denied",
  );
});

test("threshold compaction keeps recent turns and freezes its summary across subsequent messages", () => {
  const w = workspace();
  for (let i = 0; i < 18; i++)
    answer(w, ask(w, `turn ${i}: ${"detail ".repeat(450)}`));
  const current = ask(w, "Continue");
  const plan = compactionPlan(w, current, input());
  expect(plan).toBeDefined();
  if (!plan) throw Error("missing plan");
  expect(plan.summary.sourceIds).not.toContain(current.sources.at(-1)?.id);
  const previous = w.runs.at(-2);
  expect(plan.summary.sourceIds).not.toContain(`answer:${previous?.id}`);
  const thread = w.threads?.[0];
  if (!thread) throw Error("missing thread");
  thread.summary = {
    ...plan.summary,
    text: "Deployment decisions and backup todo",
  };
  refreshThreadContext(w, current);
  const before = buildContext(w, current);
  expect(JSON.parse(before.prompt).sources.length).toBeLessThan(
    current.sources.length,
  );
  expect(compactionPlan(w, current, input())).toBeUndefined();
  answer(w, current);
  const next = ask(w, "More details");
  expect(next.contextSummary).toEqual(current.contextSummary);
  expect(
    buildContext(w, next).prompt.startsWith(
      before.prompt.slice(0, before.prompt.indexOf('],"request"')),
    ),
  ).toBe(true);
});

test("edits and retention invalidate summaries and discussion records without reviving deleted content", () => {
  const w = workspace();
  const a = ask(w, "sensitive original");
  recordDiscussion(w, a, entry(a));
  answer(w, a);
  const thread = w.threads?.[0];
  if (!thread) throw Error("missing thread");
  thread.summary = {
    ...memoryReferences(w.messages.filter((s) => s.threadId === a.threadId)),
    text: "derived sensitive",
    version: 1,
    throughRunId: a.id,
  };
  const b = ask(w, "continue");
  expect(b.contextSummary).toBeDefined();
  const original = w.messages.find(
    (s) => s.runId === a.id && s.role === "user",
  );
  if (!original) throw Error("missing source");
  original.text = "corrected";
  const c = ask(w, "new request");
  expect(c.contextSummary).toBeUndefined();
  expect(queryDiscussions(w, c, {}).discussions).toEqual([]);
  sweep(w);
  expect(thread.summary).toBeUndefined();
  expect(thread.discussions).toEqual([]);
  expect(b.contextSummary).toBeUndefined();
  w.deletion = { requestedAt: new Date().toISOString(), providerState: "none" };
  sweep(w);
  expect(w.threads).toEqual([]);
});
