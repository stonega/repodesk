import { expect, type Page, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";
import type { GitHubPage } from "../../src/github/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/github`;

async function fixture(page: Page) {
  const data: GitHubPage = {
    configured: true,
    revision: 1,
    pending: false,
    installations: [],
    connection: {
      revision: 1,
      installationId: 501,
      account: "example",
      connectedBy: "fixture",
      repositories: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        full_name: `example/repository-${i + 1}`,
      })),
    },
  };
  const state = {
    calls: 0,
    syncCalls: 0,
    lastSyncBody: undefined as Record<string, unknown> | undefined,
    unavailable: false,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${endpoint}/sync` && route.request().method() === "POST") {
      state.syncCalls++;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.lastSyncBody = body;
      if (state.unavailable) {
        await route.fulfill({
          status: 502,
          json: { error: "github_unavailable" },
        });
        return;
      }
      if (data.connection) {
        const before = data.connection.repositories.length;
        if (typeof body.allRepositories === "boolean") {
          if (body.allRepositories) data.connection.allRepositories = true;
          else delete data.connection.allRepositories;
        }
        let added = 0;
        if (
          data.connection.allRepositories &&
          !data.connection.repositories.some((r) => r.id === 8)
        ) {
          data.connection.repositories = [
            ...data.connection.repositories,
            { id: 8, full_name: "example/new-auto-repo" },
          ];
          added = 1;
        }
        data.connection.revision++;
        data.revision = data.connection.revision;
        await route.fulfill({
          json: {
            ...data,
            syncResult: {
              changed: added > 0 || typeof body.allRepositories === "boolean",
              total: data.connection.repositories.length,
              added,
              removed: 0,
              addedNames: added ? ["example/new-auto-repo"] : [],
              allRepositories: !!data.connection.allRepositories,
            },
          },
        });
        void before;
        return;
      }
    }
    if (path === endpoint) {
      state.calls++;
      if (state.unavailable) {
        await route.fulfill({
          status: 503,
          json: { error: "github_unavailable" },
        });
        return;
      }
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Repository sync fixture" }]
              : path === endpoint
                ? data
                : path.endsWith("/overview")
                  ? {
                      version: 1,
                      settings: settingsSchema.parse({
                        name: "Repository sync fixture",
                        timezone: "Asia/Taipei",
                      }),
                      counts: {
                        members: 1,
                        runs: 0,
                        workflows: 0,
                        codingTasks: 0,
                      },
                      connections: {
                        bot: { configured: false },
                        github: {
                          connected: true,
                          account: "example",
                          repositories: 7,
                        },
                      },
                    }
                  : {},
    });
  });
  await page.goto(`/admin/overview?workspace=${workspaceId}`);
  expect(state.calls).toBe(0);
  await page.getByRole("button", { name: "Manage GitHub" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage GitHub" });
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-1 on GitHub" }),
  ).toBeVisible();
  return { dialog, data, state };
}

test("GitHub list polls while open, preserves expansion and updates renamed links", async ({
  page,
}) => {
  const { dialog, data, state } = await fixture(page);
  await dialog.getByRole("button", { name: "2 more" }).click();
  if (data.connection) {
    data.connection.repositories = data.connection.repositories.map((repo) =>
      repo.id === 1 ? { ...repo, full_name: "example/renamed" } : repo,
    );
    data.connection.repositories = data.connection.repositories.slice(0, 6);
  }
  const link = dialog.getByRole("link", {
    name: "Open example/renamed on GitHub",
  });
  await expect(link).toBeVisible({ timeout: 10000 });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/example/renamed",
  );
  await expect(dialog.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-6 on GitHub" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-7 on GitHub" }),
  ).toHaveCount(0);
  await expect(dialog.locator(".skeleton")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const calls = state.calls;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(state.calls).toBe(calls);
});

test("returning from GitHub refreshes and transient failures keep the saved list", async ({
  page,
}) => {
  const { dialog, data, state } = await fixture(page);
  state.unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("alert")).toContainText(
    "GitHub is unavailable",
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-1 on GitHub" }),
  ).toBeVisible();
  state.unavailable = false;
  if (data.connection)
    data.connection.repositories = data.connection.repositories.map((repo) =>
      repo.id === 1 ? { ...repo, full_name: "example/renamed" } : repo,
    );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/renamed on GitHub" }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  data.refreshError = "github_access_denied";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("status")).toContainText(
    "Showing the last saved list",
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/renamed on GitHub" }),
  ).toBeVisible();
});

test("operator can enable all-repository auto-sync and manually sync from Manage GitHub at desktop and mobile widths", async ({
  page,
}) => {
  const { dialog, state } = await fixture(page);
  await expect(dialog).toContainText("Selected repositories");
  await expect(
    dialog.getByRole("button", { name: "Sync repositories" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Auto-sync all repositories" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Change repositories" }),
  ).toBeVisible();

  // Enable all-repository auto-sync and verify new repo appears immediately.
  await dialog
    .getByRole("button", { name: "Auto-sync all repositories" })
    .click();
  expect(state.syncCalls).toBe(1);
  expect(state.lastSyncBody).toEqual({ revision: 1, allRepositories: true });
  await expect(dialog).toContainText("All repositories (auto-sync)");
  await expect(dialog.getByRole("status")).toContainText(
    "All-repository auto-sync enabled. 8 repositories connected (1 added).",
  );
  await expect(
    dialog.getByRole("button", { name: "Use selected only" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "3 more" }).click();
  await expect(
    dialog.getByRole("link", { name: "Open example/new-auto-repo on GitHub" }),
  ).toBeVisible();

  // Manual Sync repositories reports up-to-date status.
  await dialog.getByRole("button", { name: "Sync repositories" }).click();
  expect(state.syncCalls).toBe(2);
  expect(state.lastSyncBody).toEqual({ revision: 2 });
  await expect(dialog.getByRole("status")).toContainText(
    "Repositories are up to date (8 connected).",
  );

  // Desktop and mobile layout verification (light + dark, zero overflow).
  await page.setViewportSize({ width: 1280, height: 720 });
  const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR ?? "test-results";
  await page.screenshot({
    path: `${screenshotDir}/github-sync-desktop-light.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  await page.screenshot({
    path: `${screenshotDir}/github-sync-mobile-light.png`,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({
    path: `${screenshotDir}/github-sync-mobile-dark.png`,
  });
});
