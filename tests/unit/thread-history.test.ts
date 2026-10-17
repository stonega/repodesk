import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  runThreadKey,
  threadDetail,
  threadGroups,
  threadSummaries,
} from "../../src/admin/thread-history.ts";
import type { ConversationThread, Run, Workspace } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function thread(w: Workspace, patch: Partial<ConversationThread> = {}) {
  const value: ConversationThread = {
    id: randomUUID(),
    actor: "101",
    chatId: "101",
    topicId: 7,
    botId: "999",
    at: "2026-10-17T00:00:00Z",
    ...patch,
  };
  w.threads ??= [];
  w.threads.push(value);
  return value;
}
function add(w: Workspace, t?: ConversationThread, patch: Partial<Run> = {}) {
  const r = createRun(w, "101", "First request", "101", 0, "fixture");
  Object.assign(
    r,
    {
      threadId: t?.id,
      actor: t?.actor ?? "101",
      chatId: t?.chatId ?? "101",
      topicId: t?.topicId ?? 0,
      at: "2026-10-17T00:00:00Z",
      status: "succeeded",
      result: "First answer",
    },
    patch,
  );
  return r;
}

test("thread pagination groups all requests before slicing and orders by latest activity", () => {
  const w = workspace();
  const first = thread(w);
  add(w, first);
  const second = thread(w, { topicId: 8 });
  add(w, second, { at: "2026-10-17T00:01:00Z" });
  add(w, first, {
    task: "Continue the first conversation",
    at: "2026-10-17T00:02:00Z",
  });
  const page = threadSummaries(w, 0, 1);
  expect(page).toMatchObject({ total: 2, offset: 0, limit: 1 });
  expect(page.items[0]).toMatchObject({
    id: first.id,
    requestCount: 2,
    title: "First request",
  });
  expect(threadSummaries(w, 1, 1).items[0]?.id).toBe(second.id);
  expect(
    threadDetail(w, first.id, 1, 25).items.map((turn) => turn.task),
  ).toEqual(["Continue the first conversation"]);
  expect(threadDetail(w, first.id, 100, 25)).toMatchObject({
    total: 2,
    items: [],
  });
  for (const run of w.runs) run.at = "2026-10-17T00:00:00Z";
  expect(threadSummaries(w, 0, 25).items.map((item) => item.id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("private users, topics, bots and groups stay separate; joined group users share their saved thread", () => {
  const w = workspace();
  const a = thread(w);
  const b = thread(w, { actor: "202", chatId: "202" });
  const otherBot = thread(w, { botId: "other-bot" });
  const group = thread(w, {
    kind: "group",
    chatId: "-100100",
    participants: ["101", "202"],
  });
  add(w, a);
  add(w, b);
  add(w, otherBot);
  add(w, group);
  add(w, group, { actor: "202" });
  // Even a corrupt/cross-topic reference cannot merge a run into another audience.
  const wrongTopic = add(w, a, { topicId: 8 });
  const wrongUser = add(w, a, { actor: "202", chatId: "202" });
  const wrongGroup = add(w, group, { chatId: "-200200" });
  expect(threadGroups(w).size).toBe(7);
  expect(
    threadSummaries(w, 0, 25).items.find((item) => item.id === group.id),
  ).toMatchObject({ requestCount: 2, participantCount: 2 });
  for (const r of [wrongTopic, wrongUser, wrongGroup])
    expect(runThreadKey(w, r)).toBe(`run-${r.id}`);
});

test("legacy, missing-thread and scheduled requests are not guessed into continuous conversations", () => {
  const w = workspace();
  const t = thread(w);
  const one = add(w);
  const two = add(w);
  const missing = add(w, undefined, { threadId: randomUUID() });
  const scheduled = add(w, t, { workflowId: randomUUID() });
  add(w, t, {
    followup: {
      anchorRunId: one.id,
      expiresAt: "2026-10-17T01:00:00Z",
      transcript: [],
      decision: "ignore",
    },
  });
  const items = threadSummaries(w, 0, 25).items;
  expect(items).toHaveLength(4);
  expect(new Set(items.map((item) => item.id))).toEqual(
    new Set([one, two, missing, scheduled].map((r) => `run-${r.id}`)),
  );
  expect(items.find((item) => item.id === `run-${scheduled.id}`)?.kind).toBe(
    "workflow",
  );
});

test("Telegram profile/group metadata is scoped, bounded and independent from permissions", () => {
  const w = workspace();
  const owner = w.members[0];
  const chat = w.chats[0];
  if (!owner || !chat) throw Error("Missing fixture identity");
  Object.assign(owner, {
    name: "Alice Stone",
    username: "alice",
    profileUpdatedAt: "2026-10-17T00:00:00Z",
  });
  w.accessRequests = [
    {
      id: randomUUID(),
      actor: "202",
      name: "Bob",
      username: "bob",
      chatId: "202",
      requestedAt: "2026-10-17T00:00:00Z",
      status: "approved",
    },
  ];
  chat.title = "Engineering team";
  const t = thread(w, {
    kind: "group",
    chatId: "-100100",
    participants: ["101", "202", "303", "404"],
  });
  for (const actor of ["101", "202", "303", "404"]) add(w, t, { actor });
  const summary = threadSummaries(w, 0, 25).items[0];
  if (!summary) throw Error("Missing thread summary");
  expect(summary.group).toEqual({ id: "-100100", title: "Engineering team" });
  expect(summary.user).toMatchObject({
    id: "101",
    name: "Alice Stone",
    username: "alice",
  });
  expect(summary.participants[1]).toMatchObject({
    id: "202",
    name: "Bob",
    username: "bob",
  });
  expect(summary.participants).toHaveLength(3);
  expect(summary.participantCount).toBe(4);
  expect(summary.participants[0]).not.toHaveProperty("role");
  expect(summary).not.toHaveProperty("transcript");
  expect(threadDetail(w, t.id, 0, 25).items[3]?.user).toEqual({ id: "404" });
});

test("thread statistics cover the entire conversation without returning execution transcripts", () => {
  const w = workspace();
  const t = thread(w);
  for (let i = 0; i < 2; i++)
    add(w, t, {
      tools: { reused: { name: "search", state: "done" } },
      attempts: [
        {
          id: randomUUID(),
          status: "settled",
          at: t.at,
          reserved: 1,
          actual: 0.01,
          tokens: { input: 100, output: 10, cacheRead: 300, cacheWrite: 100 },
        },
      ],
      transcript: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "Internal result" }],
        },
      ],
    });
  const detail = threadDetail(w, t.id, 0, 1);
  expect(detail.statistics).toMatchObject({
    messages: 4,
    toolCalls: 2,
    attempts: 2,
    totalTokens: 1020,
    cacheHitRate: 0.6,
    cost: 0.02,
  });
  expect(detail.items).toHaveLength(1);
  expect(JSON.stringify(detail.items)).not.toContain("Internal result");
  const foreign = workspace();
  expect(() => threadDetail(foreign, t.id, 0, 25)).toThrow("not_found");
});
