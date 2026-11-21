import { describe, expect, test } from "bun:test";
import { parseFollowupDecision } from "../../src/agent/followup.ts";
import type { Source } from "../../src/domain.ts";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { TelegramDraft } from "../../src/telegram/draft.ts";
import { TelegramTyping } from "../../src/telegram/typing.ts";
import { retainWorkspaceMessages } from "../../src/workspaces/threads.ts";

describe("TelegramTyping and draft fallback", () => {
  test("sends periodic typing actions with topic ID and stops immediately on stop or abort", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client: Telegram = {
      async call<T>(method: string, params = {}) {
        calls.push({ method, params });
        return true as T;
      },
    };
    const controller = new AbortController();
    const typing = new TelegramTyping(
      { chatId: "-100123", topicId: 9 },
      async () => client,
      async () => {},
      controller.signal,
      { initialDelayMs: 15, intervalMs: 25 },
    );

    typing.start();
    await new Promise((r) => setTimeout(r, 55));
    typing.stop();
    const countAfterStop = calls.length;
    expect(countAfterStop).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toEqual({
      method: "sendChatAction",
      params: {
        chat_id: -100123,
        message_thread_id: 9,
        action: "typing",
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(countAfterStop);
  });

  test("disables permanently on permanent Telegram error without throwing", async () => {
    let attempts = 0;
    const client: Telegram = {
      async call() {
        attempts++;
        throw new TelegramError("telegram_destination_rejected", "permanent");
      },
    };
    const controller = new AbortController();
    const typing = new TelegramTyping(
      { chatId: "-100123", topicId: 0 },
      async () => client,
      async () => {},
      controller.signal,
      { initialDelayMs: 5, intervalMs: 10 },
    );
    typing.start();
    await new Promise((r) => setTimeout(r, 50));
    typing.stop();
    expect(attempts).toBe(1);
  });

  test("TelegramDraft invokes onDisabled fallback when draft transport is permanently rejected", async () => {
    let fallbackTriggered = false;
    const client: Telegram = {
      async call() {
        throw new TelegramError("telegram_destination_rejected", "permanent");
      },
    };
    const controller = new AbortController();
    const draft = new TelegramDraft(
      { chatId: "101", topicId: 0, draftId: 77 },
      async () => client,
      async () => {},
      () => {},
      controller.signal,
      Date.now,
      () => {},
      () => {
        fallbackTriggered = true;
      },
    );
    await draft.start();
    expect(fallbackTriggered).toBe(true);
  });
});

describe("parseFollowupDecision", () => {
  test("tolerates case, markdown wrapping and trailing punctuation on REPLY while staying fail-closed", () => {
    for (const sample of [
      "REPLY",
      "reply",
      "REPLY.",
      "REPLY!",
      "**REPLY**",
      "`REPLY`",
      "  Reply\n",
    ]) {
      expect(parseFollowupDecision(sample)).toBe("reply");
    }
    for (const sample of [
      "",
      "IGNORE",
      "ignore.",
      "DO NOT REPLY",
      "NOT REPLY",
      "Probably REPLY because it relates",
      "I think you should ignore this",
    ]) {
      expect(parseFollowupDecision(sample)).toBe("ignore");
    }
  });
});

describe("retainWorkspaceMessages", () => {
  function msg(
    id: string,
    chatId: string,
    topicId: number,
    directed = false,
  ): Source {
    return {
      id,
      chatId,
      topicId,
      author: "101",
      text: id,
      at: "2026-11-21T00:00:00.000Z",
      expiresAt: "2026-12-21T00:00:00.000Z",
      directed,
    };
  }

  test("prevents one noisy group from evicting private chats or quieter groups", () => {
    const messages: Source[] = [];
    // Seed private chat and a quiet group first (oldest timestamps).
    for (let i = 0; i < 20; i++) {
      messages.push(msg(`priv-${i}`, "101", 0, true));
    }
    for (let i = 0; i < 15; i++) {
      messages.push(msg(`quiet-${i}`, "-100200", 0, true));
    }
    // Flood a noisy group with 100 ambient messages + 10 directed messages.
    for (let i = 0; i < 100; i++) {
      messages.push(msg(`noisy-ambient-${i}`, "-100999", 0, false));
    }
    for (let i = 0; i < 10; i++) {
      messages.push(msg(`noisy-directed-${i}`, "-100999", 0, true));
    }

    const retained = retainWorkspaceMessages(messages, 100, 50);
    expect(retained.length).toBeLessThanOrEqual(100);
    // All private and quiet group messages survive!
    expect(retained.filter((m) => m.chatId === "101")).toHaveLength(20);
    expect(retained.filter((m) => m.chatId === "-100200")).toHaveLength(15);
    // Noisy group is capped at 50, keeping all 10 directed messages + 40 newest ambient messages.
    const noisy = retained.filter((m) => m.chatId === "-100999");
    expect(noisy).toHaveLength(50);
    expect(noisy.filter((m) => m.directed)).toHaveLength(10);
    expect(noisy[0]?.id).toBe("noisy-ambient-60");
    // Original chronological order is preserved.
    expect(retained[0]?.id).toBe("priv-0");
    expect(retained.at(-1)?.id).toBe("noisy-directed-9");
  });
});
