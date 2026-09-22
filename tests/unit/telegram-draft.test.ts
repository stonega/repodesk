import { expect, test } from "bun:test";
import { Fault } from "../../src/domain.ts";
import { type Telegram, TelegramError } from "../../src/telegram/client.ts";
import { TelegramDraft } from "../../src/telegram/draft.ts";
import { telegramRichMessage } from "../../src/telegram/format.ts";

function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const reports: { event: string; error?: unknown }[] = [];
  let now = 0;
  let allowed = true;
  let failure: Error | undefined;
  const controller = new AbortController();
  const client: Telegram = {
    async call<T>(method: string, params = {}) {
      calls.push({ method, params });
      if (failure) throw failure;
      return true as T;
    },
  };
  const draft = new TelegramDraft(
    { chatId: "101", topicId: 42, draftId: 12345 },
    async () => client,
    async () => {
      if (!allowed) throw new Fault("run_revoked");
    },
    (text) => {
      if (text.includes("[source:forged]"))
        throw new Fault("invalid_source_citation");
    },
    controller.signal,
    () => now,
    (event, error) => reports.push({ event, error }),
  );
  return {
    draft,
    calls,
    reports,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    fail: (error?: Error) => {
      failure = error;
    },
  };
}

test("drafts throttle cumulative previews, keep one ID and preserve topic", async () => {
  const f = fixture();
  await f.draft.update("**Hello**");
  await f.draft.update("**Hello** world");
  expect(f.calls).toHaveLength(1);
  f.advance(1000);
  await f.draft.update("**Hello** world");
  f.advance(1000);
  await f.draft.update("**Hello** world");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.method).toBe("sendRichMessageDraft");
  expect(f.calls[0]?.params).toMatchObject({
    chat_id: 101,
    message_thread_id: 42,
  });
  expect(f.calls[0]?.params.draft_id).toBe(12345);
  expect(f.calls[0]?.params.can_stop).toBe(true);
  expect(f.calls[0]?.params.keep_on_stop).toBe(false);
  expect(f.calls[1]?.params.draft_id).toBe(f.calls[0]?.params.draft_id);
  expect(f.calls[1]?.params.rich_message).toEqual(
    telegramRichMessage("**Hello** world"),
  );
  expect(f.draft.delivered).toBe(true);
  expect(f.reports).toEqual([
    { event: "telegram_draft_started", error: undefined },
  ]);
});

test("native thinking starts immediately and does not throttle the first text", async () => {
  const f = fixture();
  await f.draft.start();
  await f.draft.update("First tokens");
  expect(f.calls.map((call) => call.method)).toEqual([
    "sendMessageDraft",
    "sendRichMessageDraft",
  ]);
  expect(f.calls[0]?.params).toEqual({
    chat_id: 101,
    message_thread_id: 42,
    draft_id: 12345,
    text: "",
    can_stop: true,
    keep_on_stop: false,
  });
  expect(f.calls[1]?.params.draft_id).toBe(12345);
});

test("thinking respects cancellation, revocation and rate limits", async () => {
  const cancelled = fixture();
  cancelled.controller.abort();
  await cancelled.draft.start();
  expect(cancelled.calls).toHaveLength(0);
  const revoked = fixture();
  revoked.revoke();
  await revoked.draft.start();
  expect(revoked.calls).toHaveLength(0);
  const limited = fixture();
  limited.fail(new TelegramError("telegram_rate_limited", "retry", 5));
  await limited.draft.start();
  await limited.draft.update("First tokens");
  limited.advance(4999);
  await limited.draft.update("First tokens");
  expect(limited.calls).toHaveLength(1);
  limited.advance(1);
  await limited.draft.update("First tokens");
  expect(limited.calls).toHaveLength(2);
});

test("drafts honor retry_after and disable on unsupported transport", async () => {
  const f = fixture();
  f.fail(new TelegramError("telegram_rate_limited", "retry", 5));
  await f.draft.update("First");
  f.advance(4999);
  await f.draft.update("Second");
  expect(f.calls).toHaveLength(1);
  f.advance(1);
  await f.draft.update("Second");
  expect(f.calls).toHaveLength(2);
  for (const disposition of ["permanent"] as const) {
    const blocked = fixture();
    blocked.fail(
      new TelegramError("telegram_destination_rejected", disposition),
    );
    await blocked.draft.update("First");
    blocked.advance(30000);
    await blocked.draft.update("Second");
    expect(blocked.calls).toHaveLength(1);
    expect(blocked.draft.delivered).toBe(false);
    expect(blocked.reports[0]?.event).toBe("telegram_draft_failed");
    expect(blocked.reports[0]?.error).toBeInstanceOf(TelegramError);
  }
});

test("a timed-out thinking draft recovers on later text with the same ID", async () => {
  const f = fixture();
  f.fail(new TelegramError("telegram_outcome_unknown", "unknown"));
  await f.draft.start();
  await f.draft.update("First tokens");
  expect(f.calls).toHaveLength(1);
  f.fail();
  f.advance(1000);
  await f.draft.update("First tokens");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]?.params.draft_id).toBe(f.calls[0]?.params.draft_id);
  expect(f.draft.delivered).toBe(true);
  expect(f.reports.map((r) => r.event)).toEqual([
    "telegram_draft_failed",
    "telegram_draft_started",
  ]);
});

test("transient draft retries are bounded and recheck access", async () => {
  const f = fixture();
  f.fail(new TelegramError("telegram_outcome_unknown", "unknown"));
  for (let i = 0; i < 5; i++) {
    await f.draft.update("Latest text");
    f.advance(1000);
  }
  expect(f.calls).toHaveLength(3);
  const revoked = fixture();
  revoked.fail(new TelegramError("telegram_outcome_unknown", "unknown"));
  await revoked.draft.start();
  revoked.fail();
  revoked.advance(1000);
  revoked.revoke();
  await revoked.draft.update("Private text");
  expect(revoked.calls).toHaveLength(1);
});

test("revocation, cancellation and invalid sources stop preview publication", async () => {
  const f = fixture();
  await f.draft.update("[source:unfinished");
  await f.draft.update("[source:forged]");
  expect(f.calls).toHaveLength(0);
  await f.draft.update("Allowed");
  f.advance(1000);
  f.revoke();
  await f.draft.update("Revoked");
  expect(f.calls).toHaveLength(1);
  const aborted = fixture();
  aborted.controller.abort();
  await aborted.draft.update("Cancelled");
  expect(aborted.calls).toHaveLength(0);
});

test("rich drafts preserve safe nested styles and literal code without loading media", () => {
  const rich = telegramRichMessage(
    "**bold _nested_** `code` [safe](https://example.com) [bad](javascript:alert) <b>literal</b> ![image](https://example.com/a.png)",
  );
  const json = JSON.stringify(rich);
  expect(json).toContain('"type":"bold"');
  expect(json).toContain('"type":"italic"');
  expect(json).toContain('"type":"code"');
  expect(json).toContain('"url":"https://example.com/"');
  expect(json).not.toContain('"url":"javascript:');
  expect(json).not.toContain('"type":"photo"');
  expect(json).toContain("<b>");
  expect(json).toContain("literal");
  expect(json).toContain("</b>");
  expect(rich.skip_entity_detection).toBe(true);
});
