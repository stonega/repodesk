import { expect, test } from "bun:test";
import { queryChatHistory } from "../../src/agent/chat-history.ts";
import { buildContext, validateSources } from "../../src/agent/context.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import { createRun, deliver } from "../../src/workspaces/service.ts";
import {
  recordThreadAnswer,
  refreshThreadContext,
} from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function ask(
  w: Workspace,
  messageId: number,
  text: string,
  replyTo?: number,
  actor = "101",
  topicId = 0,
) {
  return createRun(w, actor, text, actor, topicId, "gpt-4.1-mini", {
    replyTo: messageId,
    continueFrom: replyTo,
    botId: "999",
  });
}
function answer(w: Workspace, run: Run, messageId: number, text: string) {
  run.status = "succeeded";
  run.result = text;
  run.finishedAt = new Date().toISOString();
  recordThreadAnswer(w, run);
  const id = deliver(w, run.actor, run.chatId, text, {
    topicId: run.topicId,
    runId: run.id,
    id: `run:${run.id}:result`,
  });
  const d = w.deliveries.find((d) => d.id === id);
  if (!d) throw Error("missing delivery");
  d.state = "sent";
  d.remoteId = messageId;
}

test("standalone messages isolate context; old answers and own messages resume the latest thread", () => {
  const w = workspace();
  const a = ask(w, 1, "Plan a Kyoto trip");
  answer(w, a, 2, "Visit the temples");
  const b = ask(w, 3, "Debug my server");
  expect(b.threadId).not.toBe(a.threadId);
  expect(b.sources.map((m) => m.text)).toEqual(["Debug my server"]);
  answer(w, b, 4, "Check the server logs");
  const c = ask(w, 5, "Add a restaurant", 2);
  expect(c.threadId).toBe(a.threadId);
  answer(w, c, 6, "Try a noodle shop");
  const d = ask(w, 7, "Make it vegetarian", 1);
  expect(d.threadId).toBe(a.threadId);
  expect(d.sources.map((m) => m.text)).toEqual([
    "Plan a Kyoto trip",
    "Visit the temples",
    "Add a restaurant",
    "Try a noodle shop",
    "Make it vegetarian",
  ]);
  expect(d.sources.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  expect(buildContext(w, d).prompt).not.toContain("server");
});

test("native topics continue without replies and take precedence over conflicting reply anchors", () => {
  const w = workspace();
  const a = ask(w, 1, "Kyoto trip", undefined, "101", 10);
  answer(w, a, 2, "Visit the temples");
  const b = ask(w, 3, "Debug server", 2, "101", 20);
  expect(b.threadId).not.toBe(a.threadId);
  expect(b.threadNotice).toBeUndefined();
  expect(b.sources.map((s) => s.text)).toEqual(["Debug server"]);
  answer(w, b, 4, "Check logs");
  const c = ask(w, 5, "Add food", undefined, "101", 10);
  expect(c.threadId).toBe(a.threadId);
  expect(c.sources.map((s) => s.text)).toEqual([
    "Kyoto trip",
    "Visit the temples",
    "Add food",
  ]);
  const d = ask(w, 6, "More temples", 4, "101", 10);
  expect(d.threadId).toBe(a.threadId);
  expect(d.sources.some((s) => s.topicId === 20)).toBe(false);
  expect(d.threadNotice).toBeUndefined();
  const e = ask(w, 7, "Unknown anchor", 9999, "101", 10);
  expect(e.threadId).toBe(a.threadId);
  expect(e.threadNotice).toBeUndefined();
  // Replies outside Topics cannot select a native topic's conversation.
  expect(ask(w, 8, "Outside", 2).threadId).not.toBe(a.threadId);
});

test("native topic mappings isolate users and bots even when topic IDs match", () => {
  const w = workspace();
  const a = ask(w, 1, "private", undefined, "101", 10);
  answer(w, a, 2, "private answer");
  const other = ask(w, 3, "other user", 2, "202", 10);
  expect(other.threadId).not.toBe(a.threadId);
  expect(other.sources.map((s) => s.text)).toEqual(["other user"]);
  const rotated = createRun(w, "101", "other bot", "101", 10, "gpt-4.1-mini", {
    botId: "888",
    replyTo: 4,
    continueFrom: 2,
  });
  expect(rotated.threadId).not.toBe(a.threadId);
  expect(rotated.sources.map((s) => s.text)).toEqual(["other bot"]);
  expect(ask(w, 5, "original bot", undefined, "101", 10).threadId).toBe(
    a.threadId,
  );
});

test("topic continuity does not depend on a retained reply anchor or restore expired history", () => {
  const w = workspace();
  const a = ask(w, 1, "expired", undefined, "101", 10);
  answer(w, a, 2, "expired answer");
  for (const source of w.messages) source.expiresAt = new Date(0).toISOString();
  const b = ask(w, 3, "fresh", 2, "101", 10);
  expect(b.threadId).toBe(a.threadId);
  expect(b.threadNotice).toBeUndefined();
  expect(b.sources.map((s) => s.text)).toEqual(["fresh"]);
  expect(
    queryChatHistory(w, b, { threadId: a.threadId }).messages.map(
      (s) => s.text,
    ),
  ).toEqual(["fresh"]);
});

test("native topics do not infer mappings from pre-upgrade reply threads", () => {
  const w = workspace();
  const old = ask(w, 1, "legacy topic", undefined, "101", 10);
  const thread = w.threads?.find((t) => t.id === old.threadId);
  if (!thread) throw Error("missing thread");
  delete thread.topicId;
  answer(w, old, 2, "legacy answer");
  const current = ask(w, 3, "native topic", 2, "101", 10);
  expect(current.threadId).not.toBe(old.threadId);
  expect(current.sources.map((s) => s.text)).toEqual(["native topic"]);
  expect(ask(w, 4, "outside", 2).threadId).not.toBe(old.threadId);
  expect(
    queryChatHistory(w, current, { threadId: old.threadId }).messages,
  ).toHaveLength(2);
});

test("queued follow-ups refresh after their predecessor finishes and exclude future inputs", () => {
  const w = workspace();
  const a = ask(w, 1, "first");
  const b = ask(w, 2, "second", 1);
  ask(w, 3, "future", 1);
  expect(b.sources.map((s) => s.text)).toEqual(["first", "second"]);
  answer(w, a, 4, "first answer");
  refreshThreadContext(w, b);
  expect(b.sources.map((s) => s.text)).toEqual([
    "first",
    "first answer",
    "second",
  ]);
  b.transcript = [{ role: "user", content: "checkpoint" }];
  const pinned = structuredClone(b.sources);
  answer(w, a, 4, "changed");
  refreshThreadContext(w, b);
  expect(b.sources).toEqual(pinned);
});

test("unknown, legacy, expired, other-user and other-bot replies cannot reuse a thread", () => {
  const w = workspace();
  const a = ask(w, 1, "private");
  answer(w, a, 2, "private answer");
  const stranger = ask(w, 3, "steal", 2, "202");
  expect(stranger.threadId).not.toBe(a.threadId);
  expect(stranger.sources.map((s) => s.text)).toEqual(["steal"]);
  expect(ask(w, 4, "unknown", 9999).threadNotice).toContain("new conversation");
  const rotated = createRun(w, "101", "new bot", "101", 0, "gpt-4.1-mini", {
    botId: "888",
    replyTo: 5,
    continueFrom: 2,
  });
  expect(rotated.threadId).not.toBe(a.threadId);
  for (const m of w.messages.filter((s) => s.threadId === a.threadId))
    m.expiresAt = new Date(0).toISOString();
  expect(ask(w, 6, "expired", 2).threadId).not.toBe(a.threadId);
  delete a.threadId;
  expect(ask(w, 7, "legacy", 2).threadId).not.toBe(a.threadId);
});

test("history searches user-owned private threads only, bounds excerpts, and authorizes citations", () => {
  const w = workspace();
  const a = ask(w, 1, `Kyoto ${"a".repeat(3000)}`);
  answer(w, a, 2, "Kyoto temples");
  ask(w, 3, "Kyoto secret", undefined, "202");
  const current = ask(w, 4, "What did we plan?");
  const found = queryChatHistory(w, current, { query: "kyoto", limit: 1 });
  expect(found.messages).toHaveLength(1);
  expect(found.hasMore).toBe(true);
  expect(found.messages[0]?.text.length).toBeLessThanOrEqual(1000);
  expect(found.messages[0]?.threadId).toBe(a.threadId);
  const next = queryChatHistory(w, current, {
    query: "kyoto",
    limit: 1,
    cursor: found.nextCursor,
  });
  expect(next.messages).toHaveLength(1);
  expect(next.messages[0]?.id).not.toBe(found.messages[0]?.id);
  expect(next.hasMore).toBe(false);
  expect(() =>
    validateSources(`[source:${found.messages[0]?.id}]`, current),
  ).not.toThrow();
  const all = queryChatHistory(w, current, { threadId: a.threadId });
  expect(all.messages.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
  expect(all.messages.every((m) => m.telegramMessageId !== undefined)).toBe(
    true,
  );
  expect(() => queryChatHistory(w, current, { userId: "202" })).toThrow();
  expect(() => queryChatHistory(w, current, { limit: 10000 })).toThrow();
  const other = w.runs.find((r) => r.actor === "202");
  expect(() =>
    queryChatHistory(w, current, { threadId: other?.threadId }),
  ).toThrow("thread_not_found");
  const group = createRun(w, "101", "recap", "-100100", 0, "gpt-4.1-mini");
  expect(() => queryChatHistory(w, group, {})).toThrow("private_history_only");
  expect(
    queryChatHistory(w, current, { before: "2000-01-01T00:00:00Z" }).messages,
  ).toEqual([]);
});

test("history tool is available for existing skills but enforces revocation, tenant and replay guards", async () => {
  const w = workspace();
  const a = ask(w, 1, "history");
  const current = ask(w, 2, "search");
  current.status = "running";
  const store = {
    change: async (id: string, action: (w: Workspace) => unknown) => {
      if (id !== w.id) throw Error("not_found");
      return action(w);
    },
  } as Store;
  const tool = (workspaceId = w.id) => {
    const result = applicationTools(
      store,
      workspaceId,
      current.id,
      current.fence,
    ).find((t) => t.name === "query_chat_history");
    if (!result) throw Error("missing tool");
    return result;
  };
  const args = { threadId: a.threadId };
  const first = await tool().execute("read", args);
  expect(await tool().execute("read", args)).toEqual(first);
  await expect(tool().execute("read", { query: "changed" })).rejects.toThrow(
    "tool_call_conflict",
  );
  await expect(tool(crypto.randomUUID()).execute("cross", {})).rejects.toThrow(
    "not_found",
  );
  w.policy.allowed = [];
  await expect(tool().execute("read", args)).rejects.toThrow(
    "tool_policy_denied",
  );
  w.policy.allowed = ["101"];
  w.messages = w.messages.filter((m) => m.threadId !== a.threadId);
  await expect(tool().execute("read", args)).rejects.toThrow(
    "tool_policy_denied",
  );
});

test("retention removes derived answers across threads and workspace deletion erases threads", () => {
  const w = workspace();
  const a = ask(w, 1, "erase me");
  answer(w, a, 2, "derived secret");
  const b = ask(w, 3, "recall it");
  queryChatHistory(w, b, { threadId: a.threadId });
  answer(w, b, 4, "copied secret");
  w.messages = w.messages.filter((m) => m.id !== a.sources[0]?.id);
  sweep(w);
  expect(w.messages.some((m) => m.role === "assistant")).toBe(false);
  expect(a.result).toBeUndefined();
  expect(b.result).toBeUndefined();
  expect(queryChatHistory(w, b, { query: "secret" }).messages).toEqual([]);
  w.deletion = { requestedAt: new Date().toISOString(), providerState: "none" };
  sweep(w);
  expect(w.threads).toEqual([]);
  expect(w.messages).toEqual([]);
});

test("answers inherit source retention even before a sweep, including shorter retention policies", () => {
  const w = workspace();
  const a = ask(w, 1, "old source");
  const source = w.messages.find((m) => m.runId === a.id);
  if (!source) throw Error("missing source");
  source.at = new Date(Date.now() - 2 * 86400000).toISOString();
  refreshThreadContext(w, a);
  answer(w, a, 2, "derived old source");
  const b = ask(w, 3, "new request");
  w.settings.retentionDays = 1;
  expect(queryChatHistory(w, b, { threadId: a.threadId }).messages).toEqual([]);
});

test("an expired reply anchor starts a fresh thread even when newer thread messages remain", () => {
  const w = workspace();
  const a = ask(w, 1, "first");
  answer(w, a, 2, "answer");
  const b = ask(w, 3, "newer", 2);
  const old = w.messages.find((m) => m.runId === a.id && m.role === "user");
  if (!old) throw Error("missing source");
  old.expiresAt = new Date(0).toISOString();
  const c = ask(w, 4, "reply to expired input", 1);
  expect(c.threadId).not.toBe(b.threadId);
  expect(c.threadNotice).toContain("new conversation");
});
