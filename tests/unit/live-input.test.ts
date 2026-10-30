import { expect, test } from "bun:test";
import {
  answerReference,
  checkpointLiveInput,
  liveMessage,
  liveSource,
} from "../../src/agent/live-input.ts";
import type { Source } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { refreshThreadContext } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  const run = createRun(w, "101", "Plan a trip", "101", 0, "gpt-4.1-mini", {
    botId: "999",
    replyTo: 1,
  });
  run.status = "running";
  run.leaseUntil = new Date(Date.now() + 60000).toISOString();
  const source: Source = {
    ...(run.sources[0] as Source),
    id: "999:101:2",
    text: "Make it three days",
    runId: undefined,
    threadId: undefined,
    role: undefined,
  };
  w.messages.push(source);
  return { w, run, source };
}

test("active private input shares its run, stays pending until checkpoint, and restores from JSON", () => {
  const { w, run, source } = fixture();
  const appended = createRun(w, "101", source.text, "101", 0, run.model, {
    botId: "999",
    replyTo: 2,
    liveInput: true,
  });
  expect(appended.id).toBe(run.id);
  expect(w.runs).toHaveLength(1);
  refreshThreadContext(w, run);
  expect(run.sources.map((s) => s.id)).toEqual(["999:101:1"]);
  const restored = JSON.parse(JSON.stringify(w)) as typeof w;
  const current = restored.runs[0];
  if (!current) throw Error("missing run");
  const next = liveSource(restored, current);
  if (!next) throw Error("missing input");
  const message = liveMessage(current, next.source, next.pending.task, {
    prompt: "",
    images: [],
  });
  expect(current.pendingInputs).toHaveLength(1);
  checkpointLiveInput(restored, current, message);
  current.transcript.push(message);
  expect(current.pendingInputs).toEqual([]);
  expect(current.task).toBe("Make it three days");
  expect(current.sources.map((s) => s.id)).toEqual(["999:101:1", "999:101:2"]);
  const originalReply = createRun(
    restored,
    "101",
    "Continue",
    "101",
    0,
    run.model,
    { botId: "999", replyTo: 3, continueFrom: 1 },
  );
  expect(originalReply.threadId).toBe(run.threadId);
});

test("changed, missing or cross-actor live sources cannot become current input", () => {
  for (const mutation of [
    "edit",
    "remove",
    "actor",
    "topic",
    "expired",
  ] as const) {
    const { w, run, source } = fixture();
    createRun(w, "101", source.text, "101", 0, run.model, {
      botId: "999",
      replyTo: 2,
      liveInput: true,
    });
    const next = liveSource(w, run);
    if (!next) throw Error("missing input");
    const message = liveMessage(run, source, source.text, {
      prompt: "",
      images: [],
    });
    if (mutation === "edit") source.text = "Changed";
    if (mutation === "remove")
      w.messages = w.messages.filter((s) => s.id !== source.id);
    if (mutation === "actor") source.author = "202";
    if (mutation === "topic") source.topicId = 7;
    if (mutation === "expired") source.expiresAt = new Date(0).toISOString();
    expect(() => checkpointLiveInput(w, run, message)).toThrow();
    expect(run.pendingInputs).toHaveLength(1);
  }
});

test("different bot, actor, explicit thread and expired lease cannot append to an active run", () => {
  const { w, run } = fixture();
  const otherBot = createRun(w, "101", "Other bot", "101", 0, run.model, {
    botId: "888",
    replyTo: 10,
    liveInput: true,
  });
  expect(otherBot.id).not.toBe(run.id);
  const otherActor = createRun(w, "202", "Other actor", "202", 0, run.model, {
    botId: "999",
    replyTo: 11,
    liveInput: true,
  });
  expect(otherActor.id).not.toBe(run.id);
  const otherTopic = createRun(w, "101", "Other topic", "101", 7, run.model, {
    botId: "999",
    replyTo: 14,
    liveInput: true,
  });
  expect(otherTopic.threadId).not.toBe(run.threadId);
  const explicit = createRun(
    w,
    "101",
    "Explicit other conversation",
    "101",
    0,
    run.model,
    { botId: "999", replyTo: 12, continueFrom: 9999, liveInput: true },
  );
  expect(explicit.threadId).not.toBe(run.threadId);
  run.leaseUntil = new Date(0).toISOString();
  const expired = createRun(w, "101", "New conversation", "101", 0, run.model, {
    botId: "999",
    replyTo: 13,
    liveInput: true,
  });
  expect(expired.threadId).not.toBe(run.threadId);
});

test("ordinary answers omit native replies; specific citations select only same-chat/topic human messages", () => {
  const { run } = fixture();
  expect(answerReference(run, "Here is the itinerary")).toBeUndefined();
  expect(
    answerReference(run, "You said three days [source:999:101:1]", "999"),
  ).toBe(1);
  run.sources.push({
    ...(run.sources[0] as Source),
    id: "999:101:50",
    topicId: 50,
  });
  expect(
    answerReference(run, "Other topic [source:999:101:50]"),
  ).toBeUndefined();
  expect(answerReference(run, "Unknown [source:999:101:999]")).toBeUndefined();
  expect(
    answerReference(run, "Other bot [source:999:101:1]", "888"),
  ).toBeUndefined();
  run.workflowId = "scheduled";
  expect(answerReference(run, "Report [source:999:101:1]")).toBeUndefined();
});
