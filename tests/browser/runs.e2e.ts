import { expect, type Page, type Route, test } from "@playwright/test";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const runId = "5f6f6dbf-25df-4a05-8d75-f2669c35572f";
const missingRunId = "93a458e2-f3a4-4b5b-8b21-51453078a7be";
const endpoint = `/api/admin/workspaces/${workspaceId}/runs`;
const listUrl = `/admin/threads?workspace=${workspaceId}&offset=100`;
const detailUrl = `/admin/runs/${runId}?workspace=${workspaceId}&offset=100`;
const run = {
  id: runId,
  actor: "101",
  status: "succeeded",
  at: "2026-09-28T10:00:25.000Z",
  model: "fixture-model",
  settingsVersion: 3,
  task: "Summarize this issue",
  result: "The fix is ready.",
  transcript: [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "search-1", name: "search" }],
    },
    {
      role: "toolResult",
      toolCallId: "search-1",
      toolName: "search",
      content: [{ type: "text", text: "Found the issue." }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The fix is ready." }],
    },
  ],
  instructions: [],
  skillPins: [],
  tools: { "search-1": { name: "search", state: "done" } },
  attempts: Array.from({ length: 6 }, (_, index) => ({
    id: `attempt-${index}`,
    at: "2026-09-28T10:00:25.000Z",
    status: "settled",
    reserved: 0.01,
    actual: 0.005,
    tokens: { input: 100, output: 25, cacheRead: 300, cacheWrite: 100 },
  })),
  deliveries: [{ state: "sent", at: "2026-09-28T10:00:32.000Z", attempts: 1 }],
};
const summary = {
  id: run.id,
  actor: run.actor,
  status: run.status,
  at: run.at,
  model: run.model,
  taskPreview: run.task,
  attemptCount: run.attempts.length,
  deliveryStates: ["sent"],
};

function statistic(page: Page, label: string) {
  return page
    .getByRole("region", { name: "Run statistics", exact: true })
    .locator("dl > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd > strong");
}

async function fixture(
  page: Page,
  mode: "member" | "operator",
  detail?: (route: Route) => Promise<void>,
  list?: (route: Route) => Promise<void>,
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === endpoint && list) {
      await list(route);
      return;
    }
    if (url.pathname === `${endpoint}/${runId}` && detail) {
      await detail(route);
      return;
    }
    if (url.pathname === `${endpoint}/${missingRunId}`) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    const json =
      url.pathname === "/api/setup/status"
        ? { initialized: true }
        : url.pathname === "/api/admin/auth/session"
          ? {
              admin: {
                id: "operator",
                username: "fixture",
                operator: true,
                ...(mode === "member" ? { telegramId: "101" } : {}),
              },
              csrf: "test",
            }
          : url.pathname === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Run fixture" }]
            : url.pathname === `/api/admin/workspaces/${workspaceId}/threads`
              ? { mode, total: 0, offset: 100, limit: 25, items: [] }
              : url.pathname === endpoint
                ? { mode, total: 101, offset: 100, limit: 25, items: [summary] }
                : url.pathname === `${endpoint}/${runId}`
                  ? { mode, run }
                  : {};
    await route.fulfill({ json });
  });
}

