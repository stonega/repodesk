import { expect, type Page, type Route, test } from "@playwright/test";
import { chooseOption } from "./dropdown-helpers.ts";

const endpoint = "/api/admin/operator/logs";
const entries = Array.from({ length: 120 }, (_, index) => ({
  id: `event-${index}`,
  at: new Date(Date.UTC(2026, 9, 10, 12, 0, 120 - index)).toISOString(),
  level: "info",
  service: "worker",
  event: `run_started_${index + 1}`,
  message: "An assistant run started.",
  run_id: "5b670d0a-3b83-4d00-ab6a-9acbf702ac2b",
}));

function logPage(offset = 0) {
  return {
    items: entries.slice(offset, offset + 50),
    ...(offset + 50 < entries.length
      ? { nextBefore: `cursor-${offset + 50}` }
      : {}),
    retentionDays: 7,
    maxEntries: 10000,
  };
}

async function fixture(page: Page, logs: (route: Route) => Promise<void>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      await logs(route);
      return;
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: "workspace", name: "Logs fixture" }]
            : {};
    await route.fulfill({ json });
  });
}

async function chooseRefresh(page: Page, label: string) {
  await page.getByRole("button", { name: "Auto-refresh", exact: true }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function expectPagerInside(page: Page, width: number) {
  const card = page.getByRole("region", {
    name: "Runtime log entries",
    exact: true,
  });
  const pager = page.getByRole("navigation", { name: "Pagination" });
  const cardBounds = await card.boundingBox();
  const pagerBounds = await pager.boundingBox();
  if (!cardBounds || !pagerBounds)
    throw Error("Logs and pagination must be visible.");
  await expect(
    card.getByRole("navigation", { name: "Pagination" }),
  ).toHaveCount(1);
  expect(pagerBounds.y).toBeGreaterThan(cardBounds.y);
  expect(pagerBounds.y + pagerBounds.height).toBeLessThanOrEqual(
    cardBounds.y + cardBounds.height,
  );
  const content = card
    .locator(".log-table-scroll, .skeleton-rows, > p")
    .first();
  if (await content.count()) {
    const bounds = await content.boundingBox();
    if (!bounds) throw Error("Log content must be visible.");
    expect(pagerBounds.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  }
  expect(pagerBounds.x).toBeGreaterThanOrEqual(0);
  expect(pagerBounds.x + pagerBounds.width).toBeLessThanOrEqual(width);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  const toast = page.getByRole("region", { name: "Notification", exact: true });
  if (await toast.count()) {
    const bounds = await toast.boundingBox();
    if (!bounds) throw Error("The error notification must be visible.");
    expect(
      bounds.x < pagerBounds.x + pagerBounds.width &&
        bounds.x + bounds.width > pagerBounds.x &&
        bounds.y < pagerBounds.y + pagerBounds.height &&
        bounds.y + bounds.height > pagerBounds.y,
    ).toBe(false);
  }
  for (const label of ["Previous page", "Next page"]) {
    const button = pager.getByRole("button", { name: label });
    const bounds = await button.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [1280, 390]) {
  test(`logs keep compact pagination inside the card, revisit cursors and reset filters at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: URLSearchParams[] = [];
    await fixture(page, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(params);
      expect(params.get("limit")).toBe("50");
      const offset = Number(params.get("before")?.replace("cursor-", "") ?? 0);
      await route.fulfill({ json: logPage(offset) });
    });
    await page.goto("/admin/logs");
    await chooseRefresh(page, "Off");
    const pager = page.getByRole("navigation", { name: "Pagination" });
    const previous = pager.getByRole("button", { name: "Previous page" });
    const next = pager.getByRole("button", { name: "Next page" });
    await expect(pager).toContainText("1–50");
    await expect(previous).toBeDisabled();
    await expect(page.locator(".log-table")).toHaveCSS("font-size", "12px");
    await expect(pager).toHaveCSS("font-size", "14px");
    await expect(pager).not.toContainText("Page");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expectPagerInside(page, width);
      await page.screenshot({
        path: `test-results/logs-populated-${theme}-${width}.png`,
        fullPage: true,
      });
    }
    const scroll = page.getByRole("region", {
      name: "Runtime events table",
      exact: true,
    });
    await scroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expectPagerInside(page, width);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(pager).toContainText("51–100");
    await expect(page.getByText("run_started_1", { exact: true })).toHaveCount(
      0,
    );
    await next.click();
    await expect(pager).toContainText("101–120");
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(pager).toContainText("51–100");
    expect(requests.at(-1)?.get("before")).toBe("cursor-50");
    await previous.click();
    await expect(pager).toContainText("1–50");
    expect(requests.at(-1)?.has("before")).toBe(false);
    await next.click();
    await expect(pager).toContainText("51–100");
    await chooseOption(
      page.getByRole("combobox", { name: "Log level", exact: true }),
      "warn",
    );
    await expect(pager).toContainText("1–50");
    expect(requests.at(-1)?.get("level")).toBe("warn");
    expect(requests.at(-1)?.has("before")).toBe(false);
    await next.click();
    await expect(pager).toContainText("51–100");
    await chooseOption(
      page.getByRole("combobox", { name: "Service", exact: true }),
      "worker",
    );
    await expect(pager).toContainText("1–50");
    expect(requests.at(-1)?.get("service")).toBe("worker");
    await next.click();
    await expect(pager).toContainText("51–100");
    await page
      .getByLabel("Search event, error code or run ID")
      .fill("run_started");
    await page
      .getByRole("button", { name: "Search logs", exact: true })
      .click();
    await expect(pager).toContainText("1–50");
    expect(requests.at(-1)?.get("q")).toBe("run_started");
    await next.click();
    await expect(pager).toContainText("51–100");
    await page
      .getByRole("button", { name: "Latest logs", exact: true })
      .click();
    await expect(pager).toContainText("1–50");
    await expect(previous).toBeDisabled();
  });

  test(`logs keep pagination usable through loading, failure and empty pages at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date("2026-10-10T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-10T12:00:01Z"));
    const held: Route[] = [];
    await fixture(page, async (route) => {
      held.push(route);
    });
    await page.goto("/admin/logs");
    const pager = page.getByRole("navigation", { name: "Pagination" });
    const card = page.getByRole("region", {
      name: "Runtime log entries",
      exact: true,
    });
    const previous = pager.getByRole("button", { name: "Previous page" });
    const next = pager.getByRole("button", { name: "Next page" });
    await expect.poll(() => held.length).toBe(1);
    await expect(card).toHaveAttribute("aria-busy", "true");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await expectPagerInside(page, width);
    await page.clock.fastForward(600000);
    expect(held).toHaveLength(1);
    await page
      .getByRole("button", { name: "Auto-refresh", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Refresh now" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: `test-results/logs-loading-${width}.png`,
      fullPage: true,
    });
    await held.shift()?.fulfill({
      status: 503,
      json: { error: "logs_temporarily_unavailable" },
    });
    await expect(page.getByRole("alert")).toContainText(
      "logs_temporarily_unavailable",
    );
    await expect(pager).toContainText("Page unavailable");
    await expect(next).toBeDisabled();
    await expectPagerInside(page, width);
    await page.screenshot({
      path: `test-results/logs-error-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Retry loading logs" }).click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: logPage() });
    await expect(pager).toContainText("1–50");
    await next.click();
    await expect.poll(() => held.length).toBe(1);
    await expect(page.locator(".log-table")).toHaveCount(0);
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await held.shift()?.fulfill({
      status: 503,
      json: { error: "logs_temporarily_unavailable" },
    });
    await expect(pager).toContainText("Page unavailable");
    await expect(previous).toBeEnabled();
    await expectPagerInside(page, width);
    await previous.click();
    await expect.poll(() => held.length).toBe(1);
    expect(
      new URL(held[0]?.request().url() ?? "").searchParams.has("before"),
    ).toBe(false);
    await held.shift()?.fulfill({ json: logPage() });
    await expect(pager).toContainText("1–50");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await next.click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { ...logPage(120), items: [] } });
    await expect(pager).toContainText("No events");
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await expect(page.getByText(/No logs on this page/)).toBeVisible();
    await expectPagerInside(page, width);
    await page.screenshot({
      path: `test-results/logs-empty-${width}.png`,
      fullPage: true,
    });
    await previous.click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: logPage(120) });
    await expect(pager).toContainText("No events");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await expect(page.getByText(/No logs match these filters/)).toBeVisible();
  });

  test(`logs refresh menu matches the reference and supports keyboard dismissal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, async (route) => {
      await route.fulfill({ json: logPage(100) });
    });
    await page.goto("/admin/logs");
    const trigger = page.getByRole("button", {
      name: "Auto-refresh",
      exact: true,
    });
    await expect(trigger).toHaveText("Auto-refresh: 1m");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const selected = page.getByRole("menuitemradio", {
      name: "Every minute",
      exact: true,
    });
    await expect(selected).toHaveAttribute("aria-checked", "true");
    await expect(selected).toBeFocused();
    await expect(page.getByRole("menuitemradio")).toHaveText([
      "Every 10 seconds",
      "Every 30 seconds",
      "Every minute",
      "Every 5 minutes",
      "Off",
    ]);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const menu = page.getByRole("menu");
      const bounds = await menu.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
        width,
      );
      expect(bounds?.y).toBeGreaterThanOrEqual(0);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(900);
      await expect(
        page.getByRole("menuitemradio", { name: "Every 10 seconds" }),
      ).toBeInViewport();
      await expect(
        page.getByRole("menuitem", { name: "Refresh now" }),
      ).toBeInViewport();
      await page.screenshot({
        path: `test-results/logs-refresh-menu-${theme}-${width}.png`,
        fullPage: true,
      });
    }
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Every 5 minutes" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveText("Auto-refresh: 5m");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await trigger.click();
    await page.getByRole("heading", { name: "Runtime logs" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await trigger.click();
    await page.keyboard.press("Home");
    await expect(
      page.getByRole("menuitemradio", { name: "Every 10 seconds" }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: "Refresh now" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Latest logs" }),
    ).toBeFocused();
  });
}

test("log pagination pauses automatic updates on older pages and resumes on the latest page", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-10T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-10T12:00:01Z"));
  const cursors: (string | null)[] = [];
  await fixture(page, async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    cursors.push(before);
    await route.fulfill({ json: logPage(before ? 50 : 0) });
  });
  await page.goto("/admin/logs");
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("1–50");
  await page.clock.fastForward(60000);
  await expect.poll(() => cursors.length).toBe(2);
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("51–100");
  await expect(
    page.getByRole("status").filter({ hasText: "automatic refresh is paused" }),
  ).toBeVisible();
  await page.clock.fastForward(180000);
  expect(cursors).toEqual([null, null, "cursor-50"]);
  await pager.getByRole("button", { name: "Previous page" }).click();
  await expect(pager).toContainText("1–50");
  await page.clock.fastForward(60000);
  await expect.poll(() => cursors.length).toBe(5);
  expect(cursors.at(-1)).toBeNull();
});

test("log refresh intervals replace timers, Off stops polling and Refresh now retains the current page", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-10T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-10T12:00:01Z"));
  const cursors: (string | null)[] = [];
  await fixture(page, async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    cursors.push(before);
    await route.fulfill({ json: logPage(before ? 50 : 0) });
  });
  await page.goto("/admin/logs");
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("1–50");
  for (const [label, interval] of [
    ["Every 10 seconds", 10000],
    ["Every 30 seconds", 30000],
    ["Every minute", 60000],
    ["Every 5 minutes", 300000],
  ] as const) {
    await chooseRefresh(page, label);
    const count = cursors.length;
    await page.clock.runFor(interval - 1);
    expect(cursors).toHaveLength(count);
    await page.clock.runFor(1);
    await expect.poll(() => cursors.length).toBe(count + 1);
    await expect(pager.locator("[aria-live]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  await chooseRefresh(page, "Off");
  const count = cursors.length;
  await page.clock.fastForward(600000);
  expect(cursors).toHaveLength(count);
  await page.getByRole("button", { name: "Auto-refresh", exact: true }).click();
  await page.getByRole("menuitem", { name: "Refresh now" }).click();
  await expect.poll(() => cursors.length).toBe(count + 1);
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("51–100");
  await chooseRefresh(page, "Every 10 seconds");
  const olderCount = cursors.length;
  await page.clock.fastForward(30000);
  expect(cursors).toHaveLength(olderCount);
  await page.getByRole("button", { name: "Auto-refresh", exact: true }).click();
  await page.getByRole("menuitem", { name: "Refresh now" }).click();
  await expect.poll(() => cursors.length).toBe(olderCount + 1);
  expect(cursors.at(-1)).toBe("cursor-50");
  await expect(pager).toContainText("51–100");
});
