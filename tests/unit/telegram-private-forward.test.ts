import { expect, test } from "bun:test";
import { privateForwardAnchor } from "../../src/telegram/private-forward.ts";
import type { Message } from "../../src/telegram/router.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const now = Date.parse("2026-10-29T09:00:00Z");
function fixture(forwardFirst = true) {
  const w = workspace();
  const prior = createRun(
    w,
    "101",
    forwardFirst ? "forwarded reference" : "save this",
    "101",
    0,
    "test",
    {
      replyTo: 10,
      botId: "999",
      now: new Date(now - 1000),
    },
  );
  const source = w.messages[0];
  if (!source) throw Error("missing source");
  source.forwarded = forwardFirst;
  const message: Message = {
    message_id: 11,
    date: now / 1000,
    chat: { id: 101, type: "private" },
    from: { id: 101, is_bot: false },
    text: forwardFirst ? "save this" : "release notes",
    forward_origin: forwardFirst
      ? undefined
      : {
          type: "hidden_user",
          date: 1,
          sender_user_name: "Original author",
        },
  };
  return { w, prior, source, message };
}

test.each([true, false])(
  "adjacent private forwards and notes share an anchor (forward first: %s)",
  (forwardFirst) => {
    const { w, prior, message } = fixture(forwardFirst);
    expect(privateForwardAnchor(w, message, "999", now)).toBe(prior.replyTo);
  },
);

test.each(["queued", "running", "succeeded", "partial"] as const)(
  "a %s request can receive a forwarded reference",
  (status) => {
    const { w, prior, message } = fixture(false);
    prior.status = status;
    expect(privateForwardAnchor(w, message, "999", now)).toBe(10);
  },
);

const boundaries: [string, (input: ReturnType<typeof fixture>) => void][] = [
  [
    "ordinary messages",
    ({ source }) => {
      source.forwarded = false;
    },
  ],
  [
    "an explicit reply",
    ({ message }) => {
      message.reply_to_message = { message_id: 999 };
    },
  ],
  [
    "a native topic",
    ({ message }) => {
      message.message_thread_id = 21;
    },
  ],
  [
    "a preceding native topic",
    ({ source, prior }) => {
      source.topicId = prior.topicId = 21;
    },
  ],
  [
    "a different actor",
    ({ message }) => {
      if (message.from) message.from.id = 202;
    },
  ],
  [
    "a bot sender",
    ({ message }) => {
      if (message.from) message.from.is_bot = true;
    },
  ],
  [
    "a sender chat",
    ({ message }) => {
      message.sender_chat = { id: -10, type: "channel" };
    },
  ],
  [
    "a group",
    ({ message }) => {
      message.chat.type = "supergroup";
    },
  ],
  [
    "an automatic forward",
    ({ message }) => {
      message.is_automatic_forward = true;
    },
  ],
  [
    "revoked membership",
    ({ w }) => {
      w.members = [];
    },
  ],
  [
    "another workspace",
    ({ w }) => {
      w.messages = [];
      w.runs = [];
      w.threads = [];
    },
  ],
  [
    "expired content",
    ({ source }) => {
      source.expiresAt = new Date(now - 1).toISOString();
    },
  ],
  [
    "content outside current retention",
    ({ source }) => {
      source.retentionOriginAt = new Date(0).toISOString();
    },
  ],
  [
    "an old forward",
    ({ source }) => {
      source.at = new Date(now - 61000).toISOString();
    },
  ],
  [
    "a delayed update",
    ({ message }) => {
      message.date -= 61;
    },
  ],
  [
    "a future update",
    ({ message }) => {
      message.date += 2;
    },
  ],
  [
    "the same message",
    ({ message }) => {
      message.message_id = 10;
    },
  ],
  [
    "a cancelled request",
    ({ prior }) => {
      prior.cancelled = true;
    },
  ],
  [
    "a failed request",
    ({ prior }) => {
      prior.status = "failed";
    },
  ],
  [
    "a workflow",
    ({ prior }) => {
      prior.workflowId = "scheduled";
    },
  ],
  [
    "a different bot thread",
    ({ w }) => {
      if (w.threads?.[0]) w.threads[0].botId = "888";
    },
  ],
  [
    "an intervening command",
    ({ w, source }) => {
      w.messages.push({
        ...source,
        id: "999:101:12",
        text: "/help",
        runId: undefined,
        role: undefined,
      });
    },
  ],
];
test.each(boundaries)(
  "private forwarding does not bridge %s",
  (_name, change) => {
    const input = fixture();
    change(input);
    expect(
      privateForwardAnchor(input.w, input.message, "999", now),
    ).toBeUndefined();
  },
);

test("bot-scoped source IDs prevent another bot's forwards from being paired", () => {
  const { w, message } = fixture();
  expect(privateForwardAnchor(w, message, "888", now)).toBeUndefined();
});

test("a forward delivered after its later comment still supplies the reference", () => {
  const { w, message } = fixture(false);
  message.message_id = 9;
  message.date -= 2;
  expect(privateForwardAnchor(w, message, "999", now)).toBe(10);
});

test("only one following note is implicitly joined; subsequent ordinary messages start separately", () => {
  const { w, message } = fixture();
  const anchor = privateForwardAnchor(w, message, "999", now);
  const note = createRun(w, "101", "save this", "101", 0, "test", {
    replyTo: message.message_id,
    continueFrom: anchor,
    botId: "999",
    now: new Date(now),
  });
  expect(note.sources).toHaveLength(2);
  expect(
    privateForwardAnchor(
      w,
      { ...message, message_id: 12, text: "unrelated request" },
      "999",
      now,
    ),
  ).toBeUndefined();
});