for (const [mode, width] of [
  ["member", 1280],
  ["operator", 390],
] as const) {
  test(`run details retain statistics and thread-list navigation for ${mode} at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, mode);
    await page.goto(detailUrl);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Run 5f6f6dbf" }),
    ).toBeVisible();
    const messages = page.getByRole("region", { name: "Messages" });
    await expect(statistic(page, "Messages")).toHaveText("4");
    await expect(statistic(page, "Tool calls")).toHaveText("1");
    await expect(statistic(page, "Model attempts")).toHaveText("6");
    await expect(statistic(page, "Total tokens")).toHaveText("3,150");
    await expect(statistic(page, "Cache hit rate")).toHaveText("60%");
    await expect(statistic(page, "Recorded spend")).toHaveText("$0.0300");
    await expect(messages.locator("ol > li")).toHaveCount(4);
    const statsBounds = await page
      .getByRole("region", { name: "Run statistics", exact: true })
      .boundingBox();
    const messagesBounds = await messages.boundingBox();
    expect(
      statsBounds &&
        messagesBounds &&
        statsBounds.y + statsBounds.height <= messagesBounds.y,
    ).toBe(true);
    await expect(messages).toContainText("Summarize this issue");
    await expect(messages).toContainText("The fix is ready.");
    if (width <= 800)
      await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(
      page.getByRole("link", { name: "Threads", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    if (width <= 800)
      await page.getByRole("button", { name: "Close Navigation" }).click();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(mode === "member" ? 1 : 0);
    await page.getByText("Versions, usage, checkpoints & delivery").click();
    await expect(
      page.getByRole("region", { name: "Run details", exact: true }),
    ).toContainText("Deliveries");
    await expect(page.locator(".run-attempt-step")).toHaveCount(6);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/run-detail-${mode}-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(messages).toContainText("The fix is ready.");
    await page.getByRole("link", { name: "Back to Threads" }).click();
    await expect(page).toHaveURL(listUrl);
    await page.goBack();
    await expect(messages).toContainText("The fix is ready.");
  });
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`run statistics distinguish missing, partial and zero usage at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      let value: Record<string, unknown> = {
        ...run,
        status: "running",
        attempts: [
          { id: "pending", at: run.at, reserved: 1, status: "reserved" },
        ],
      };
      await fixture(page, "operator", async (route) => {
        await route.fulfill({ json: { mode: "operator", run: value } });
      });
      await page.goto(detailUrl);
      const stats = page.getByRole("region", {
        name: "Run statistics",
        exact: true,
      });
      await expect(statistic(page, "Total tokens")).toHaveText("—");
      await expect(statistic(page, "Cache hit rate")).toHaveText("—");
      await expect(statistic(page, "Recorded spend")).toHaveText("—");
      await expect(stats).toContainText("Usage not reported");
      await expect(stats).toContainText("0 of 1 attempts reported");
      await page.screenshot({
        path: `test-results/run-statistics-pending-${width}-${theme}.png`,
        fullPage: true,
      });

      value = {
        ...run,
        status: "partial",
        attempts: [
          run.attempts[0],
          { id: "unknown", at: run.at, status: "unknown", reserved: 99 },
        ],
      };
      await page.reload();
      await expect(statistic(page, "Total tokens")).toHaveText("525");
      await expect(statistic(page, "Cache hit rate")).toHaveText("60%");
      await expect(statistic(page, "Recorded spend")).toHaveText("$0.0050");
      await expect(stats).toContainText("1 of 2 attempts reported");
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: `test-results/run-statistics-partial-${width}-${theme}.png`,
        fullPage: true,
      });

      value = {
        ...run,
        status: "queued",
        transcript: [],
        result: undefined,
        tools: {},
        attempts: [],
      };
      await page.reload();
      await expect(statistic(page, "Messages")).toHaveText("1");
      await expect(statistic(page, "Tool calls")).toHaveText("0");
      await expect(statistic(page, "Model attempts")).toHaveText("0");
      await expect(statistic(page, "Total tokens")).toHaveText("0");
      await expect(statistic(page, "Recorded spend")).toHaveText("$0.0000");
      await expect(statistic(page, "Cache hit rate")).toHaveText("—");
      await page.screenshot({
        path: `test-results/run-statistics-empty-${width}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}

for (const width of [1280, 390]) {
  test(`direct run detail visits show loading and recover from failed loads at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let held: Route | undefined;
    let fail = true;
    await fixture(page, "operator", async (route) => {
      if (fail) held = route;
      else await route.fulfill({ json: { mode: "operator", run } });
    });
    await page.goto(detailUrl);
    await expect.poll(() => !!held).toBe(true);
    const details = page.getByRole("region", {
      name: "Run details",
      exact: true,
    });
    await expect(details).toHaveAttribute("aria-busy", "true");
    const stats = page.getByRole("region", {
      name: "Run statistics",
      exact: true,
    });
    await expect(stats).toHaveAttribute("aria-busy", "true");
    await expect(stats.locator("dt")).toHaveText([
      "Messages",
      "Tool calls",
      "Model attempts",
      "Total tokens",
      "Cache hit rate",
      "Recorded spend",
    ]);
    await expect(stats.locator(".skeleton")).toHaveCount(6);
    await page.screenshot({
      path: `test-results/run-statistics-loading-${width}.png`,
      fullPage: true,
    });
    await expect(
      page.getByRole("heading", { name: "Run 5f6f6dbf" }),
    ).toBeVisible();
    await held?.fulfill({
      status: 503,
      json: { error: "temporarily_unavailable" },
    });
    await expect(page.getByRole("alert")).toContainText(
      "temporarily_unavailable",
    );
    await expect(stats).toHaveAttribute("aria-busy", "false");
    await expect(statistic(page, "Messages")).toHaveText("—");
    await expect(statistic(page, "Total tokens")).toHaveText("—");
    await expect(statistic(page, "Recorded spend")).toHaveText("—");
    await page.screenshot({
      path: `test-results/run-statistics-error-${width}.png`,
      fullPage: true,
    });
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("region", { name: "Messages" })).toContainText(
      "The fix is ready.",
    );
    await expect(details).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("a missing run shows a recoverable error without a previous run's messages", async ({
  page,
}) => {
  await fixture(page, "operator");
  await page.goto(detailUrl);
  await expect(page.getByRole("region", { name: "Messages" })).toContainText(
    "The fix is ready.",
  );
  // Stay in the same router instance to check that switching IDs discards old data.
  await page.evaluate((href) => {
    window.history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/admin/runs/${missingRunId}?workspace=${workspaceId}&offset=100`);
  await expect(page.getByRole("alert")).toContainText(
    "This run is unavailable in this workspace",
  );
  await expect(page.getByRole("region", { name: "Messages" })).toHaveCount(0);
  await expect(statistic(page, "Messages")).toHaveText("—");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Threads" }).click();
  await expect(page).toHaveURL(listUrl);
});
