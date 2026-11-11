import { expect, test } from "bun:test";
import type { Delivery, Run } from "../../src/domain.ts";
import { TelegramClient } from "../../src/telegram/client.ts";
import {
  configurePrivateTopicFallback,
  privateTopicFallback,
} from "../../src/telegram/topic-fallback.ts";
import { updateMembership } from "../../src/workspaces/policy.ts";
import { workspace } from "../fixtures.ts";

test("only confirmed message-send Topic rejection receives the fixed safe code", async () => {
  for (const method of [
    "sendMessage",
    "sendRichMessage",
    "editMessageText",
    "sendWidget",
  ])
    for (const errorCode of [400, 403, 500]) {
      const client = new TelegramClient("private-token", (async () =>
        Response.json({
          ok: false,
          error_code: errorCode,
          description: "Bad Request: message thread not found",
        })) as unknown as typeof fetch);
      const error = await client.call(method).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code:
          errorCode === 400 &&
          ["sendMessage", "sendRichMessage"].includes(method)
            ? "telegram_thread_not_found"
            : errorCode === 500
              ? "telegram_unavailable"
              : "telegram_destination_rejected",
      });
      expect(JSON.stringify(error)).not.toContain("Bad Request");
      expect(JSON.stringify(error)).not.toContain("private-token");
    }
});

test("private Topic recovery excludes other actors, groups, changed consent and interactive deliveries", () => {
  const w = workspace();
  const member = w.members.find((m) => m.id === "101");
  if (!member) throw Error("missing member");
  const consent = { botId: "999", enabledAt: new Date().toISOString() };
  member.privateTopicFallback = consent;
  const run = { id: "run1", actor: "101", chatId: "101", topicId: 77 } as Run;
  w.runs.push(run);
  const delivery: Delivery = {
    id: "run:run1:result",
    actor: "101",
    chatId: "101",
    topicId: 77,
    runId: run.id,
    botId: "999",
    text: "Hello",
    state: "pending",
    at: consent.enabledAt,
    attempts: 1,
  };
  expect(privateTopicFallback(w, delivery, "999")).toEqual(consent);
  for (const patch of [
    { actor: "102" },
    { chatId: "-100" },
    { topicId: 0 },
    { botId: "1000" },
    { id: "event:access" },
    { buttons: [[{ text: "Approve", callback_data: "approval" }]] },
    { widget: { html: "<p>Hi</p>", caption: "Hi", botId: "999" } },
    { editOf: "another" },
    { browserRequest: { id: "browser", expiresAt: Date.now() + 10000 } },
    { privateTopicFallback: { ...consent, enabledAt: "old-consent" } },
  ])
    expect(
      privateTopicFallback(w, { ...delivery, ...patch }, "999"),
    ).toBeUndefined();
  run.workflowId = "scheduled";
  expect(privateTopicFallback(w, delivery, "999")).toBeUndefined();
  delete run.workflowId;
  expect(privateTopicFallback(w, delivery, "1000")).toBeUndefined();
  member.active = false;
  expect(privateTopicFallback(w, delivery, "999")).toBeUndefined();
});

test("removing then restoring membership cannot restore old Topic fallback consent", () => {
  const w = workspace();
  const member = w.members.find((m) => m.id === "101");
  if (!member) throw Error("missing member");
  member.privateTopicFallback = {
    botId: "999",
    enabledAt: new Date().toISOString(),
  };
  member.role = "member";
  updateMembership(w, w.operatorId, w.memberVersion, {
    id: "101",
    role: "member",
    active: false,
  });
  updateMembership(w, w.operatorId, w.memberVersion, {
    id: "101",
    role: "member",
    active: true,
  });
  expect(
    w.members.find((m) => m.id === "101")?.privateTopicFallback,
  ).toBeUndefined();
});

test("host configuration is operator-only, audited and invalidates previously queued consent", () => {
  const w = workspace();
  expect(() =>
    configurePrivateTopicFallback(w, "untrusted", "101", "999", true),
  ).toThrow("access_denied");
  const old = { botId: "999", enabledAt: "2026-01-01T00:00:00.000Z" };
  w.deliveries.push({
    id: "old",
    actor: "101",
    chatId: "101",
    topicId: 77,
    text: "Hi",
    state: "pending",
    attempts: 1,
    at: old.enabledAt,
    privateTopicFallback: old,
  });
  configurePrivateTopicFallback(w, w.operatorId, "101", "999", true);
  expect(w.deliveries[0]?.state).toBe("cancelled");
  expect(
    w.members.find((m) => m.id === "101")?.privateTopicFallback?.botId,
  ).toBe("999");
  expect(w.audit.at(-1)?.action).toBe("member.topic_fallback_enabled");
  configurePrivateTopicFallback(w, w.operatorId, "101", "999", false);
  expect(
    w.members.find((m) => m.id === "101")?.privateTopicFallback,
  ).toBeUndefined();
  expect(w.audit.at(-1)?.action).toBe("member.topic_fallback_disabled");
});
