import { expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import {
  authorizeReaction,
  queueReaction,
  reactionDeliveryAllowed,
} from "../../src/telegram/reactions.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function fixture(chatId = "101", topicId = 7) {
  const w = workspace();
  const r = createRun(
    w,
    "101",
    "Thanks, that worked!",
    chatId,
    topicId,
    "gpt-4.1-mini",
    {
      botId: "999",
      replyTo: 42,
    },
  );
  r.status = "running";
  r.fence = 1;
  return { w, r };
}
function tool(w: Workspace, r: Run, workspaceId = w.id, fence = r.fence) {
  const store = {
    change: async (id: string, action: (w: Workspace) => unknown) => {
      if (id !== w.id) throw Error("not_found");
      return action(w);
    },
    deployment: async () => ({
      active: true,
      paused: false,
      bot: { id: "999" },
    }),
  } as Store;
  const found = applicationTools(store, workspaceId, r.id, fence).find(
    (t) => t.name === "react_to_message",
  );
  if (!found) throw Error("missing reaction tool");
  return found;
}

test("reactions choose an emoji while the application fixes private/group message and bot", () => {
  for (const chatId of ["101", "-100100"]) {
    const { w, r } = fixture(chatId);
    expect(queueReaction(w, r, { emoji: "❤️" }, "999")).toEqual({
      status: "queued",
      emoji: "❤",
    });
    const d = w.deliveries[0];
    expect(d).toMatchObject({
      actor: "101",
      chatId,
      topicId: 7,
      botId: "999",
      runId: r.id,
      state: "pending",
      reaction: { messageId: 42, emoji: "❤" },
    });
    expect(d?.reaction?.sourceId).toBe(
      chatId === "101" ? "999:101:42" : "-100100:42",
    );
    expect(d?.remoteId).toBeUndefined();
    expect(buildContext(w, r).system).toContain(
      "respect requests to skip reactions",
    );
  }
});

test("native reaction calls replay durably and cannot change a chosen emoji or call arguments", async () => {
  const { w, r } = fixture();
  const t = tool(w, r);
  const first = await t.execute("react", { emoji: "❤️" });
  expect(await t.execute("react", { emoji: "❤" })).toEqual(first);
  await t.execute("another-call", { emoji: "❤" });
  expect(w.deliveries).toHaveLength(1);
  await expect(t.execute("react", { emoji: "👍" })).rejects.toThrow(
    "tool_call_conflict",
  );
  await expect(t.execute("new-choice", { emoji: "👍" })).rejects.toThrow(
    "reaction_already_chosen",
  );
  if (w.deliveries[0]) w.deliveries[0].state = "failed";
  expect(queueReaction(w, r, { emoji: "❤" }, "999").status).toBe("failed");
});

test("models cannot supply reaction destinations, other message IDs, custom emoji or arbitrary text", () => {
  const { w, r } = fixture();
  for (const args of [
    {},
    { emoji: "not an emoji" },
    { emoji: "👋" },
    { emoji: "👍❤" },
    { emoji: "👍", chatId: "202" },
    { emoji: "👍", messageId: 99 },
    { emoji: "👍", sourceId: "999:202:42" },
    { emoji: "👍", actor: "202" },
    { emoji: "👍", custom_emoji_id: "123" },
    { emoji: "👍", is_big: true },
  ])
    expect(() => authorizeReaction(w, r, args)).toThrow();
  expect(w.deliveries).toHaveLength(0);
});

test("reactions require the retained current user source, not history, another author or another topic", () => {
  for (const field of [
    "runId",
    "author",
    "role",
    "chatId",
    "topicId",
    "threadId",
    "expiresAt",
    "id",
  ]) {
    for (const location of ["snapshot", "retained"]) {
      const { w, r } = fixture();
      const source = location === "snapshot" ? r.sources[0] : w.messages[0];
      if (!source) throw Error("missing source");
      Object.assign(source, {
        [field]:
          field === "topicId"
            ? 8
            : field === "expiresAt"
              ? new Date(0).toISOString()
              : "other",
      });
      expect(() => queueReaction(w, r, { emoji: "👍" }, "999")).toThrow(
        "reaction_target_denied",
      );
    }
  }
  const { w, r } = fixture();
  expect(() => queueReaction(w, r, { emoji: "👍" }, "888")).toThrow(
    "reaction_bot_changed",
  );
  r.replyTo = undefined;
  expect(() => queueReaction(w, r, { emoji: "👍" }, "999")).toThrow(
    "reaction_target_denied",
  );
  r.replyTo = 42;
  r.workflowId = "scheduled";
  expect(() => authorizeReaction(w, r, { emoji: "👍" })).toThrow(
    "reaction_target_denied",
  );
});

test("tool fencing, tenant identity, membership, cancellation, pauses and schedules apply to reactions", async () => {
  for (const mode of [
    "fence",
    "tenant",
    "membership",
    "cancelled",
    "paused",
    "schedule",
  ]) {
    const { w, r } = fixture();
    const t = tool(
      w,
      r,
      mode === "tenant" ? "another-workspace" : w.id,
      mode === "fence" ? 2 : 1,
    );
    if (mode === "membership")
      w.members.forEach((m) => {
        m.active = false;
      });
    if (mode === "cancelled") r.cancelled = true;
    if (mode === "paused") w.settings.paused = true;
    if (mode === "schedule") r.workflowId = "not-an-interactive-request";
    await expect(t.execute("denied", { emoji: "👍" })).rejects.toThrow();
    expect(w.deliveries).toHaveLength(0);
  }
  const { w, r } = fixture();
  r.skillPins = [];
  await tool(w, r).execute("no-skill-grant-needed", { emoji: "👍" });
  expect(w.deliveries).toHaveLength(1);
  w.messages = [];
  await expect(
    tool(w, r).execute("no-skill-grant-needed", { emoji: "👍" }),
  ).rejects.toThrow("tool_policy_denied");
});

test("delivery validation checks message identity, bot rotation and the complete audience binding", () => {
  for (const mode of [
    "valid",
    "bot",
    "actor",
    "chat",
    "topic",
    "source",
    "message",
    "emoji",
    "failed",
  ]) {
    const { w, r } = fixture();
    queueReaction(w, r, { emoji: "🎉" }, "999");
    const d = w.deliveries[0];
    if (!d?.reaction) throw Error("missing reaction");
    if (mode === "actor") d.actor = "202";
    if (mode === "chat") d.chatId = "202";
    if (mode === "topic") d.topicId = 8;
    if (mode === "source") d.reaction.sourceId = "999:202:42";
    if (mode === "message") d.reaction.messageId = 99;
    if (mode === "emoji") d.reaction.emoji = "unrecognized";
    if (mode === "failed") r.status = "failed";
    expect(reactionDeliveryAllowed(w, d, mode === "bot" ? "888" : "999")).toBe(
      mode === "valid",
    );
  }
});
