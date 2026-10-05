import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodingPage } from "../../src/coding/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
const pending = {
  state: "pending" as const,
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "TEST-CODE",
};

async function fixture(page: Page, state: CodingPage["deviceAuth"]) {
  const data: CodingPage = {
    revision: 1,
    settings: {
      enabled: false,
      backend: "podman",
      authMode: "device_code",
      repositories: [],
    },
    repositories: [],
    members: [],
    tasks: [],
    legacyActionsConfiguration: false,
    providerApiKeyConfigured: false,
    deviceAuth: state,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Device sign-in fixture" }]
            : path === endpoint
              ? data
              : {};
    await route.fulfill({ json });
  });
  await page.goto(`/admin/plugins/codex?workspace=${workspaceId}`);
  await page.getByRole("button", { name: "Edit Codex configuration" }).click();
  return {
    data,
    dialog: page.getByRole("dialog", { name: "Edit Codex configuration" }),
  };
}

test("unavailable runner can be rechecked without losing the configuration draft", async ({
  page,
}) => {
  const { data, dialog } = await fixture(page, { state: "unavailable" });
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "runner is unavailable",
  );
  await dialog.getByLabel("Enable Codex implementation").check();
  data.deviceAuth = { state: "disconnected" };
  await dialog.getByRole("button", { name: "Recheck connection" }).click();
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await expect(dialog.getByLabel("Enable Codex implementation")).toBeChecked();
  await expect(dialog).toBeVisible();
});

test("sign-in shows progress, displays the device code and polls until connected", async ({
  page,
}) => {
  const { data, dialog } = await fixture(page, { state: "disconnected" });
  let respond: ((route: Route) => Promise<void>) | undefined;
  let startRoute: Route | undefined;
  await page.route(`**${endpoint}/device/start`, async (route) => {
    startRoute = route;
    await new Promise<void>((resolve) => {
      respond = async (r) => {
        data.deviceAuth = pending;
        await r.fulfill({ json: pending });
        resolve();
      };
    });
  });
  await dialog
    .getByRole("button", { name: "Sign in with device code" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Starting sign-in…" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "Requesting a sign-in link",
  );
  await expect.poll(() => !!startRoute && !!respond).toBe(true);
  if (!startRoute || !respond) throw Error("Sign-in request missing");
  await respond(startRoute);
  await expect(dialog.getByText("TEST-CODE", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "ChatGPT device sign-in" }),
  ).toHaveAttribute("href", pending.verificationUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/codex-device-sign-in-mobile.png",
    fullPage: true,
  });
  data.deviceAuth = { state: "connected" };
  await expect(dialog.getByRole("status")).toContainText(
    "Connected for this workspace.",
  );
  await expect(
    dialog.getByRole("button", { name: "Disconnect account" }),
  ).toBeEnabled();
});

test("a failed sign-in explains the failure and enables retry", async ({
  page,
}) => {
  const { dialog } = await fixture(page, { state: "disconnected" });
  await page.route(`**${endpoint}/device/start`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "coding_device_login_unavailable" },
    }),
  );
  await dialog
    .getByRole("button", { name: "Sign in with device code" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Device sign-in could not start",
  );
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
});

test("a stalled sign-in times out and can recover a pending login through recheck", async ({
  page,
}) => {
  test.setTimeout(45000);
  const { data, dialog } = await fixture(page, { state: "disconnected" });
  let release: (() => void) | undefined;
  await page.route(`**${endpoint}/device/start`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.abort();
  });
  await dialog
    .getByRole("button", { name: "Sign in with device code" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("request timed out", {
    timeout: 25000,
  });
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  release?.();
  data.deviceAuth = pending;
  await dialog.getByRole("button", { name: "Recheck connection" }).click();
  await expect(dialog.getByText("TEST-CODE", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Disconnect account" }),
  ).toBeEnabled();
});

test("expired account explains automatic task continuation and offers device sign-in", async ({
  page,
}) => {
  const { dialog } = await fixture(page, { state: "auth_required" });
  await expect(dialog.getByRole("status")).toContainText(
    "Paused tasks will continue automatically",
  );
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Disconnect account" }),
  ).toBeEnabled();
});
