import { expect, test } from "bun:test";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { groupVisibility } from "../../src/telegram/visibility.ts";

test("group visibility distinguishes global privacy from group admin access", async () => {
  for (const [privacyDisabled, status, visible] of [
    [true, "member", true],
    [false, "administrator", true],
    [false, "member", false],
    [false, "left", false],
  ] as const) {
    const client: Telegram = {
      async call<T>(method: string) {
        return (
          method === "getMe"
            ? { can_read_all_group_messages: privacyDisabled }
            : { status }
        ) as T;
      },
    };
    expect(await groupVisibility(client, "-100100", "999")).toBe(visible);
  }
});

test("inaccessible groups have limited visibility while transient Telegram errors remain retryable", async () => {
  for (const code of [
    "telegram_destination_rejected",
    "telegram_unavailable",
  ]) {
    const client: Telegram = {
      async call<T>(method: string) {
        if (method === "getMe") return {} as T;
        throw new TelegramError(code, "retry");
      },
    };
    if (code === "telegram_destination_rejected")
      expect(await groupVisibility(client, "-100100", "999")).toBe(false);
    else
      await expect(
        groupVisibility(client, "-100100", "999"),
      ).rejects.toMatchObject({
        code,
      });
  }
});
