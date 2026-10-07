import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodingPage } from "../../src/coding/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
const coding: CodingPage = {
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

async function fixture(page: Page, respond: (route: Route) => Promise<void>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint || path === "/api/admin/auth/login") {
      await respond(route);
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Session fixture" }]
              : {},
    });
  });
  await page.goto(`/admin/plugins/codex?workspace=${workspaceId}`);
}

async function expectSignIn(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator("nav, .coding-detail, .modal-overlay")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Your session expired. Sign in again."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reload coding settings" }),
  ).toHaveCount(0);
}

for (const width of [1280, 390]) {
  test(`expired session during page load opens sign-in directly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, async (route) => {
      await route.fulfill({
        status: 401,
        json: { error: "authentication_required" },
      });
    });
    await expectSignIn(page);
  });
}

for (const status of [401, 403]) {
  test(`save returning ${status} ${status === 401 ? "opens sign-in" : "keeps the page"}`, async ({
    page,
  }) => {
    await fixture(page, async (route) => {
      await route.fulfill(
        route.request().method() === "PUT"
          ? {
              status,
              json: {
                error: status === 401 ? "authentication_required" : "forbidden",
              },
            }
          : { json: coding },
      );
    });
    await page
      .getByRole("switch", { name: "Enable Codex implementation" })
      .click();
    if (status === 401) {
      await expectSignIn(page);
    } else {
      await expect(page.getByRole("alert")).toContainText("forbidden");
      await expect(
        page.getByRole("heading", { name: "Codex", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".auth-form")).toHaveCount(0);
    }
  });
}

test("background session expiry clears CSRF and permits sign-in retry", async ({
  page,
}) => {
  let expired = false;
  let attempts = 0;
  await fixture(page, async (route) => {
    if (new URL(route.request().url()).pathname === "/api/admin/auth/login") {
      expect(route.request().headers()["x-csrf-token"]).toBeUndefined();
      attempts++;
      if (attempts === 1) {
        await route.fulfill({ status: 401, json: { error: "invalid_login" } });
      } else {
        expired = false;
        await route.fulfill({ json: { csrf: "test" } });
      }
      return;
    }
    await route.fulfill(
      expired
        ? { status: 401, json: { error: "authentication_required" } }
        : { json: coding },
    );
  });
  await expect(
    page.getByText("ChatGPT connected", { exact: true }),
  ).toBeVisible();
  expired = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectSignIn(page);
  await page.getByLabel("Username").fill("fixture");
  await page.getByLabel("Password").fill("fixture-password");
  const button = page.getByRole("button", { name: "Sign in", exact: true });
  await button.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Invalid username or password.",
  );
  await expect(page.getByLabel("Username")).toHaveValue("fixture");
  await expect(page.getByLabel("Password")).toHaveValue("fixture-password");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("heading", { name: "Your team, in view", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".auth-form")).toHaveCount(0);
});
