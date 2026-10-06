import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodingPage } from "../../src/coding/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
const data: CodingPage = {
  revision: 1,
  settings: {
    enabled: true,
    backend: "podman",
    authMode: "device_code",
    repositories: [],
  },
  repositories: [],
  members: [],
  tasks: [],
  legacyActionsConfiguration: false,
  providerApiKeyConfigured: false,
  deviceAuth: { state: "connected" },
};

async function fixture(
  page: Page,
  heldPath: string | string[] = endpoint,
  routePath = "plugins/codex",
) {
  const held: Route[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      typeof heldPath === "string" ? path === heldPath : heldPath.includes(path)
    ) {
      held.push(route);
      return;
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: {
                id: "operator",
                username: "fixture",
                operator: true,
                telegramId: "123",
              },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Loading fixture" }]
            : path === endpoint
              ? data
              : path.endsWith("/plugins")
                ? { revision: 1, entries: [] }
                : {};
    await route.fulfill({ json });
  });
  await page.goto(`/admin/${routePath}?workspace=${workspaceId}`);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  return held;
}

for (const width of [1280, 390]) {
  test(`startup waits for deployment, session and workspaces without flashing setup at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const held = await fixture(page, [
      "/api/setup/status",
      "/api/admin/auth/session",
      "/api/admin/workspaces",
    ]);
    const startup = page.getByRole("status", { name: "Opening RepoDesk" });
    const expectNeutralStartup = async () => {
      await expect(startup).toBeVisible();
      await expect(page.locator(".auth-hero, .setup-steps")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Workspace", exact: true }),
      ).toHaveCount(0);
    };
    await expectNeutralStartup();
    await page.screenshot({
      path: test.info().outputPath("startup.png"),
      fullPage: true,
    });
    await held.shift()?.fulfill({ json: { initialized: true } });
    await expect.poll(() => held.length).toBe(1);
    await expectNeutralStartup();
    await held.shift()?.fulfill({
      json: {
        admin: { id: "operator", username: "fixture", operator: true },
        csrf: "test",
      },
    });
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expectNeutralStartup();
    for (const route of held.splice(0))
      await route.fulfill({
        json: [{ id: workspaceId, name: "Loading fixture" }],
      });
    await expect(startup).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Codex", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".auth-hero, .setup-steps")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  });
}

for (const initialized of [true, false]) {
  test(`startup selects ${initialized ? "sign-in" : "first setup"} only after status is known`, async ({
    page,
  }) => {
    const held: Route[] = [];
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/setup/status") {
        held.push(route);
        return;
      }
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    });
    await page.goto("/admin");
    await expect(
      page.getByRole("status", { name: "Opening RepoDesk" }),
    ).toBeVisible();
    await expect(page.locator(".auth-form, .auth-hero")).toHaveCount(0);
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { initialized } });
    await expect(
      page.getByRole("status", { name: "Opening RepoDesk" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: initialized ? "Welcome back" : "Make this workspace yours",
      }),
    ).toBeVisible();
  });
}

for (const width of [1280, 390]) {
  test(`refresh never renders the login layout while restoring a session at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = await fixture(page);
    await initial.shift()?.fulfill({ json: data });
    await expect(
      page.getByRole("heading", { name: "Codex", exact: true }),
    ).toBeVisible();
    const held: Route[] = [];
    const responses = new Map<string, unknown>([
      ["/api/setup/status", { initialized: true }],
      [
        "/api/admin/auth/session",
        {
          admin: { id: "operator", username: "fixture", operator: true },
          csrf: "test",
        },
      ],
      ["/api/admin/workspaces", [{ id: workspaceId, name: "Loading fixture" }]],
    ]);
    const pending = new Set(responses.keys());
    await page.route("**/api/**", async (route) => {
      if (pending.has(new URL(route.request().url()).pathname))
        held.push(route);
      else await route.fallback();
    });
    await page.reload();
    for (const [path, json] of responses) {
      await expect.poll(() => held.length).toBe(1);
      await expect(
        page.getByRole("status", { name: "Opening RepoDesk" }),
      ).toBeVisible();
      await expect(
        page.locator(".layout-auth, .auth-hero, .auth-main, .auth-form"),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Workspace", exact: true }),
      ).toHaveCount(0);
      const route = held.shift();
      expect(new URL(route?.request().url() ?? "").pathname).toBe(path);
      pending.delete(path);
      await route?.fulfill({ json });
    }
    await expect(
      page.getByRole("heading", { name: "Codex", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".layout-auth, .app-loading")).toHaveCount(0);
  });
}

