import { expect, type Page, type Route, test } from "@playwright/test";
import type { AntigravityPage } from "../../src/coding/config.ts";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/antigravity`;
const pendingOAuth = {
  state: "pending" as const,
  verificationUrl:
    "https://accounts.google.com/o/oauth2/auth?client_id=test&state=fixture",
};

async function fixture(page: Page, state: AntigravityPage["oauthAuth"]) {
  const data: AntigravityPage = {
    revision: 1,
    settings: {
      enabled: false,
      authMode: "google_oauth",
    },
    repositories: [],
    tasks: [],
    apiKeyConfigured: false,
    oauthAuth: state,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint && route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      data.settings = input.settings;
      data.revision += 1;
      if (input.apiKey === null) data.apiKeyConfigured = false;
      else if (typeof input.apiKey === "string" && input.apiKey.length)
        data.apiKeyConfigured = true;
      await route.fulfill({ json: data });
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
            ? [{ id: workspaceId, name: "Antigravity fixture" }]
            : path === endpoint
              ? data
              : path === "/api/admin/operator/coding-runtime"
                ? {
                    revision: 0,
                    selection: null,
                    engine: "docker",
                    environmentDefault: "docker",
                    retainedTasks: 0,
                  }
                : {};
    await route.fulfill({ json });
  });
  await page.goto(`/admin/plugins/antigravity?workspace=${workspaceId}`);
  return { data };
}

test("Antigravity CLI saved summary is separate from modal editor and title switch toggles cleanly", async ({
  page,
}) => {
  await fixture(page, { state: "disconnected" });
  const configCard = page.getByLabel("Antigravity CLI configuration", {
    exact: true,
  });
  await expect(configCard).toContainText("Disabled");
  await expect(configCard).toContainText("Google account (OAuth)");
  await expect(configCard).toContainText("Google account not connected");
  // Saved display contains no inline form inputs.
  await expect(configCard.locator("input, select")).toHaveCount(0);

  const toggle = page.getByRole("switch", { name: "Enable Antigravity CLI" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(configCard).toContainText("Enabled");

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: `test-results/antigravity-summary-${width}-${theme}.png`,
        fullPage: true,
      });
    }
  }
});

test("Google OAuth sign-in displays link, accepts pasted authorization code, and supports disconnect", async ({
  page,
}) => {
  const { data } = await fixture(page, { state: "disconnected" });
  await page
    .getByRole("button", { name: "Edit Antigravity CLI configuration" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Edit Antigravity CLI configuration",
  });

  let respondStart: ((route: Route) => Promise<void>) | undefined;
  let startRoute: Route | undefined;
  await page.route(`**${endpoint}/auth/start`, async (route) => {
    startRoute = route;
    await new Promise<void>((resolve) => {
      respondStart = async (r) => {
        data.oauthAuth = pendingOAuth;
        await r.fulfill({ json: pendingOAuth });
        resolve();
      };
    });
  });

  await dialog.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(
    dialog.getByRole("button", { name: "Starting sign-in…" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "Requesting a Google sign-in link",
  );
  await expect.poll(() => !!startRoute && !!respondStart).toBe(true);
  if (!startRoute || !respondStart) throw new Error("Sign-in route missing");
  await respondStart(startRoute);

  await expect(
    dialog.getByRole("link", { name: "Google sign-in" }),
  ).toHaveAttribute("href", pendingOAuth.verificationUrl);
  const completeBtn = dialog.getByRole("button", { name: "Complete sign-in" });
  await expect(completeBtn).toBeDisabled();

  await page.route(`**${endpoint}/auth/complete`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.code).toBe("test-auth-code-456");
    data.oauthAuth = { state: "connected" };
    await route.fulfill({ json: data });
  });

  await dialog
    .getByLabel("Authorization code or callback URL")
    .fill("test-auth-code-456");
  await expect(completeBtn).toBeEnabled();
  await completeBtn.click();

  await expect(dialog.getByRole("status")).toContainText(
    "Connected for this workspace.",
  );
  await expect(
    dialog.getByRole("button", { name: "Disconnect account" }),
  ).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/antigravity-oauth-connected-mobile.png",
    fullPage: true,
  });
});

test("Gemini API key configuration saves model, effort, and write-only key and preserves draft on runner recheck", async ({
  page,
}) => {
  const { data } = await fixture(page, { state: "unavailable" });
  await page
    .getByRole("button", { name: "Edit Antigravity CLI configuration" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Edit Antigravity CLI configuration",
  });

  await expect(
    dialog.getByRole("button", { name: "Sign in with Google" }),
  ).toBeDisabled();

  await chooseOption(dialog.getByLabel("Sign-in method"), "gemini_api_key");
  await dialog.getByLabel("Model (optional)").fill("gemini-4-neon-high");
  await chooseOption(dialog.getByLabel("Reasoning effort"), "high");
  await dialog
    .getByLabel("Gemini API key", { exact: true })
    .fill("AIza-test-secret");
  await dialog
    .getByLabel("Custom Gemini base URL (optional)")
    .fill("https://gemini-proxy.example.test");

  // Switch back to OAuth and recheck connection without losing model draft.
  await chooseOption(dialog.getByLabel("Sign-in method"), "google_oauth");
  data.oauthAuth = { state: "disconnected" };
  await dialog.getByRole("button", { name: "Recheck connection" }).click();
  await expect(
    dialog.getByRole("button", { name: "Sign in with Google" }),
  ).toBeEnabled();
  await expect(dialog.getByLabel("Model (optional)")).toHaveValue(
    "gemini-4-neon-high",
  );

  // Switch back to Gemini API key and save.
  await chooseOption(dialog.getByLabel("Sign-in method"), "gemini_api_key");
  await dialog
    .getByLabel("Gemini API key", { exact: true })
    .fill("AIza-test-secret");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await expect(dialog).toHaveCount(0);

  const configCard = page.getByLabel("Antigravity CLI configuration", {
    exact: true,
  });
  await expect(configCard).toContainText("Gemini API key");
  await expect(configCard).toContainText("gemini-4-neon-high");
  await expect(configCard).toContainText("High");
  await expect(configCard).toContainText("Gemini API key configured");
  await expect(configCard).not.toContainText("AIza-test-secret");
});

test("Antigravity tasks table displays active tasks and supports stop confirmation", async ({
  page,
}) => {
  const { data } = await fixture(page, { state: "connected" });
  const now = Date.now();
  const task: DevelopmentTask = {
    id: "2e8f2aab-3b09-4e8e-858e-75c20d832517",
    actor: "101",
    workspaceId,
    botId: "999",
    sourceId: "fixture-source",
    policy: { publishByDefault: true },
    phase: "work",
    revision: 1,
    consumedRevision: 1,
    verifiedRevision: 0,
    fence: 1,
    attempts: 1,
    tokens: 0,
    activeMs: 0,
    canImplement: true,
    canPublish: true,
    cancelRequested: false,
    chatId: "101",
    topicId: 0,
    state: "working",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    payload: {
      repositoryId: 7001,
      repository: "example/repo",
      installationId: 501,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      backend: "podman",
      engine: "antigravity",
      authMode: "google_oauth",
      model: "gemini-4-neon-high",
      title: "Add feature via Antigravity",
      body: "Fixture",
    },
    progress: {
      key: "1:implement",
      stage: "implement",
      sequence: 1,
      observedAt: now,
      changedAt: now,
    },
  };
  data.tasks = [task];

  await page.reload();
  const row = page
    .getByRole("row")
    .filter({ hasText: "Add feature via Antigravity" });
  await expect(row).toContainText("Implementing");

  let cancelled = false;
  await page.route(`**${endpoint}/${task.id}/cancel`, async (route) => {
    cancelled = true;
    task.cancelRequested = true;
    await route.fulfill({ json: { ok: true } });
  });

  await page
    .getByRole("button", {
      name: "Stop coding task Add feature via Antigravity",
    })
    .click();
  const stopDialog = page.getByRole("dialog", { name: "Stop coding task?" });
  await stopDialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(row).toContainText("Stopping");
});
