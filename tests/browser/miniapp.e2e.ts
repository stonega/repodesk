import { expect, type Page, test } from "@playwright/test";
import type { HistoryItem, TaskHistory } from "../../src/miniapp/history.ts";

const reference =
  "task_6bbd1001b0e047cb8552ddc40a099b0d_6bbd1002b0e047cb8552ddc40a099b0d";
function message(i: number): HistoryItem {
  return {
    id: `native-${String(i).padStart(3, "0")}`,
    at: new Date(Date.UTC(2026, 9, 18, 1, i)).toISOString(),
    role: i % 4 === 0 ? "user" : "codex",
    text: `Conversation message ${i}.\n\n${"A readable account of the repository investigation and verification. ".repeat(3)}`,
  };
}
async function fixture(
  page: Page,
  initial = Array.from({ length: 25 }, (_, i) => message(i)),
) {
  let items = initial,
    status = 200,
    hasOlder = true,
    delay = 0;
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<() => void>>();
    const webApp = {
      initData: "fixture-signed-launch",
      initDataUnsafe: {},
      colorScheme: "light",
      themeParams: { bg_color: "#ffffff", text_color: "#17212b" },
      viewportStableHeight: window.innerHeight,
      isActive: true,
      safeAreaInset: { top: 0, bottom: 20, left: 0, right: 0 },
      contentSafeAreaInset: { top: 10, bottom: 0, left: 0, right: 0 },
      ready: () => {},
      expand: () => {},
      BackButton: { hide: () => {} },
      MainButton: { hide: () => {} },
      onEvent: (event: string, handler: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(handler);
      },
      offEvent: (event: string, handler: () => void) =>
        listeners.get(event)?.delete(handler),
    };
    Object.assign(window, {
      Telegram: { WebApp: webApp },
      miniEvent: (name: string) => {
        for (const handler of listeners.get(name) ?? []) handler();
      },
    });
  });
  await page.route("**/mini-api/history", async (route) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (status !== 200)
      return route.fulfill({
        status,
        json: {
          error: status === 403 ? "access_denied" : "service_unavailable",
        },
      });
    const body = route.request().postDataJSON();
    const older = body.before;
    const selected = older
      ? [message(-2), message(-1)]
      : body.after
        ? items.filter((i) => i.id > body.after)
        : items;
    const result: TaskHistory = {
      task: {
        title: "Fix repository pagination",
        repository: "example/workspace",
        status: "Implementing",
        state: "working",
      },
      items: selected,
      before: older ? "oldest" : items[0]?.id,
      after: selected.at(-1)?.id ?? body.after,
      hasMore: older ? false : body.after ? false : hasOlder,
      recordingAvailable: true,
    };
    return route.fulfill({ json: result });
  });
  return {
    delay: (ms: number) => {
      delay = ms;
    },
    open: () => page.goto(`/mini?tgWebAppStartParam=${reference}`),
    append: (item: HistoryItem) => {
      items = [...items, item];
    },
    deny: () => {
      status = 403;
    },
    fail: () => {
      status = 503;
    },
    empty: () => {
      items = [];
      hasOlder = false;
    },
  };
}
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  test(`native theme, safe areas and readable transcript at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const f = await fixture(page, [
      message(0),
      {
        ...message(1),
        text: "Checking the code.\n\n```ts\nconst title = '<script>unsafe()</script>';\n```\n\n[unsafe](javascript:alert(1))",
      },
      {
        ...message(2),
        role: "activity",
        title: "Command · completed",
        text: "bun test\n12 tests passed",
      },
    ]);
    await f.open();
    await expect(
      page.getByRole("heading", { name: "Fix repository pagination" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/miniapp-${viewport.width}-light.png`,
    });
    await expect(
      page.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "const title",
    );
    expect(await page.locator(".mini-markdown a").count()).toBe(0);
    await page.getByText("Command · completed", { exact: true }).click();
    await expect(
      page.getByText("12 tests passed", { exact: false }),
    ).toBeVisible();
    const shell = page.locator(".mini-shell");
    expect(
      await shell.evaluate((e) =>
        Number.parseFloat(getComputedStyle(e).paddingTop),
      ),
    ).toBe(26);
    expect(
      await shell.evaluate((e) =>
        Number.parseFloat(getComputedStyle(e).paddingBottom),
      ),
    ).toBe(28);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      const target = window as unknown as {
        Telegram: {
          WebApp: { colorScheme: string; themeParams: Record<string, string> };
        };
        miniEvent: (event: string) => void;
      };
      target.Telegram.WebApp.colorScheme = "dark";
      target.Telegram.WebApp.themeParams = {
        bg_color: "#17212b",
        text_color: "#ffffff",
      };
      target.miniEvent("themeChanged");
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page
        .locator("html")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ).toBe("rgb(23, 33, 43)");
    await page.screenshot({
      path: `test-results/miniapp-${viewport.width}-dark.png`,
    });
  });
}
test("reading older messages preserves position through pagination and new messages; returning to the task catches up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await f.open();
  const timeline = page.getByRole("region", { name: "Task messages" });
  await expect(page.locator(".mini-message")).toHaveCount(25);
  await timeline.evaluate((e) => {
    e.scrollTop = 0;
    e.dispatchEvent(new Event("scroll"));
  });
  const anchor = page.locator('[data-message-id="native-000"]');
  const before = await anchor.boundingBox();
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(page.locator(".mini-message")).toHaveCount(27);
  const after = await anchor.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
  const scrollTop = await timeline.evaluate((e) => e.scrollTop);
  f.append(message(25));
  await page.evaluate(() => {
    (window as unknown as { miniEvent: (event: string) => void }).miniEvent(
      "activated",
    );
  });
  await expect(
    page.getByRole("button", { name: "New messages ↓" }),
  ).toBeVisible();
  expect(
    Math.abs((await timeline.evaluate((e) => e.scrollTop)) - scrollTop),
  ).toBeLessThan(2);
  await expect(page.locator('[data-message-id="native-025"]')).toHaveCount(1);
  await page.getByRole("button", { name: "New messages ↓" }).click();
  await expect(page.locator('[data-message-id="native-025"]')).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "New messages ↓" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-message-id="native-025"]')).toBeInViewport();
});
test("revoked access removes already displayed content; temporary errors keep history readable", async ({
  page,
}) => {
  const f = await fixture(page, [message(1)]);
  await f.open();
  await expect(page.locator(".mini-message")).toHaveCount(1);
  f.fail();
  await page.evaluate(() => {
    (window as unknown as { miniEvent: (event: string) => void }).miniEvent(
      "activated",
    );
  });
  await expect(page.getByRole("alert")).toContainText("Retrying");
  await expect(page.locator(".mini-message")).toHaveCount(1);
  f.deny();
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByRole("alert")).toContainText("no longer have access");
  await expect(page.locator(".mini-message")).toHaveCount(0);
});
test("empty and loading states remain readable and a direct browser visit explains how to open the task", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  f.delay(600);
  f.empty();
  await f.open();
  await expect(page.getByRole("status")).toContainText("Loading conversation");
  await page.screenshot({ path: "test-results/miniapp-loading.png" });
  await expect(
    page.getByText("No messages yet.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/miniapp-empty.png" });
  await page.goto("/mini");
  await expect(page.getByRole("alert")).toContainText(
    "Open this conversation from its Telegram task message",
  );
  await page.screenshot({ path: "test-results/miniapp-open-error.png" });
});
