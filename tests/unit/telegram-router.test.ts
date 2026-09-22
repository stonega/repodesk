import { describe, expect, test } from "bun:test";
import {
  command,
  type Message,
  updateSchema,
} from "../../src/telegram/router.ts";

test("native Stop schema accepts chat/topic/draft without a sender and rejects invalid IDs", () => {
  const event = {
    update_id: 100,
    stopped_message_generation: {
      chat: { id: 101, type: "private" as const },
      draft_id: 2 ** 40,
      message_thread_id: 7,
    },
  };
  expect(updateSchema.parse(event)).toEqual(event);
  for (const draft_id of [
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "123",
    undefined,
  ])
    expect(
      updateSchema.safeParse({
        ...event,
        stopped_message_generation: {
          ...event.stopped_message_generation,
          draft_id,
        },
      }).success,
    ).toBe(false);
});

const bot = { id: "999", username: "agent_bub_bot" };
const mention = "@agent_bub_bot";
function message(text = `${mention} hi`): Message {
  return {
    message_id: 1,
    date: 1,
    chat: { id: -100100, type: "supergroup" },
    from: { id: 101, is_bot: false },
    text,
    entities: [{ type: "mention", offset: 0, length: mention.length }],
  };
}

describe("group mentions", () => {
  test("routes the reported mention and matches usernames case-insensitively", () => {
    for (const type of ["group", "supergroup"] as const) {
      const m = message("@Agent_Bub_Bot hi");
      m.chat.type = type;
      expect(command(m, bot)).toEqual({ name: "ask", args: "hi" });
    }
  });

  test("uses UTF-16 offsets and preserves the request around the mention", () => {
    const m = message(`👋 ${mention}, help @teammate`);
    m.entities = [
      { type: "mention", offset: 3, length: mention.length },
      { type: "mention", offset: m.text?.indexOf("@teammate") ?? 0, length: 9 },
    ];
    expect(command(m, bot)).toEqual({
      name: "ask",
      args: "👋 , help @teammate",
    });
    expect(command(message(mention), bot)).toEqual({
      name: "ask",
      args: mention,
    });
  });

  test("ignores other usernames, literal/code text, and malformed mention spans", () => {
    for (const text of ["@another_bot hi", "@agent_bub_bot_extra hi"]) {
      const m = message(text);
      m.entities = [{ type: "mention", offset: 0, length: text.indexOf(" ") }];
      expect(command(m, bot)).toBeUndefined();
    }
    const m = message();
    for (const entities of [
      undefined,
      [{ type: "code", offset: 0, length: mention.length }],
      [{ type: "mention", offset: -1, length: mention.length }],
      [{ type: "mention", offset: 1, length: mention.length }],
    ]) {
      m.entities = entities;
      expect(command(m, bot)).toBeUndefined();
    }
  });

  test("ignores bot and anonymous senders and commands addressed to another bot", () => {
    const m = message();
    m.from = { id: 101, is_bot: true };
    expect(command(m, bot)).toBeUndefined();
    m.from = undefined;
    expect(command(m, bot)).toBeUndefined();
    m.from = { id: 101, is_bot: false };
    m.sender_chat = m.chat;
    expect(command(m, bot)).toBeUndefined();
    m.sender_chat = undefined;
    m.text = `/ask@other_bot ${mention} hi`;
    m.entities = [
      { type: "bot_command", offset: 0, length: 14 },
      { type: "mention", offset: 15, length: mention.length },
    ];
    expect(command(m, bot)).toBeUndefined();
  });

  test("preserves existing private and reply routing", () => {
    const m = message();
    m.chat = { id: 101, type: "private" };
    expect(command(m, bot)).toEqual({ name: "ask", args: `${mention} hi` });
    m.chat = { id: -100100, type: "supergroup" };
    m.reply_to_message = { message_id: 2, from: { id: 999, is_bot: true } };
    expect(command(m, bot)).toEqual({ name: "ask", args: `${mention} hi` });
  });
});
