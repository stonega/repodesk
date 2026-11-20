import { expect, type Page, test } from "@playwright/test";
import type { NotificationPage } from "../../src/github/notifications.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function fixture(page: Page, initial?: Partial<NotificationPage>) {
  const data: NotificationPage = {
    canManage: true,
    canConfigureWebhook: true,
    webhookUrl: "https://notifications.example/github/webhook/operator",
    webhookConfigured: true,
    settings: {
      autoNotifyMaintainers: true,
      revision: 0,
    },
    autoRepositories: [],
    repositories: [{ id: 7001, full_name: "example/workspace" }],
    subscriptions: [],
    ...initial,
  };
  const controls = {
    error: "",
    loadError: false,
    pending: Promise.resolve(),
    loading: Promise.resolve(),
  };
  const writes: unknown[] = [];
  const isMaintainer = (initial?.autoRepositories?.length ?? 0) > 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/github/notifications/settings")) {
      const input = route.request().postDataJSON();
      writes.push(input);
      await controls.pending;
      if (controls.error) {
        await route.fulfill({ status: 409, json: { error: controls.error } });
        return;
      }
      data.settings = {
        autoNotifyMaintainers: input.autoNotifyMaintainers,
        revision: data.settings.revision + 1,
      };
      data.autoRepositories =
        data.settings.autoNotifyMaintainers &&
        isMaintainer &&
        !data.subscriptions.length
          ? [{ id: 7001, full_name: "example/workspace" }]
          : [];
      await route.fulfill({ json: data });
      return;
    }
    if (path.endsWith("/github/notifications/webhook")) {
      await route.fulfill({
        json: { secret: "synthetic-notification-webhook-secret-for-github" },
      });
      return;
    }
    if (path.endsWith("/github/notifications")) {
      if (route.request().method() === "GET") await controls.loading;
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        writes.push(input);
        await controls.pending;
        if (controls.error) {
          await route.fulfill({ status: 409, json: { error: controls.error } });
          return;
        }
        const existing = data.subscriptions[0];
        if (input.action === "delete") {
          data.subscriptions = [];
          data.autoRepositories =
            data.settings.autoNotifyMaintainers && isMaintainer
              ? [{ id: 7001, full_name: "example/workspace" }]
              : [];
        } else if (input.action === "subscribe") {
          data.subscriptions = [
            {
              id: "subscription",
              actor: "101",
              repositoryId: 7001,
              repository: "example/workspace",
              installationId: 501,
              connectionRevision: 1,
              botId: "900",
              revision: (existing?.revision ?? 0) + 1,
              events: input.events,
              enabled: true,
              since: new Date().toISOString(),
              available: true,
            },
          ];
          data.autoRepositories = [];
        } else if (existing) {
          existing.enabled = input.action === "resume";
          existing.revision++;
        } else if (input.action === "pause" && data.autoRepositories.length) {
          data.subscriptions = [
            {
              id: "subscription",
              actor: "101",
              repositoryId: 7001,
              repository: "example/workspace",
              installationId: 501,
              connectionRevision: 1,
              botId: "900",
              revision: 1,
              events: ["pull_request", "issues"],
              enabled: false,
              since: new Date().toISOString(),
              available: true,
            },
          ];
          data.autoRepositories = [];
        }
      } else if (controls.loadError) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return;
      }
      await route.fulfill({ json: data });
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
              ? [{ id: workspaceId, name: "Notifications" }]
              : { providers: [], entries: [] },
    });
  });
  return {
    data,
    controls,
    writes,
    open: () =>
      page.goto(`/admin/plugins/github-notifications?workspace=${workspaceId}`),
  };
}
for (const width of [1280, 390]) {
  test(`personal subscriptions keep display and modal editing separate at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const region = page.getByRole("region", {
      name: "Personal repository notifications",
    });
    await expect(region).toContainText("No subscriptions yet");
    await expect(region.locator("input,select,form")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/repodesk-notifications-empty-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "New subscription" }).click();
    const editor = page.getByRole("dialog", {
      name: "New subscription",
      exact: true,
    });
    await chooseOption(
      editor.getByRole("combobox", { name: "Repository" }),
      "7001",
    );
    await editor.getByRole("checkbox", { name: "New PRs" }).uncheck();
    f.controls.error = "github_user_access_unavailable";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "permissions are unavailable",
    );
    await expect(
      editor.getByRole("checkbox", { name: "New issues" }),
    ).toBeChecked();
    await expect(
      editor.getByRole("checkbox", { name: "New PRs" }),
    ).not.toBeChecked();
    await page.screenshot({
      path: `/tmp/repodesk-notifications-error-${width}.png`,
      fullPage: true,
    });
    f.controls.error = "";
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await page.screenshot({
      path: `/tmp/repodesk-notifications-pending-${width}.png`,
      fullPage: true,
    });
    release();
    await expect(editor).not.toBeVisible();
    const headingBounds = await region
      .getByRole("heading", { name: "Subscriptions", exact: true })
      .boundingBox();
    const newBounds = await region
      .getByRole("button", { name: "New subscription" })
      .boundingBox();
    expect(
      Math.abs((headingBounds?.y ?? 0) - (newBounds?.y ?? 0)),
    ).toBeLessThan(12);
    await expect(region).toContainText("New issues");
    await expect(region).toContainText("Enabled");
    await expect(region.locator("input,select,form")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/repodesk-notifications-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({
      path: `/tmp/repodesk-notifications-dark-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Edit example/workspace" }).click();
    const edit = page.getByRole("dialog", { name: "Edit subscription" });
    await expect(edit.getByRole("combobox", { name: "Repository" })).toHaveText(
      "example/workspace",
    );
    await edit.getByRole("checkbox", { name: "New PRs" }).check();
    await page.screenshot({
      path: `/tmp/repodesk-notifications-editor-${width}.png`,
      fullPage: true,
    });
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      region.getByRole("article", { name: "example/workspace" }),
    ).not.toContainText("New PRs");
    await region.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(region).toContainText("Paused");
    await region.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(region).toContainText("Enabled");
    await page
      .getByRole("button", { name: "Delete example/workspace" })
      .click();
    await page
      .getByRole("dialog", { name: "Delete subscription" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(region).toContainText("No subscriptions yet");
    expect(f.writes.length).toBe(5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
test("notification loading, retry and missing identity remain truthful", async ({
  page,
}) => {
  const f = await fixture(page);
  f.controls.loadError = true;
  let release = () => {};
  f.controls.loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await f.open();
  await expect(
    page.getByRole("heading", { name: "Subscriptions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New subscription" }),
  ).toBeDisabled();
  await expect(
    page.getByText("No subscriptions yet", { exact: false }),
  ).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `/tmp/repodesk-notifications-loading-${width}.png`,
      fullPage: true,
    });
  }
  release();
  await expect(page.getByRole("alert")).toContainText(
    "Could not update notifications",
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `/tmp/repodesk-notifications-load-error-${width}.png`,
      fullPage: true,
    });
  }
  f.controls.loadError = false;
  f.data.canManage = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Link your Telegram identity from Account", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New subscription" }),
  ).toBeDisabled();
});

