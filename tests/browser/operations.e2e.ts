import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const accountId = "38a85e17-16a5-4578-a308-5c2a1fc624e7";
const runId = "b1e473d5-9569-4a01-b1ca-02e2469bd0b5";
const healthPath = "/api/admin/operator/health";
const progressPath = "/api/setup/progress";

async function fixture(page: Page, empty = false) {
  const workspace = {
    id: workspaceId,
    settings: settingsSchema.parse({
      name: "Fixture workspace",
      timezone: "Asia/Taipei",
    }),
    ownerVerified: true,
    skills: [],
    deleted: false,
  };
  const progress = {
    version: 3,
    paused: false,
    workspaces: empty
      ? []
      : [{ ...workspace, id: "removed-workspace", deleted: true }, workspace],
  };
  const health = {
    workers: 2,
    pending: 4,
    oldest_seconds: 12.3,
    failed_runs: 1,
    unknown_deliveries: 0,
    paused: false,
    audit: [] as Record<string, unknown>[],
  };
  const writes: { path: string; input: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let response: unknown = {};
    if (method === "POST") {
      const input = route.request().postDataJSON();
      writes.push({ path, input });
      health.audit = [
        {
          action: "Fixture action",
          actor: "operator",
          target: workspaceId,
          at: "2026-10-10T00:00:00Z",
        },
      ];
      if (path.endsWith("/pause")) {
        progress.paused = input.paused;
        progress.version++;
        health.paused = input.paused;
        response = { ok: true };
      } else if (path.endsWith("/accounts")) response = { id: accountId };
      else if (path.endsWith("/link"))
        response = {
          url: "https://t.me/fixture_bot?start=verify_fixture",
          expiresAt: "2026-10-10T00:10:00Z",
        };
      else response = { ok: true };
    } else {
      response =
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? empty
                ? []
                : [{ id: workspaceId, name: workspace.settings.name }]
              : path === healthPath
                ? health
                : path === progressPath
                  ? progress
                  : path === `/api/admin/operator/runs/${runId}`
                    ? { runId, workspaceId, status: "failed", attempts: [] }
                    : {};
    }
    await route.fulfill({ json: response });
  });
  return { progress, health, writes };
}

