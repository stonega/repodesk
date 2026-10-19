import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";

const first = "b6e6d846-06b0-46ee-ac0c-47b617d17dcc";
const second = "48cfa12b-ae0b-4eb0-a8ee-b5cc10eb89ae";
const result = {
  reply:
    "Your worker is offline. Check the worker service in Operations, then run another self-check.",
  checkedAt: "2026-10-19T08:00:00.000Z",
  checks: [
    {
      name: "Worker",
      status: "warning",
      detail:
        "No recent worker heartbeat. Ask the operator to check the worker service.",
      path: "/admin/operations",
    },
    {
      name: "Chat model",
      status: "pass",
      detail: "A chat model is configured. Provider access was not tested.",
      path: "/admin/model",
    },
  ],
};
async function fixture(page: Page) {
  const requests: Route[] = [];
  let signedOut = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/self-check")) {
      requests.push(route);
      return;
    }
    if (path.endsWith("/logout")) signedOut = true;
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "Admin", operator: true },
                csrf: "fixture-csrf",
              }
            : path === "/api/admin/workspaces"
              ? [
                  { id: first, name: "Acme team" },
                  { id: second, name: "Other team" },
                ]
              : path.endsWith("/overview")
                ? {
                    version: 1,
                    settings: settingsSchema.parse({
                      name: "Acme team",
                      timezone: "Asia/Taipei",
                    }),
                    counts: {
                      members: 2,
                      runs: 0,
                      threads: 0,
                      workflows: 0,
                      codingTasks: 0,
                    },
                    connections: {
                      bot: { configured: true, username: "fixture_bot" },
                      github: { connected: false, repositories: 0 },
                    },
                  }
                : path.endsWith("/threads")
                  ? { items: [], total: 0, offset: 0, limit: 25 }
                  : {},
    });
  });
  await page.goto(`/admin/overview?workspace=${first}`);
  await expect(
    page.getByRole("button", { name: "Open self-check assistant" }),
  ).toBeVisible();
  return { requests, signedOut: () => signedOut };
}
const popup = (page: Page) =>
  page.getByRole("dialog", { name: "Self-check assistant" });
async function shot(page: Page, name: string) {
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
  });
}
for (const width of [1280, 390]) {
  test(`self-check supports conversation, findings, minimize and keyboard at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const { requests } = await fixture(page);
    const launcher = page.getByRole("button", {
      name: "Open self-check assistant",
    });
    const bounds = await launcher.boundingBox();
    expect(bounds?.x).toBeGreaterThan(width - 100);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await launcher.hover();
    await expect(launcher).toHaveCSS("background-color", "rgb(16, 91, 147)");
    await launcher.click();
    await expect(popup(page)).toBeVisible();
    await expect(popup(page)).toContainText("Acme team");
    await expect(page.getByLabel("Ask about your setup")).toBeFocused();
    await expect(popup(page).locator("input, select")).toHaveCount(0);
    await shot(page, "empty");
    await popup(page)
      .getByRole("button", { name: "Run self-check", exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(1);
    const request = requests.shift();
    expect(request?.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
    expect(request?.request().postDataJSON().history).toEqual([]);
    await expect(popup(page).getByRole("status")).toContainText(
      "Checking your workspace",
    );
    await expect(
      popup(page).getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await shot(page, "pending");
    await popup(page)
      .getByRole("button", { name: "Close Self-check assistant" })
      .click();
    await expect(popup(page)).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await request?.fulfill({ json: result });
    await launcher.click();
    await expect(popup(page)).toContainText(result.reply);
    await popup(page)
      .getByText("1 check needs attention · View findings")
      .click();
    await expect(popup(page)).toContainText("No recent worker heartbeat");
    await shot(page, "findings-light");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await shot(page, "findings-dark");
    const dialogBounds = await popup(page).boundingBox();
    expect(dialogBounds?.x).toBeGreaterThanOrEqual(0);
    expect(
      (dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0),
    ).toBeLessThanOrEqual(width);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.getByLabel("Ask about your setup").fill("How can I restart it?");
    await page.keyboard.press("Enter");
    await expect.poll(() => requests.length).toBe(1);
    const followup = requests.shift();
    expect(followup?.request().postDataJSON().history).toEqual([
      {
        role: "user",
        content: "Run a self-check and explain anything that needs attention.",
      },
      { role: "assistant", content: result.reply },
    ]);
    await followup?.fulfill({
      json: {
        ...result,
        reply: "Ask your deployment operator to restart the worker service.",
      },
    });
    await expect(popup(page)).toContainText("restart the worker service");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await launcher.click();
    await expect(popup(page)).toContainText("restart the worker service");
  });

  test(`self-check preserves failed messages and supports retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const { requests } = await fixture(page);
    await page
      .getByRole("button", { name: "Open self-check assistant" })
      .click();
    await page
      .getByLabel("Ask about your setup")
      .fill("Why isn't the bot replying?");
    await page.keyboard.press("Enter");
    await expect.poll(() => requests.length).toBe(1);
    await requests
      .shift()
      ?.fulfill({ status: 503, json: { error: "service_unavailable" } });
    await expect(page.getByRole("alert")).toContainText(
      "Couldn't complete the check",
    );
    await expect(popup(page)).toContainText("Why isn't the bot replying?");
    await expect(page.getByLabel("Ask about your setup")).toBeEnabled();
    await shot(page, "error");
    await popup(page).getByRole("button", { name: "Retry message" }).click();
    await expect.poll(() => requests.length).toBe(1);
    const retry = requests.shift();
    expect(retry?.request().postDataJSON().message).toBe(
      "Why isn't the bot replying?",
    );
    expect(retry?.request().postDataJSON().history).toEqual([]);
    await retry?.fulfill({
      json: {
        ...result,
        note: "The chat model could not respond. Basic checks still completed.",
      },
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(popup(page)).toContainText("Basic checks still completed");
    await expect(
      popup(page).getByRole("article", { name: "You", exact: true }),
    ).toHaveCount(1);
    await shot(page, "fallback");
  });
}

test("switching workspaces discards the conversation and aborts stale requests", async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.getByRole("button", { name: "Open self-check assistant" }).click();
  await page.getByLabel("Ask about your setup").fill("Private admin question");
  await page.keyboard.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  // The chat is non-modal: the workspace selector remains available.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Other team" }).click();
  await expect(popup(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open self-check assistant" }).click();
  await expect(popup(page)).toContainText("Other team");
  await expect(popup(page)).not.toContainText("Private admin question");
  await expect(
    popup(page).getByRole("button", { name: "Run self-check", exact: true }),
  ).toBeVisible();
  await requests
    .shift()
    ?.fulfill({ json: result })
    .catch(() => {});
  await expect(popup(page)).not.toContainText(result.reply);
});

test("self-check stays inside a compact viewport and never appears on sign-in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await fixture(page);
  await page.getByRole("button", { name: "Open self-check assistant" }).click();
  await expect(page.getByLabel("Ask about your setup")).toBeInViewport();
  await expect(
    popup(page).getByRole("button", { name: "Close Self-check assistant" }),
  ).toBeInViewport();
  await shot(page, "compact");
  await popup(page)
    .getByRole("button", { name: "Close Self-check assistant" })
    .click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open self-check assistant" }),
  ).toHaveCount(0);
});
