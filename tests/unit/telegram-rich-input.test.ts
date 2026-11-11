import { expect, test } from "bun:test";
import { command, updateSchema } from "../../src/telegram/router.ts";

const bot = { id: "999", username: "fixture_bot" };
const base = {
  message_id: 1,
  date: 1,
  from: { id: 101, is_bot: false },
  chat: { id: 101, type: "private" },
};
function incoming(blocks: unknown[], extra = {}) {
  const message = updateSchema.parse({
    update_id: 1,
    message: { ...base, rich_message: { blocks }, ...extra },
  }).message;
  if (!message) throw Error("missing message");
  return message;
}

test("rich paragraphs and nested formatting enter private conversation routing", () => {
  const message = incoming([
    { type: "paragraph", text: ["Hi ", { type: "bold", text: "there" }] },
    { type: "paragraph", text: "Second paragraph" },
  ]);
  expect(message.text).toBe("Hi there\nSecond paragraph");
  expect(command(message, bot)).toEqual({
    name: "ask",
    args: "Hi there\nSecond paragraph",
  });
});

test("rich command entities retain target checks and ordinary formatting grants no command", () => {
  expect(
    command(
      incoming([
        {
          type: "paragraph",
          text: { type: "bot_command", text: "/help", bot_command: "/help" },
        },
      ]),
      bot,
    ),
  ).toEqual({ name: "help", args: "" });
  expect(
    command(incoming([{ type: "paragraph", text: "/help" }]), bot)?.name,
  ).toBe("ask");
  expect(
    command(
      incoming([
        {
          type: "paragraph",
          text: {
            type: "bot_command",
            text: "/help@other_bot",
            bot_command: "/help@other_bot",
          },
        },
      ]),
      bot,
    ),
  ).toBeUndefined();
  expect(
    command(
      incoming([
        {
          type: "paragraph",
          text: { type: "bot_command", text: "/help", bot_command: "/capture" },
        },
      ]),
      bot,
    )?.name,
  ).toBe("ask");
});

test("rich group mentions use UTF-16 offsets and quotations cannot address the bot", () => {
  const mention = {
    type: "mention",
    text: "@fixture_bot",
    mention: "@fixture_bot",
  };
  const group = { chat: { id: -100, type: "supergroup" } };
  const addressed = incoming(
    [{ type: "paragraph", text: ["😀 ", mention, " help"] }],
    group,
  );
  expect(addressed.entities?.[0]?.offset).toBe(3);
  expect(command(addressed, bot)?.name).toBe("ask");
  for (const type of ["pre", "expandable_blockquote"])
    expect(
      command(incoming([{ type, text: mention }], group), bot),
    ).toBeUndefined();
  expect(
    command(
      incoming(
        [
          {
            type: "blockquote",
            blocks: [{ type: "paragraph", text: mention }],
          },
        ],
        group,
      ),
      bot,
    ),
  ).toBeUndefined();
});

test("forwarded rich commands remain reference data and legacy content wins", () => {
  const message = incoming(
    [
      {
        type: "paragraph",
        text: {
          type: "bot_command",
          text: "/capture on",
          bot_command: "/capture on",
        },
      },
    ],
    {
      forward_origin: {
        type: "hidden_user",
        date: 1,
        sender_user_name: "Fixture",
      },
    },
  );
  expect(command(message, bot)?.name).toBe("ask");
  expect(
    incoming([{ type: "paragraph", text: "rich" }], { text: "legacy" }).text,
  ).toBe("legacy");
  expect(
    incoming([{ type: "paragraph", text: "rich" }], { caption: "caption" })
      .caption,
  ).toBe("caption");
});

test("rich text is bounded and excludes hidden URLs, buttons and unknown metadata", () => {
  expect(
    incoming([
      {
        type: "paragraph",
        text: {
          type: "url",
          text: "Visible",
          url: "https://private.invalid/secret",
        },
      },
      { type: "unknown", html: "hidden instructions", text: "hidden" },
      {
        type: "buttons",
        rows: [[{ text: "Delete", callback_data: "approve:secret" }]],
      },
    ]).text,
  ).toBe("Visible");
  expect(
    incoming([{ type: "paragraph", text: "x".repeat(40000) }]).text,
  ).toHaveLength(20000);
  let text: unknown = "deep";
  for (let i = 0; i < 100; i++) text = { type: "bold", text };
  expect(incoming([{ type: "paragraph", text }]).text).toBe("");
});

test("rich edits and replied-to references normalize before schema stripping", () => {
  const update = updateSchema.parse({
    update_id: 2,
    edited_message: {
      ...base,
      rich_message: { blocks: [{ type: "paragraph", text: "Updated" }] },
    },
    message: {
      ...base,
      text: "Use this",
      reply_to_message: {
        message_id: 2,
        rich_message: { blocks: [{ type: "paragraph", text: "Reference" }] },
        forward_origin: {
          type: "hidden_user",
          date: 1,
          sender_user_name: "Fixture",
        },
      },
    },
  });
  expect(update.edited_message?.text).toBe("Updated");
  expect(update.message?.reply_to_message?.text).toBe("Reference");
});