async function open(page: Page) {
  await page.goto("/admin/operations");
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`operations separates summaries from dialogs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await fixture(page);
    await open(page);
    const health = page.getByRole("region", { name: "Service health" });
    await expect(health).toContainText("Live workers");
    await expect(health).toContainText("12 seconds");
    await expect(
      page.getByRole("region", { name: "Deployment activity" }),
    ).toContainText("Active");
    await expect(
      page.locator(
        "main form, main input, main textarea, main [role=combobox]",
      ),
    ).toHaveCount(0);
    const create = page.getByRole("button", {
      name: "Create panel account",
      exact: true,
    });
    await expect(create).toHaveText("New");
    await create.click();
    const account = page.getByRole("dialog", {
      name: "Create panel account",
      exact: true,
    });
    await account.getByLabel("Username", { exact: true }).fill("discarded");
    await account.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(create).toBeFocused();
    expect(writes).toHaveLength(0);
    await create.click();
    await expect(account.getByLabel("Username", { exact: true })).toHaveValue(
      "",
    );
    await account.getByLabel("Username", { exact: true }).fill("new-account");
    await account
      .getByLabel("Password", { exact: true })
      .fill("fixture password 123");
    await expect(
      account.getByLabel("Password", { exact: true }),
    ).toHaveAttribute("type", "password");
    await account
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(account).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Panel accounts" }),
    ).toContainText(accountId);
    await expect(page.getByRole("status")).toContainText(
      "Panel account created.",
    );

    const issue = page.getByRole("button", { name: "Issue link", exact: true });
    await issue.click();
    const verification = page.getByRole("dialog", {
      name: "Issue identity verification",
    });
    await expect(
      verification.getByLabel("Workspace", { exact: true }),
    ).toContainText("Fixture workspace");
    await verification.getByLabel("Panel account ID").fill(accountId);
    await verification
      .getByRole("button", { name: "Issue one-use link" })
      .click();
    await expect(verification).toHaveCount(0);
    await expect(
      page.getByRole("link", {
        name: "https://t.me/fixture_bot?start=verify_fixture",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Panel accounts" }),
    ).toContainText(accountId);

    const recover = page.getByRole("button", {
      name: "Recover access",
      exact: true,
    });
    await recover.click();
    const recovery = page.getByRole("dialog", {
      name: "Recover workspace access",
      exact: true,
    });
    await expect(
      recovery.getByLabel("Workspace", { exact: true }),
    ).toContainText("Fixture workspace");
    await recovery.getByLabel("Telegram user ID").fill("123456");
    await recovery
      .getByRole("button", { name: "Restore management access" })
      .click();
    await expect(recovery).toHaveCount(0);
    await expect(recover).toBeFocused();
    await expect(page.getByRole("status")).toContainText(
      "Workspace management access restored.",
    );
    await expect(
      page.getByRole("region", {
        name: "Recent operator actions",
        exact: true,
      }),
    ).toContainText("Fixture action");

    await page
      .getByRole("button", { name: "Inspect run", exact: true })
      .click();
    const diagnostic = page.getByRole("dialog", {
      name: "Inspect run",
      exact: true,
    });
    await diagnostic.getByLabel("Run ID", { exact: true }).fill(runId);
    await diagnostic
      .getByRole("button", { name: "Inspect redacted status" })
      .click();
    await expect(diagnostic).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Run diagnostics" }),
    ).toContainText(runId);
    await expect(page.locator("main form, main input")).toHaveCount(0);
    expect(writes).toEqual([
      {
        path: "/api/admin/operator/accounts",
        input: { username: "new-account", password: "fixture password 123" },
      },
      {
        path: `/api/admin/operator/accounts/${accountId}/link`,
        input: { workspaceId },
      },
      {
        path: `/api/admin/operator/recover/${workspaceId}`,
        input: { telegramId: "123456" },
      },
    ]);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("results.png"),
      fullPage: true,
    });
  });

  for (const theme of ["light", "dark"]) {
    test(`operations layout and recovery dialog in ${theme} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      await fixture(page);
      await open(page);
      await expect(
        page.getByRole("button", { name: "Recover access", exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: test.info().outputPath("summary.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Recover access", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Recover workspace access",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByLabel("Workspace", { exact: true }),
      ).toBeFocused();
      const actions = dialog.locator(".modal-actions button");
      await expect(actions).toHaveText(["Restore management access", "Cancel"]);
      await actions.last().focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "Close Recover workspace access" }),
      ).toBeFocused();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: test.info().outputPath("editor.png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Recover access", exact: true }),
      ).toBeFocused();
    });
  }
}

