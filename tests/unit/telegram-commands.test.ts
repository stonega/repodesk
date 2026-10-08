import { expect, test } from "bun:test";
import type { Store } from "../../src/db/repositories.ts";
import type { Deployment } from "../../src/domain.ts";
import type { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { TelegramError } from "../../src/telegram/client.ts";
import {
  commandMenus,
  TelegramCommandMenu,
} from "../../src/telegram/commands.ts";

function fixture() {
  const deployment: Deployment = {
    version: 1,
    active: true,
    paused: false,
    model: "fake",
    webhookReady: true,
    ownerVerified: true,
    bot: { id: "999", username: "test_bot", visibleAll: true },
    credentials: { bot: "encrypted-credential" },
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let now = 1000;
  let onCall: () => void | Promise<void> = () => {};
  const client = {
    async call<T>(method: string, params = {}) {
      calls.push({ method, params });
      await onCall();
      return true as T;
    },
  } as Telegram;
  const menu = new TelegramCommandMenu(
    { deployment: async () => deployment } as Store,
    { client: async () => client } as SetupService,
    () => now,
  );
  const signal = new AbortController().signal;
  return {
    deployment,
    calls,
    menu,
    signal,
    advance: (ms: number) => {
      now += ms;
    },
    onCall: (fn: () => void | Promise<void>) => {
      onCall = fn;
    },
  };
}

test("private menus include /github linking; shared menus expose only usable group shortcuts", async () => {
  const f = fixture();
  await f.menu.sync(f.signal);
  expect(f.calls.map((c) => c.method)).toEqual([
    "setMyCommands",
    "setMyCommands",
    "setMyCommands",
  ]);
  for (const menu of commandMenus) {
    expect(menu.commands.some((c) => c?.command === "repos")).toBe(true);
    expect(menu.commands.some((c) => c?.command === "github")).toBe(
      menu.scope.type === "all_private_chats",
    );
    expect(
      menu.commands.every(
        (c) =>
          c && /^[a-z_]{1,32}$/.test(c.command) && c.description.length <= 256,
      ),
    ).toBe(true);
  }
  await f.menu.sync(f.signal);
  f.deployment.version++;
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(3);
});

test("activation and credential rotation control menu publication", async () => {
  const f = fixture();
  f.deployment.active = false;
  await f.menu.sync(f.signal);
  expect(f.calls).toEqual([]);
  f.deployment.active = true;
  f.deployment.paused = true;
  await f.menu.sync(f.signal);
  expect(f.calls).toEqual([]);
  f.deployment.paused = false;
  await f.menu.sync(f.signal);
  f.deployment.credentials.bot = "new-encrypted-credential";
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(6);
});

test("failed registrations retry after Telegram backoff without blocking the worker", async () => {
  const f = fixture();
  f.onCall(() => {
    throw new TelegramError("telegram_rate_limited", "retry", 120);
  });
  await expect(f.menu.sync(f.signal)).rejects.toThrow("telegram_rate_limited");
  f.onCall(() => {});
  f.advance(60000);
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(1);
  f.advance(60000);
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(4);
});

test("credential changes during publication stop old-client writes and retry the new identity", async () => {
  const f = fixture();
  f.onCall(() => {
    f.deployment.credentials.bot = "rotated";
  });
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(1);
  f.onCall(() => {});
  await f.menu.sync(f.signal);
  expect(f.calls).toHaveLength(4);
});

test("overlapping ticks and shutdown do not create duplicate menu writes", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<void>();
  f.onCall(() => pending.promise);
  const sync = f.menu.sync(f.signal);
  await Promise.resolve();
  await f.menu.sync(f.signal);
  pending.resolve();
  await sync;
  expect(f.calls).toHaveLength(3);
  const abort = new AbortController();
  abort.abort();
  f.deployment.credentials.bot = "rotated";
  await f.menu.sync(abort.signal);
  expect(f.calls).toHaveLength(3);
});
