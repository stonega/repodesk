import { expect, test } from "bun:test";
import { TelegramClient } from "../../src/telegram/client.ts";

test("Telegram edit errors expose only safe classifications, scoped to editMessageText", async () => {
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
    await expect(
      client.call("editMessageText", {
        chat_id: "101",
        message_id: 1,
        text: "Working",
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