for (const width of [1280, 390]) {
  for (const flow of [
    {
      trigger: "Create panel account",
      title: "Create panel account",
      submit: "Create account",
      pending: "Creating account…",
      endpoint: "/api/admin/operator/accounts",
      fields: { Username: "new-account", Password: "fixture password 123" },
    },
    {
      trigger: "Issue link",
      title: "Issue identity verification",
      submit: "Issue one-use link",
      pending: "Issuing link…",
      endpoint: `/api/admin/operator/accounts/${accountId}/link`,
      fields: { "Panel account ID": accountId },
    },
    {
      trigger: "Recover access",
      title: "Recover workspace access",
      submit: "Restore management access",
      pending: "Restoring access…",
      endpoint: `/api/admin/operator/recover/${workspaceId}`,
      fields: { "Telegram user ID": "123456" },
    },
    {
      trigger: "Inspect run",
      title: "Inspect run",
      submit: "Inspect redacted status",
      pending: "Inspecting…",
      endpoint: `/api/admin/operator/runs/${runId}`,
      fields: { "Run ID": runId },
    },
  ]) {
    test(`${flow.title} preserves failed drafts and locks pending requests at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page);
      let held: Route | undefined;
      let requests = 0;
      await page.route(`**${flow.endpoint}`, (route) => {
        requests++;
        held = route;
      });
      await open(page);
      await page
        .getByRole("button", { name: flow.trigger, exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: flow.title,
        exact: true,
      });
      for (const [label, value] of Object.entries(flow.fields))
        await dialog.getByLabel(label, { exact: true }).fill(value);
      await dialog
        .getByRole("button", { name: flow.submit, exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: `Close ${flow.title}` }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: flow.pending }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect.poll(() => !!held).toBe(true);
      expect(requests).toBe(1);
      await page.screenshot({
        path: test.info().outputPath("pending.png"),
        fullPage: true,
      });
      await held?.fulfill({
        status: 400,
        json: { error: "fixture_request_failed" },
      });
      await expect(dialog.getByRole("alert")).toContainText(
        "fixture_request_failed",
      );
      for (const [label, value] of Object.entries(flow.fields))
        await expect(dialog.getByLabel(label, { exact: true })).toHaveValue(
          value,
        );
      await page.screenshot({
        path: test.info().outputPath("error.png"),
        fullPage: true,
      });
      await page.unroute(`**${flow.endpoint}`);
      await dialog
        .getByRole("button", { name: flow.submit, exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    });
  }
}

for (const width of [1280, 390]) {
  test(`deployment confirmation uses the loaded version and recovers conflicts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { progress, writes } = await fixture(page);
    let held: Route | undefined;
    await page.route("**/api/admin/operator/pause", (route) => {
      held = route;
    });
    await open(page);
    const trigger = page.getByRole("button", {
      name: "Pause deployment",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Pause deployment?",
      exact: true,
    });
    await expect(dialog).toContainText("across all workspaces");
    await page.screenshot({
      path: test.info().outputPath("confirmation.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toHaveLength(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Pause deployment", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect.poll(() => !!held).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("pending.png"),
      fullPage: true,
    });
    expect(held?.request().postDataJSON()).toEqual({
      paused: true,
      version: 3,
    });
    progress.version = 4;
    await held?.fulfill({ status: 409, json: { error: "version_conflict" } });
    await expect(dialog.getByRole("alert")).toContainText("version_conflict");
    await expect(dialog.locator(".modal-actions button")).toHaveText([
      "Pause deployment",
      "Cancel",
    ]);
    await expect(
      dialog.getByRole("button", { name: "Pause deployment", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("conflict.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Reload current version" })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.unroute("**/api/admin/operator/pause");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Pause deployment", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Deployment activity" }),
    ).toContainText("Paused");
    await page
      .getByRole("button", { name: "Resume deployment", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Resume deployment?" })
      .getByRole("button", { name: "Resume deployment", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Deployment activity" }),
    ).toContainText("Active");
    expect(writes).toEqual([
      {
        path: "/api/admin/operator/pause",
        input: { paused: true, version: 4 },
      },
      {
        path: "/api/admin/operator/pause",
        input: { paused: false, version: 5 },
      },
    ]);
  });
}

for (const width of [1280, 390]) {
  test(`loading, failed loads and empty workspaces remain truthful at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, true);
    const held = new Map<string, Route>();
    for (const path of [healthPath, progressPath])
      await page.route(`**${path}`, (route) => {
        held.set(path, route);
      });
    await open(page);
    const service = page.getByRole("region", { name: "Service health" });
    const activity = page.getByRole("region", { name: "Deployment activity" });
    await expect(service).toContainText("Oldest pending");
    await expect(service.locator(".skeleton").first()).toBeVisible();
    await expect(service).not.toContainText("0 seconds");
    await expect(activity).not.toContainText("Active");
    for (const name of ["Pause deployment", "Issue link", "Recover access"])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    await expect.poll(() => held.size).toBe(2);
    for (const route of held.values())
      await route.fulfill({
        status: 503,
        json: { error: "fixture_loading_failed" },
      });
    await expect(page.getByRole("alert")).toContainText(
      "fixture_loading_failed",
    );
    await expect(service).toContainText("Unavailable");
    await expect(activity).toContainText("Unavailable");
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    for (const path of [healthPath, progressPath])
      await page.unroute(`**${path}`);
    await page
      .getByRole("button", { name: "Retry operations loading" })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(activity).toContainText("Active");
    await expect(
      page.getByText("No workspaces.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No operator actions.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Issue link", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Recover access", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Pause deployment", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
  });
}
