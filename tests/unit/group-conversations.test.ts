import { expect, test } from "bun:test";
import { queryChatHistory } from "../../src/agent/chat-history.ts";
import { compactionPlan } from "../../src/agent/compaction.ts";
import { buildContext } from "../../src/agent/context.ts";
import {
  queryDiscussions,
  recordDiscussion,
} from "../../src/agent/discussions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { sweep } from "../../src/privacy/service.ts";
import { followupCandidate } from "../../src/telegram/followup.ts";
import { type Message, updateSchema } from "../../src/telegram/router.ts";
import {
  commitDiscussions,
  memoryReferences,
} from "../../src/workspaces/conversation-memory.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun, deliver } from "../../src/workspaces/service.ts";
import {
  recordThreadAnswer,
  refreshThreadContext,
} from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function ask(
  w: Workspace,
  actor = "101",
  text = "部署方案",
  topic = 0,
  reply?: number,
  botId = "999",
) {
  return createRun(w, actor, text, "-100100", topic, "gpt-4.1-mini", {
    botId,
    continueFrom: reply,
  });
}
function answer(w: Workspace, r: Run, remoteId = 100) {
  r.result = "部署包含备份步骤";
  r.status = "succeeded";
  r.finishedAt = new Date(Date.now() - 1000).toISOString();
  recordThreadAnswer(w, r);
  commitDiscussions(w, r);
  const id = deliver(w, r.actor, r.chatId, r.result, {
    id: `run:${r.id}:result`,
    runId: r.id,
    topicId: r.topicId,
  });
  const d = w.deliveries.find((d) => d.id === id);
  if (d) {
    d.state = "sent";
    d.remoteId = remoteId;
  }
}
function message(actor = 101, topic = 0): Message {
  const msg = updateSchema.parse({
    update_id: 1,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      from: { id: actor, is_bot: false },
      chat: { id: -100100, type: "supergroup" },
      message_thread_id: topic,
      text: "再详细点",
    },
  }).message;
  if (!msg) throw Error("message");
  return msg;
}

test("group participants keep separate default histories; reply joins a shared discussion", () => {
  const w = workspace();
  const a = ask(w);
  answer(w, a);
  const b = ask(w, "202", "招聘文案");
  answer(w, b, 200);
  const nextA = ask(w, "101", "再详细点");
  expect(nextA.threadId).toBe(a.threadId);
  expect(nextA.sources.map((s) => s.text).join()).not.toContain("招聘文案");
  const joined = ask(w, "202", "加上回滚", 0, 100);
  expect(joined.threadId).toBe(a.threadId);
  expect(joined.sources.some((s) => s.author === "101")).toBe(true);
  answer(w, joined, 201);
  expect(ask(w, "202", "继续").threadId).toBe(a.threadId);
  expect(w.threads?.find((t) => t.id === a.threadId)?.participants).toEqual([
    "101",
    "202",
  ]);
});

