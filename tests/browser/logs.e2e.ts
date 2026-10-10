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

async function expectPagerBelow(page: Page, width: number) {
  const card = page.getByRole("region", {
    name: "Runtime log entries",
    exact: true,
  });
  const pager = page.getByRole("navigation", { name: "Pagination" });
  const cardBounds = await card.boundingBox();
  const pagerBounds = await pager.boundingBox();
  if (!cardBounds || !pagerBounds)
    throw Error("Logs and pagination must be visible.");
  expect(pagerBounds.y).toBeGreaterThanOrEqual(
    cardBounds.y + cardBounds.height,
  );
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
  test(`logs share run pagination, revisit cursors and reset filters at ${width}px`, async ({
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
    await page.getByLabel("Auto-refresh every 5 seconds").uncheck();
    const pager = page.getByRole("navigation", { name: "Pagination" });
    const previous = pager.getByRole("button", { name: "Previous page" });
    const next = pager.getByRole("button", { name: "Next page" });
    await expect(pager).toContainText("1–50 · Page 1");
    await expect(previous).toBeDisabled();
    await expect(page.locator(".log-table")).toHaveCSS("font-size", "12px");
    await expect(pager).toHaveCSS("font-size", "12px");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expectPagerBelow(page, width);
      await page.screenshot({
        path: `test-results/logs-populated-${theme}-${width}.png`,
        fullPage: true,
      });
    }
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(pager).toContainText("51–100 · Page 2");
    await expect(page.getByText("run_started_1", { exact: true })).toHaveCount(
      0,
    );
    await next.click();
    await expect(pager).toContainText("101–120 · Page 3");
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(pager).toContainText("51–100 · Page 2");
    expect(requests.at(-1)?.get("before")).toBe("cursor-50");
    await previous.click();
    await expect(pager).toContainText("1–50 · Page 1");
    expect(requests.at(-1)?.has("before")).toBe(false);
    await next.click();
    await expect(pager).toContainText("51–100 · Page 2");
    await chooseOption(
      page.getByRole("combobox", { name: "Log level", exact: true }),
      "warn",
    );
    await expect(pager).toContainText("1–50 · Page 1");
    expect(requests.at(-1)?.get("level")).toBe("warn");
    expect(requests.at(-1)?.has("before")).toBe(false);
    await next.click();
    await expect(pager).toContainText("51–100 · Page 2");
    await chooseOption(
      page.getByRole("combobox", { name: "Service", exact: true }),
      "worker",
    );
    await expect(pager).toContainText("1–50 · Page 1");
    expect(requests.at(-1)?.get("service")).toBe("worker");
    await next.click();
    await expect(pager).toContainText("51–100 · Page 2");
    await page
      .getByLabel("Search event, error code or run ID")
      .fill("run_started");
    await page
      .getByRole("button", { name: "Search logs", exact: true })
      .click();
    await expect(pager).toContainText("1–50 · Page 1");
    expect(requests.at(-1)?.get("q")).toBe("run_started");
    await next.click();
    await expect(pager).toContainText("51–100 · Page 2");
    await page
      .getByRole("button", { name: "Latest logs", exact: true })
      .click();
    await expect(pager).toContainText("1–50 · Page 1");
    await expect(previous).toBeDisabled();
  });

  test(`logs keep pagination usable through loading, failure and empty pages at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
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
    await expectPagerBelow(page, width);
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
    await expectPagerBelow(page, width);
    await page.screenshot({
      path: `test-results/logs-error-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Retry loading logs" }).click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: logPage() });
    await expect(pager).toContainText("1–50 · Page 1");
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
    await expectPagerBelow(page, width);
    await previous.click();
    await expect.poll(() => held.length).toBe(1);
    expect(
      new URL(held[0]?.request().url() ?? "").searchParams.has("before"),
    ).toBe(false);
    await held.shift()?.fulfill({ json: logPage() });
    await expect(pager).toContainText("1–50 · Page 1");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await next.click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { ...logPage(120), items: [] } });
    await expect(pager).toContainText("No events · Page 2");
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await expect(page.getByText(/No logs on this page/)).toBeVisible();
    await expectPagerBelow(page, width);
    await page.screenshot({
      path: `test-results/logs-empty-${width}.png`,
      fullPage: true,
    });
    await previous.click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: logPage(120) });
    await expect(pager).toContainText("No events · Page 1");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await expect(page.getByText(/No logs match these filters/)).toBeVisible();
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
  await expect(pager).toContainText("1–50 · Page 1");
  await page.clock.fastForward(5000);
  await expect.poll(() => cursors.length).toBe(2);
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("51–100 · Page 2");
  await expect(
    page.getByRole("status").filter({ hasText: "automatic refresh is paused" }),
  ).toBeVisible();
  await page.clock.fastForward(15000);
  expect(cursors).toEqual([null, null, "cursor-50"]);
  await pager.getByRole("button", { name: "Previous page" }).click();
  await expect(pager).toContainText("1–50 · Page 1");
  await page.clock.fastForward(5000);
  await expect.poll(() => cursors.length).toBe(5);
  expect(cursors.at(-1)).toBeNull();
});