test("shared webhook settings keep secrets in their explicit editor", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  const delivery = page.getByRole("region", {
    name: "GitHub notification delivery",
  });
  await expect(delivery).toContainText(f.data.webhookUrl ?? "");
  await page.getByRole("button", { name: "Edit webhook secret" }).click();
  const editor = page.getByRole("dialog", { name: "Edit webhook secret" });
  await editor.getByRole("button", { name: "Save secret" }).click();
  await expect(editor).toContainText(
    "synthetic-notification-webhook-secret-for-github",
  );
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByText("synthetic-notification-webhook-secret-for-github"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit webhook secret" }).click();
  await expect(editor.locator("input")).toHaveValue("");
});

for (const width of [1280, 390]) {
  test(`automatic maintainer notifications separate saved summary from modal editor and support personal overrides at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, {
      autoRepositories: [{ id: 7001, full_name: "example/workspace" }],
    });
    await f.open();
    const maintainerRegion = page.getByRole("region", {
      name: "Automatic maintainer notifications",
    });
    await expect(maintainerRegion).toContainText("Enabled");
    await expect(maintainerRegion).toContainText(
      "Verified GitHub Maintain and Admin members",
    );
    await expect(maintainerRegion.locator("input,select,form")).toHaveCount(0);
    const subRegion = page.getByRole("region", {
      name: "Personal repository notifications",
    });
    await expect(subRegion).toContainText("Automatic (Maintainer)");
    await expect(subRegion).not.toContainText("No subscriptions yet");
    await page.screenshot({
      path: `/tmp/repodesk-notifications-maintainer-${width}.png`,
      fullPage: true,
    });
    // Pause an auto-notified repository directly -> creates a paused personal override.
    await subRegion.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(subRegion).toContainText("Paused");
    await expect(subRegion).not.toContainText("Automatic (Maintainer)");
    // Delete the override -> returns to Automatic (Maintainer).
    await page
      .getByRole("button", { name: "Delete example/workspace" })
      .click();
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete subscription",
    });
    await expect(deleteDialog).toContainText("automatic maintainer alerts");
    await deleteDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(subRegion).toContainText("Automatic (Maintainer)");
    // Edit workspace maintainer setting through its modal.
    await page
      .getByRole("button", { name: "Edit maintainer notifications" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit maintainer notifications",
      exact: true,
    });
    await editor
      .getByRole("checkbox", {
        name: "Automatically notify repository maintainers",
      })
      .uncheck();
    f.controls.error = "version_conflict";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("settings changed");
    await expect(
      editor.getByRole("checkbox", {
        name: "Automatically notify repository maintainers",
      }),
    ).not.toBeChecked();
    f.controls.error = "";
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    release();
    await expect(editor).not.toBeVisible();
    await expect(maintainerRegion).toContainText("Disabled");
    await expect(subRegion).toContainText("No subscriptions yet");
    await page.screenshot({
      path: `/tmp/repodesk-notifications-maintainer-disabled-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
