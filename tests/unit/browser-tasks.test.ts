import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  activeBrowserTask,
  browserTaskControl,
} from "../../src/browser/tasks.ts";
import type { Deployment } from "../../src/domain.ts";
import type { Update } from "../../src/telegram/router.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  const run = createRun(
    w,
    "202",
    "Keep the original goal",
    "202",
    7,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  run.status = "awaiting_approval";
  run.browserTask = true;
  run.browserRead = { owner: "202", botId: "999", generation: 0, epoch: 0 };
  run.browserWait = {
    id: randomUUID(),
    kind: "action",
    callId: "submit",
    expiresAt: Date.now() + 60000,
    origin: "https://example.com/private?secret=never-echo",
    operation: "click",
  };
  const d: Deployment = {
    version: 1,
    active: true,
    paused: false,
    model: "gpt-4.1-mini",
    credentials: {},
    webhookReady: true,
    ownerVerified: true,
    bot: { id: "999", username: "fixture_bot", visibleAll: true },
  };
  const u: Update = {
    update_id: 50,
    message: {
      message_id: 60,
      date: Math.floor(Date.now() / 1000),
      from: { id: 202, is_bot: false },
      chat: { id: 202, type: "private" },
      message_thread_id: 7,
      text: "what is the progress",
    },
  };
  const msg = u.message;
  if (!msg) throw Error("missing fixture message");
  return {
    w,
    run,
    d,
    u,
    msg,
    control: (text = msg.text ?? "") =>
      browserTaskControl(w, u, d, msg, { name: "ask", args: text }),
  };
}

test("a status receipt describes the site and action without exposing field values or URL secrets", () => {
  const f = fixture();
  expect(f.control()).toBe(true);
  expect(f.w.runs).toHaveLength(1);
  expect(f.w.deliveries[0]?.text).toContain(
    "click a control on https://example.com",
  );
  expect(f.w.deliveries[0]?.text).not.toContain("never-echo");
  expect(f.w.deliveries[0]?.text).not.toContain("/private");
});

for (const scope of [
  "actor",
  "topic",
  "bot",
  "revoked member",
  "disabled Browser",
  "epoch",
  "forward",
  "group",
  "reply",
] as const)
  test(`short Browser controls cannot cross ${scope} boundaries`, () => {
    const f = fixture();
    if (scope === "actor") {
      f.msg.from = { id: 101, is_bot: false };
      f.msg.chat.id = 101;
    }
    if (scope === "topic") f.msg.message_thread_id = 8;
    if (scope === "bot" && f.d.bot) f.d.bot.id = "998";
    if (scope === "revoked member") {
      const member = f.w.members.find((m) => m.id === "202");
      if (member) member.active = false;
    }
    if (scope === "disabled Browser")
      f.w.plugins = {
        revision: 1,
        entries: [],
        browser: { enabled: false, generation: 1 },
      };
    if (scope === "epoch") f.w.browserEpochs = { "202": 1 };
    if (scope === "forward")
      f.msg.forward_origin = {
        type: "hidden_user",
        sender_user_name: "Untrusted",
        date: f.msg.date,
      };
    if (scope === "group") f.msg.chat = { id: -100100, type: "group" };
    if (scope === "reply")
      f.msg.reply_to_message = {
        message_id: 999999,
      };
    const before = structuredClone(f.w);
    expect(f.control()).toBe(false);
    expect(f.w).toEqual(before);
  });

test("the oldest current Browser goal stays canonical while an observer is active", () => {
  const f = fixture();
  const observer = createRun(
    f.w,
    "202",
    "Explain the progress",
    "202",
    7,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  observer.browserRead = structuredClone(f.run.browserRead);
  observer.browserObserverOf = f.run.id;
  observer.status = "running";
  expect(activeBrowserTask(f.w, "202", 7, "999")?.id).toBe(f.run.id);
  expect(f.control("continue")).toBe(true);
  expect(f.run.status).toBe("awaiting_approval");
  expect(f.run.pendingInputs).toBeUndefined();
  expect(f.w.deliveries[0]?.runId).toBe(f.run.id);
});

test("unrelated requests and attachments retain ordinary conversation routing", () => {
  const f = fixture();
  expect(f.control("Continue by deleting the account")).toBe(false);
  expect(f.control("What is the progress of semiconductor research?")).toBe(
    false,
  );
  f.msg.photo = [
    { file_id: "fixture", file_unique_id: "fixture", width: 10, height: 10 },
  ];
  expect(f.control("continue")).toBe(false);
});
test("a short status after completion reports the finished task without starting Browser again", () => {
  const f = fixture();
  delete f.run.browserWait;
  f.run.status = "succeeded";
  expect(f.control()).toBe(true);
  expect(f.w.runs).toHaveLength(1);
  expect(f.w.deliveries[0]?.text).toContain("has finished");
});

test("private Browser history alone cannot own a new goal or revive an older expired task", () => {
  const f = fixture();
  delete f.run.browserWait;
  f.run.status = "partial";
  f.run.error = "browser_request_expired";
  const question = createRun(
    f.w,
    "202",
    "Explain an unrelated subject",
    "202",
    7,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  question.browserRead = structuredClone(f.run.browserRead);
  question.status = "running";
  expect(activeBrowserTask(f.w, "202", 7, "999")).toBeUndefined();
  expect(f.control("continue")).toBe(false);
  expect(f.run.status).toBe("partial");
});

for (const ending of ["cancelled", "denied", "unknown", "paused"] as const)
  test(`continuation does not revive ${ending} work or restore its approval`, () => {
    const f = fixture();
    delete f.run.browserWait;
    f.run.status = "partial";
    f.run.error =
      ending === "denied"
        ? "browser_request_denied"
        : ending === "unknown"
          ? "browser_outcome_unknown"
          : "browser_request_expired";
    if (ending === "cancelled") {
      f.run.status = "cancelled";
      f.run.cancelled = true;
    }
    if (ending === "paused") f.d.paused = true;
    f.control("continue");
    expect(f.run.status).toBe(ending === "cancelled" ? "cancelled" : "partial");
    expect(f.run.pendingInputs).toBeUndefined();
  });
