import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodingPage, CodingTask } from "../../src/coding/config.ts";
import { chooseOption } from "./dropdown-helpers.ts";

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

test("coding feedback shows confirmed stages, stopping and safe failures on desktop and mobile", async ({
  page,
}) => {
  const f = await fixture(page, { state: "connected" });
  await f.dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const now = Date.now();
  const task: CodingTask = {
    id: "1e8f2aab-3b09-4e8e-858e-75c20d832517",
    actor: "101",
    runId: "fixture-run",
    chatId: "101",
    topicId: 3,
    state: "running" as const,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    payload: {
      repositoryId: 7001,
      repository: "example/repo",
      installationId: 501,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      backend: "podman" as const,
      authMode: "device_code" as const,
      title: "Readable task feedback",
      body: "Fixture",
    },
    progress: {
      key: "1:check",
      stage: "check",
      sequence: 1,
      observedAt: now,
      changedAt: now,
    },
  };
  f.data.tasks = [task];
  await page
    .getByRole("button", { name: "Check progress", exact: true })
    .click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "Readable task feedback" });
  await expect(row).toContainText("Running checks");
  await page.screenshot({
    path: "test-results/telegram-feedback-desktop.png",
    fullPage: true,
  });
  if (!task.progress) throw new Error("Missing progress fixture");
  task.progress.unavailable = true;
  await page
    .getByRole("button", { name: "Check progress", exact: true })
    .click();
  await expect(row).toContainText("Runner status unavailable");
  task.cancelRequested = true;
  await page
    .getByRole("button", { name: "Check progress", exact: true })
    .click();
  await expect(row).toContainText("Stopping");
  task.state = "failed";
  task.error = "private-provider-token-detail";
  await expect(row).toContainText("Could not complete", { timeout: 10000 });
  await expect(row).toContainText("workspace administrator");
  await expect(row).not.toContainText("private-provider-token-detail");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/telegram-feedback-mobile.png",
    fullPage: true,
  });
});

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
  await expect(dialog).toContainText(
    "VPS releases automatically start and maintain the Codex runner",
  );
  await expect(
    dialog.getByRole("link", { name: "Codex runner setup instructions" }),
  ).toHaveAttribute("href", /codex-podman\.md#configure-the-deployment$/);
  await dialog.screenshot({
    path: "test-results/codex-configuration-desktop.png",
  });
  await chooseOption(dialog.getByLabel("Sign-in method"), "provider_key");
  await expect(
    dialog.getByRole("link", { name: "Codex runner setup instructions" }),
  ).toBeVisible();
  await dialog
    .getByLabel("Provider API key", { exact: true })
    .fill("unsaved-test-key");
  await chooseOption(dialog.getByLabel("Sign-in method"), "device_code");
  data.deviceAuth = { state: "disconnected" };
  await dialog.getByRole("button", { name: "Recheck connection" }).click();
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await chooseOption(dialog.getByLabel("Sign-in method"), "provider_key");
  await expect(
    dialog.getByLabel("Provider API key", { exact: true }),
  ).toHaveValue("unsaved-test-key");
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

test("title switch persists enablement and retains the saved state when a stale save fails", async ({
  page,
}) => {
  const { data, dialog } = await fixture(page, { state: "disconnected" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Codex runner setup instructions" }),
  ).toBeVisible();
  const toggle = page.getByRole("switch", {
    name: "Enable Codex implementation",
  });
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: data });
    const input = route.request().postDataJSON();
    expect(input.revision).toBe(data.revision);
    data.settings = input.settings;
    data.revision += 1;
    await route.fulfill({ json: data });
  });
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  await expect(
    page.getByLabel("Codex configuration", { exact: true }),
  ).toContainText(
    "VPS releases automatically start and maintain the Codex runner",
  );
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: data });
    await route.fulfill({ status: 409, json: { error: "version_conflict" } });
  });
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText(
    "Settings changed in another session",
  );
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/plugin-title-switch-mobile.png",
    fullPage: true,
  });
});

test("device-login network failures explain server connectivity and preserve retry", async ({
  page,
}) => {
  const { dialog } = await fixture(page, { state: "disconnected" });
  await page.route(`**${endpoint}/device/start`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "coding_device_login_network_failed",
        detail: "private-token-fixture",
      },
    }),
  );
  await dialog
    .getByRole("button", { name: "Sign in with device code" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "secure connection to OpenAI",
  );
  await expect(dialog.getByRole("alert")).not.toContainText(
    "private-token-fixture",
  );
  await expect(
    dialog.getByRole("button", { name: "Sign in with device code" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Recheck connection" }),
  ).toBeEnabled();
});
