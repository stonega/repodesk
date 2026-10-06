import { expect, type Page, type Route, test } from "@playwright/test";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const runId = "5f6f6dbf-25df-4a05-8d75-f2669c35572f";
const missingRunId = "93a458e2-f3a4-4b5b-8b21-51453078a7be";
const endpoint = `/api/admin/workspaces/${workspaceId}/runs`;
const listUrl = `/admin/runs?workspace=${workspaceId}&offset=100`;
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
      content: [{ type: "text", text: "The fix is ready." }],
    },
  ],
  instructions: [],
  skillPins: [],
  attempts: Array.from({ length: 6 }, (_, index) => ({
    id: `attempt-${index}`,
    at: "2026-09-28T10:00:25.000Z",
    status: "settled",
    reserved: 0.01,
    actual: 0.005,
  })),
  deliveries: [{ state: "sent", at: "2026-09-28T10:00:32.000Z", attempts: 1 }],
};

async function fixture(
  page: Page,
  mode: "member" | "operator",
  detail?: (route: Route) => Promise<void>,
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
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
            : url.pathname === endpoint
              ? { mode, total: 101, items: [run] }
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
  test(`run summaries link to reloadable detail pages for ${mode} at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, mode);
    await page.goto(listUrl);
    const card = page.locator(".run-card");
    await expect(card).toHaveAttribute("href", detailUrl);
    await expect(card.locator(".run-card-line")).toHaveCount(2);
    await expect(page.getByText("The fix is ready.")).toHaveCount(0);
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Run 5f6f6dbf" }),
    ).toBeVisible();
    const messages = page.getByRole("region", { name: "Messages" });
    await expect(messages).toContainText("Summarize this issue");
    await expect(messages).toContainText("The fix is ready.");
    await expect(
      page.getByRole("link", { name: "Runs", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(mode === "member" ? 1 : 0);
    await page.getByText("Versions, usage, checkpoints & delivery").click();
    await expect(
      page.getByRole("region", { name: "Run details", exact: true }),
    ).toContainText("Deliveries");
    await expect(page.locator(".run-attempt-step")).toHaveCount(6);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: `test-results/run-detail-${mode}-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(messages).toContainText("The fix is ready.");
    await page.getByRole("link", { name: "Back to Runs" }).click();
    await expect(page).toHaveURL(listUrl);
    await page.goBack();
    await expect(messages).toContainText("The fix is ready.");
    await page.goBack();
    await expect(page).toHaveURL(listUrl);
  });
}

test("direct run detail visits show loading and recover from failed loads", async ({
  page,
}) => {
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
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Messages" })).toContainText(
    "The fix is ready.",
  );
  await expect(details).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

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
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Runs" }).click();
  await expect(page).toHaveURL(listUrl);
});