for (const path of [
  "/api/setup/status",
  "/api/admin/auth/session",
  "/api/admin/workspaces",
]) {
  test(`startup failure at ${path} keeps the login layout hidden and offers retry`, async ({
    page,
  }) => {
    const held = await fixture(page, path);
    await held
      .shift()
      ?.fulfill({ status: 503, json: { error: "Service unavailable" } });
    await expect(page.getByRole("alert")).toHaveText("Service unavailable");
    await expect(
      page.locator(".layout-auth, .auth-hero, .auth-form"),
    ).toHaveCount(0);
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname !== path) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json:
          path === "/api/setup/status"
            ? { initialized: true }
            : path === "/api/admin/auth/session"
              ? {
                  admin: {
                    id: "operator",
                    username: "fixture",
                    operator: true,
                  },
                  csrf: "test",
                }
              : [{ id: workspaceId, name: "Loading fixture" }],
      });
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { name: "Codex", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".layout-auth, .app-loading")).toHaveCount(0);
  });
}

for (const width of [1280, 390]) {
  test(`Codex keeps its cards visible while data loads at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const held = await fixture(page);
    const config = page.getByRole("region", {
      name: "Codex configuration",
      exact: true,
    });
    for (const name of [
      "Codex configuration",
      "Coding repositories",
      "Coding tasks",
    ]) {
      const card = page.getByRole("region", { name, exact: true });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("aria-busy", "true");
      await expect(card.locator(".skeleton").first()).toBeVisible();
    }
    await expect(
      config.getByText("Local containers", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit Codex configuration" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Add coding repository" }),
    ).toBeDisabled();
    await expect(
      page.getByText("No coding repositories configured."),
    ).toHaveCount(0);
    await expect(page.getByText(/Loading Codex settings/)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("pending.png"),
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(config.locator(".skeleton").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    for (const route of held.splice(0)) await route.fulfill({ json: data });
    await expect(config).toHaveAttribute("aria-busy", "false");
    await expect(config.locator(".skeleton")).toHaveCount(0);
    await expect(
      config.getByText("ChatGPT connected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit Codex configuration" }),
    ).toBeEnabled();
    await expect(
      page.getByText("No coding repositories configured."),
    ).toBeVisible();
  });
}

test("Codex ends the loading state on failure and recovers through retry", async ({
  page,
}) => {
  const held = await fixture(page);
  for (const route of held.splice(0))
    await route.fulfill({
      status: 503,
      json: { error: "coding_runner_unavailable" },
    });
  await expect(page.getByRole("alert")).toBeVisible();
  const config = page.getByRole("region", {
    name: "Codex configuration",
    exact: true,
  });
  await expect(config).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".coding-detail .skeleton")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit Codex configuration" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reload coding settings" }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(config).toHaveAttribute("aria-busy", "true");
  for (const route of held.splice(0)) await route.fulfill({ json: data });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    config.getByText("ChatGPT connected", { exact: true }),
  ).toBeVisible();
});

test("Usage retains its summary labels and table columns while loading", async ({
  page,
}) => {
  const held = await fixture(
    page,
    `/api/admin/workspaces/${workspaceId}/usage`,
    "usage",
  );
  await expect(page.getByText("Recorded spend", { exact: true })).toBeVisible();
  await expect(page.getByText("Monthly limit", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Reserved", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Actual", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No usage recorded yet.")).toHaveCount(0);
  await expect(page.locator(".usage-table .skeleton").first()).toBeVisible();
  for (const route of held.splice(0))
    await route.fulfill({
      json: { budget: 10, totalUsd: 0, total: 0, offset: 0, items: [] },
    });
  await expect(page.getByText("No usage recorded yet.")).toBeVisible();
  await expect(page.locator(".usage-table .skeleton")).toHaveCount(0);
});
