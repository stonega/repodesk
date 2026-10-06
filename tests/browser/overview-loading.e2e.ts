import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/overview`;

async function fixture(page: Page, operator = true) {
  const held: Route[] = [];
  const data = {
    version: 3,
    settings: settingsSchema.parse({
      name: "Overview fixture",
      timezone: "Asia/Taipei",
    }),
    counts: {
      members: 8,
      runs: 12,
      workflows: 2,
      ...(operator ? { codingTasks: 4 } : {}),
    },
    ...(operator
      ? {
          connections: {
            bot: { configured: true, username: "fixture_bot" },
            github: {
              connected: true,
              account: "fixture-org",
              repositories: 3,
            },
          },
        }
      : {}),
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      held.push(route);
      return;
    }
    if (path.endsWith("/settings") && route.request().method() === "PUT") {
      data.settings = route.request().postDataJSON().settings;
      data.version++;
      await route.fulfill({ json: data });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: {
                  id: "fixture",
                  username: "fixture",
                  operator,
                  ...(operator ? {} : { telegramId: "123" }),
                },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: data.settings.name }]
              : {},
    });
  });
  await page.goto(`/admin/overview?workspace=${workspaceId}`);
  await expect.poll(() => held.length).toBe(1);
  return { held, data };
}

for (const width of [1280, 390]) {
  test(`Overview keeps its own layout while loading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { held, data } = await fixture(page);
    await expect(
      page.getByRole("heading", { name: "Your team, in view" }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    const counts = page.getByRole("region", { name: "Workspace counts" });
    await expect(counts.getByRole("link")).toHaveCount(4);
    for (const name of ["Workspace counts", "Telegram bot", "GitHub", "Team"]) {
      const section = page.getByRole("region", { name, exact: true });
      await expect(section).toBeVisible();
      await expect(section).toHaveAttribute("aria-busy", "true");
      await expect(section.locator(".skeleton").first()).toBeVisible();
    }
    for (const label of [
      "Manage bot",
      "Manage GitHub",
      "Edit team configuration",
    ])
      await expect(page.getByRole("button", { name: label })).toBeDisabled();
    const team = page.getByRole("region", { name: "Team", exact: true });
    await expect(
      team.getByText("Workspace name", { exact: true }),
    ).toBeVisible();
    await expect(team.getByText("Timezone", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Not configured|Not connected|Connect a Telegram bot/),
    ).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("overview-pending.png"),
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(counts.locator(".skeleton").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    await held.shift()?.fulfill({ json: data });
    await expect(counts).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("main .skeleton")).toHaveCount(0);
    await expect(
      counts.getByRole("link", { name: "8 members. View details" }),
    ).toBeVisible();
    await expect(
      team.getByRole("heading", { name: "Overview fixture" }),
    ).toBeVisible();
    for (const label of [
      "Manage bot",
      "Manage GitHub",
      "Edit team configuration",
    ])
      await expect(page.getByRole("button", { name: label })).toBeEnabled();
  });
}

test("Overview hides deployment controls for a workspace administrator while loading", async ({
  page,
}) => {
  const { held, data } = await fixture(page, false);
  const counts = page.getByRole("region", { name: "Workspace counts" });
  await expect(counts.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Connections" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Manage bot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage GitHub" })).toHaveCount(
    0,
  );
  await held.shift()?.fulfill({ json: data });
  await expect(counts).toHaveAttribute("aria-busy", "false");
  await expect(counts.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Connections" })).toHaveCount(
    0,
  );
});

test("Overview ends skeletons on failure and retries without showing audit history", async ({
  page,
}) => {
  const { held, data } = await fixture(page);
  await held.shift()?.fulfill({
    status: 503,
    json: { error: "overview_unavailable" },
  });
  await expect(page.getByRole("alert")).toContainText("overview_unavailable");
  await expect(page.locator("main .skeleton")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  const counts = page.getByRole("region", { name: "Workspace counts" });
  await expect(counts).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Manage bot" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Edit team configuration" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(counts).toHaveAttribute("aria-busy", "true");
  await held.shift()?.fulfill({ json: data });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage bot" })).toBeEnabled();
});

test("Overview preserves saved values during the refresh after editing", async ({
  page,
}) => {
  const { held, data } = await fixture(page);
  await held.shift()?.fulfill({ json: data });
  await page.getByRole("button", { name: "Edit team configuration" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit team configuration" });
  await dialog
    .getByLabel("Workspace name", { exact: true })
    .fill("Updated team");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => held.length).toBe(1);
  const counts = page.getByRole("region", { name: "Workspace counts" });
  await expect(counts).toHaveAttribute("aria-busy", "true");
  await expect(
    counts.getByRole("link", { name: "8 members. View details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Updated team" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Telegram bot" }),
  ).toContainText("@fixture_bot");
  await expect(page.locator("main .skeleton")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit team configuration" }),
  ).toBeDisabled();
  await held.shift()?.fulfill({ json: data });
  await expect(counts).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "Edit team configuration" }),
  ).toBeEnabled();
});
