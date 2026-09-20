import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { config } from "../../src/config.ts";
import type { Store } from "../../src/db/repositories.ts";
import { Fault } from "../../src/domain.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import type { SetupService } from "../../src/setup/service.ts";
import { TelegramClient, TelegramError } from "../../src/telegram/client.ts";
import {
  pollingErrorCode,
  pollingRetryDelay,
  TelegramPoller,
} from "../../src/telegram/polling.ts";

test("polling is explicit; default remains webhook and invalid modes fail", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/test",
    ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect(config(env).TELEGRAM_TRANSPORT).toBe("webhook");
  expect(
    config({ ...env, TELEGRAM_TRANSPORT: "polling" }).TELEGRAM_TRANSPORT,
  ).toBe("polling");
  expect(() => config({ ...env, TELEGRAM_TRANSPORT: "auto" })).toThrow();
});
test("long polling requests support cancellation and an explicit timeout", async () => {
  const started = Promise.withResolvers<void>();
  const client = new TelegramClient("test-token", (async (
    _url: unknown,
    options?: RequestInit,
  ) => {
    const signal = options?.signal;
    expect(signal).toBeDefined();
    started.resolve();
    return new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  }) as unknown as typeof fetch);
  const abort = new AbortController();
  const call = client.call(
    "getUpdates",
    { timeout: 25 },
    { signal: abort.signal, timeoutMs: 35000 },
  );
  await started.promise;
  abort.abort();
  await expect(call).rejects.toThrow();
});
test("Telegram conflict/rate errors are redacted and rate backoff uses retry_after", async () => {
  for (const [status, code] of [
    [409, "telegram_polling_conflict"],
    [401, "telegram_unauthorized"],
    [429, "telegram_rate_limited"],
  ] as const) {
    const client = new TelegramClient("test-token", (async () =>
      Response.json({
        ok: false,
        error_code: status,
        description: "sensitive upstream description",
        parameters: { retry_after: 45 },
      })) as unknown as typeof fetch);
    await expect(client.call("getUpdates")).rejects.toThrow(code);
  }
  expect(
    pollingRetryDelay(new TelegramError("telegram_rate_limited", "retry", 45)),
  ).toBe(45000);
  expect(pollingRetryDelay(new Error("failure"))).toBe(5000);
});

test("polling diagnostics classify failures without exposing raw errors or updates", () => {
  const invalid = z.object({ update_id: z.number() }).safeParse({
    update_id: "private message content",
  });
  expect(pollingErrorCode(invalid.error)).toBe("polling_invalid_update");
  expect(pollingErrorCode(new Fault("polling_webhook_conflict", 409))).toBe(
    "polling_webhook_conflict",
  );
  expect(
    pollingErrorCode(new Error("https://api.telegram.org/botSECRET")),
  ).toBe("polling_receive_failed");
});

test("polling loop logs a redacted code and retry delay and stays quiet on shutdown", async () => {
  const store = {
    pool: { query: async () => ({ rows: [] }) },
    log: new RuntimeLogger(undefined, "worker"),
  } as unknown as Store;
  for (const shutdown of [false, true]) {
    const poller = new TelegramPoller(store, {} as SetupService);
    const abort = new AbortController();
    const poll = spyOn(poller, "pollOnce").mockImplementation(async () => {
      if (shutdown) abort.abort();
      throw new TelegramError("telegram_rate_limited", "retry", 45);
    });
    const lines: string[] = [];
    const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      abort.abort();
      return true;
    });
    try {
      await poller.run(abort.signal);
      expect(
        lines.map((line) => {
          const { event, code, retry_delay_ms } = JSON.parse(line);
          return { event, code, retry_delay_ms };
        }),
      ).toEqual(
        shutdown
          ? []
          : [
              {
                event: "telegram_polling_failed",
                code: "telegram_rate_limited",
                retry_delay_ms: 45000,
              },
            ],
      );
    } finally {
      write.mockRestore();
      poll.mockRestore();
    }
  }
});
