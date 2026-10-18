import { expect, test } from "bun:test";
import { TelegramClient } from "../../src/telegram/client.ts";

test("Telegram text and keyboard edits expose safe error classifications without changing send errors", async () => {
  for (const [description, code] of [
    ["Bad Request: message is not modified", "telegram_message_not_modified"],
    ["Bad Request: message to edit not found", "telegram_message_uneditable"],
    ["Bad Request: message can't be edited", "telegram_message_uneditable"],
    [
      "Bad Request: private-secret destination forbidden",
      "telegram_destination_rejected",
    ],
  ]) {
    const client = new TelegramClient("fake", (async () =>
      Response.json({
        ok: false,
        error_code: 400,
        description,
      })) as unknown as typeof fetch);
    for (const method of ["editMessageText", "editMessageReplyMarkup"])
      await expect(
        client.call(method, {
          chat_id: "101",
          message_id: 1,
          ...(method === "editMessageText"
            ? { text: "Working" }
            : { reply_markup: { inline_keyboard: [] } }),
        }),
      ).rejects.toMatchObject({ code, disposition: "permanent" });
    await expect(
      client.call("sendMessage", { chat_id: "101", text: "Working" }),
    ).rejects.toMatchObject({
      code: "telegram_destination_rejected",
      disposition: "permanent",
    });
  }
});