test("group routing and retrieval isolate topics, bots, private chats and workspaces", () => {
  const w = workspace();
  const secret = createRun(
    w,
    "101",
    "private secret",
    "101",
    10,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  answer(w, secret, 101);
  const a = ask(w);
  answer(w, a);
  const otherTopic = ask(w, "101", "other topic", 20, 100);
  const otherBot = ask(w, "101", "other bot", 0, 100, "888");
  const b = ask(w, "202", "public lookup");
  expect(otherTopic.threadId).not.toBe(a.threadId);
  expect(otherBot.threadId).not.toBe(a.threadId);
  expect(
    queryChatHistory(w, b, { query: "部署" }).messages.length,
  ).toBeGreaterThan(0);
  for (const r of [secret, otherTopic, otherBot]) {
    expect(() => queryChatHistory(w, b, { threadId: r.threadId })).toThrow(
      "thread_not_found",
    );
  }
  expect(
    queryChatHistory(w, secret, { query: "部署" }).messages.every(
      (m) => m.threadId === secret.threadId,
    ),
  ).toBe(true);
  const other = workspace();
  expect(ask(other, "202", "continue", 0, 100).threadId).not.toBe(a.threadId);
  w.members.forEach((member) => {
    member.active = false;
  });
  expect(() => queryChatHistory(w, b, {})).toThrow();
});

test("shared group discussion records and growing cache prefix survive participant changes", () => {
  const w = workspace();
  const a = ask(w);
  const first = buildContext(w, a);
  const recorded = recordDiscussion(w, a, {
    title: "部署",
    summary: "备份",
    decisions: ["保留备份"],
    todos: [],
    messageIds: [a.sources[0]?.id],
  });
  answer(w, a);
  const b = ask(w, "202", "加上回滚", 0, 100);
  const second = buildContext(w, b);
  expect(second.system).toBe(first.system);
  expect(
    second.prompt.startsWith(
      first.prompt.slice(0, first.prompt.indexOf('],"request"')),
    ),
  ).toBe(true);
  expect(JSON.parse(second.prompt).actor).toBe("202");
  expect(queryDiscussions(w, b, {}).discussions[0]?.id).toBe(recorded.id);
  expect(
    queryChatHistory(w, b, { discussionId: recorded.id }).messages.length,
  ).toBe(2);
  recordDiscussion(w, b, {
    id: recorded.id,
    title: "部署",
    summary: "备份和回滚",
    decisions: [],
    todos: ["回滚演练"],
    messageIds: [b.sources.at(-1)?.id],
  });
  answer(w, b, 200);
  expect(queryDiscussions(w, ask(w), {}).discussions[0]?.todos).toEqual([
    "回滚演练",
  ]);
});

test("group history compacts and source edits invalidate frozen memory", () => {
  const w = workspace();
  for (let i = 0; i < 18; i++)
    answer(w, ask(w, "101", `turn ${i} ${"detail ".repeat(450)}`));
  const r = ask(w, "101", "继续");
  const plan = compactionPlan(w, r, {
    model: {
      ...selectedModel("gpt-4.1-mini"),
      contextWindow: 50000,
      maxTokens: 4000,
    },
    tools: [],
  } as unknown as AgentInput);
  expect(plan).toBeDefined();
  if (!plan) throw Error("plan");
  const thread = w.threads?.[0];
  if (!thread) throw Error("thread");
  thread.summary = { ...plan.summary, text: "frozen group summary" };
  refreshThreadContext(w, r);
  expect(r.contextSummary?.text).toBe("frozen group summary");
  expect(
    compactionPlan(w, r, {
      model: {
        ...selectedModel("gpt-4.1-mini"),
        contextWindow: 50000,
        maxTokens: 4000,
      },
      tools: [],
    } as unknown as AgentInput),
  ).toBeUndefined();
  const source = w.messages.find((s) => plan.summary.sourceIds.includes(s.id));
  if (source) source.text = "edited";
  sweep(w);
  expect(thread.summary).toBeUndefined();
});

test("natural follow-up requires this actor's recent confirmed answer in this bot/topic", () => {
  const w = workspace();
  const a = ask(w);
  answer(w, a);
  const b = ask(w, "202", "招聘");
  answer(w, b, 200);
  expect(followupCandidate(w, message(), "999")?.anchorRunId).toBe(a.id);
  expect(followupCandidate(w, message(202), "999")?.anchorRunId).toBe(b.id);
  expect(followupCandidate(w, message(303), "999")).toBeUndefined();
  expect(followupCandidate(w, message(101, 20), "999")).toBeUndefined();
  expect(followupCandidate(w, message(), "888")).toBeUndefined();
  expect(
    followupCandidate(w, message(), "999", Date.now() + 300001),
  ).toBeUndefined();
  const d = w.deliveries[0];
  if (d) d.state = "delivery_unknown";
  expect(followupCandidate(w, message(), "999")).toBeUndefined();
});

test("a recent forward can supply reference content while the same actor's explicit request is pending", () => {
  for (const status of ["queued", "running", "succeeded"] as const) {
    const w = workspace();
    const prior = ask(w, "101", "save this");
    prior.status = status;
    const msg = message();
    msg.text = "/capture on @teammate";
    msg.forward_origin = {
      type: "hidden_user",
      date: 1,
      sender_user_name: "Joey Lu",
    };
    msg.entities = [
      { type: "bot_command", offset: 0, length: 8 },
      { type: "mention", offset: 12, length: 9 },
    ];
    const followup = followupCandidate(w, msg, "999");
    expect(followup).toMatchObject({ kind: "forward", anchorRunId: prior.id });
    expect(prior.followupClosed).toBeUndefined();
    const run = createRun(
      w,
      "101",
      "forwarded reference",
      "-100100",
      0,
      "gpt-4.1-mini",
      { botId: "999", followup },
    );
    expect(runAllowed(w, run)).toBe(true);
    prior.cancelled = true;
    expect(runAllowed(w, run)).toBe(false);
  }
});

test("forward candidates require a fresh retained directed ask and preserve sender, topic and bot boundaries", () => {
  const w = workspace();
  const prior = ask(w, "101", "save this");
  const msg = message();
  msg.forward_origin = {
    type: "user",
    date: 1,
    sender_user: { id: 101, is_bot: false },
  };
  for (const invalid of [
    { ...msg, from: { id: 202, is_bot: false } },
    { ...msg, from: { id: 9999, is_bot: false } },
    { ...msg, from: { id: 101, is_bot: true } },
    { ...msg, sender_chat: msg.chat },
    { ...msg, message_thread_id: 20 },
    { ...msg, is_automatic_forward: true },
    { ...msg, date: Math.floor(Date.now() / 1000) - 120 },
    { ...msg, date: Math.floor(Date.now() / 1000) + 120 },
  ])
    expect(followupCandidate(w, invalid, "999")).toBeUndefined();
  expect(followupCandidate(w, msg, "888")).toBeUndefined();
  expect(followupCandidate(w, msg, "999", Date.now() + 61000)).toBeUndefined();
  prior.followupClosed = true;
  expect(followupCandidate(w, msg, "999")).toBeUndefined();
  prior.followupClosed = false;
  prior.status = "failed";
  expect(followupCandidate(w, msg, "999")).toBeUndefined();
  prior.status = "queued";
  const source = w.messages[0];
  if (!source) throw Error("source");
  source.expiresAt = new Date(0).toISOString();
  expect(followupCandidate(w, msg, "999")).toBeUndefined();
});

test("other addressees close attention and anonymous, untrusted, edited or stale identities do not trigger", () => {
  for (const change of [
    (m: Message) => {
      m.text = "@alice 再详细点";
    },
    (m: Message) => {
      m.reply_to_message = { message_id: 99, from: { id: 202, is_bot: false } };
    },
    (m: Message) => {
      m.entities = [{ type: "text_mention", offset: 0, length: 1 }];
    },
  ]) {
    const w = workspace();
    const a = ask(w);
    answer(w, a);
    const msg = message();
    change(msg);
    expect(followupCandidate(w, msg, "999")).toBeUndefined();
    expect(followupCandidate(w, message(), "999")).toBeUndefined();
  }
  const w = workspace();
  const a = ask(w);
  answer(w, a);
  for (const msg of [
    { ...message(), sender_chat: { id: -100100, type: "supergroup" as const } },
    { ...message(), from: { id: 101, is_bot: true } },
    { ...message(), date: Math.floor(Date.now() / 1000) - 3600 },
    message(9999),
  ])
    expect(followupCandidate(w, msg, "999")).toBeUndefined();
  w.members.forEach((member) => {
    member.active = false;
  });
  expect(followupCandidate(w, message(), "999")).toBeUndefined();
});

test("group recap retains group coverage without adopting a user's thread", () => {
  const w = workspace();
  answer(w, ask(w));
  answer(w, ask(w, "202", "招聘"));
  const recap = createRun(w, "101", "recap", "-100100", 0, "gpt-4.1-mini", {
    botId: "999",
    groupRecap: true,
  });
  expect(recap.threadId).toBeUndefined();
  expect(recap.sources.some((s) => s.text === "招聘")).toBe(true);
});

test("follow-up checkpoint source content and authors are erased on retention invalidation", () => {
  const w = workspace();
  const a = ask(w);
  answer(w, a);
  const followup = followupCandidate(w, message(), "999");
  const r = createRun(w, "101", "再详细点", "-100100", 0, "gpt-4.1-mini", {
    botId: "999",
    followup,
  });
  if (!r.followup) throw Error("followup");
  r.followup.references = memoryReferences(r.sources);
  r.followup.transcript = [{ role: "user", content: "sensitive" }];
  const original = w.messages[0];
  if (original) original.author = "202";
  sweep(w);
  expect(r.followup.transcript).toEqual([]);
  expect(r.task).toBe("[source removed]");
});
