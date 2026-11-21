import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { PluginNotificationPage } from "../../src/plugins/notifications.ts";
import type { PackageCatalog } from "../../src/plugins/package-config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const base = `/api/admin/workspaces/${workspaceId}/plugin-packages`;
async function fixture(page: Page) {
  const events = [
    {
      name: "updated",
      title: "New item",
      description: "A newly observed item.",
    },
    {
      name: "alert",
      title: "Threshold alert",
      description: "An observed threshold.",
    },
  ];
  const data: PluginNotificationPage = {
    canManage: true,
    generation: 1,
    available: true,
    events,
  };
  const manifest = JSON.parse(
    readFileSync("examples/plugins/word-count/telo.plugin.json", "utf8"),
  );
  const catalog: PackageCatalog = {
    revision: 1,
    configured: true,
    runnerConfigured: true,
    members: [],
    chats: [],
    entries: [
      {
        manifest: {
          ...manifest,
          capabilities: ["notifications.publish"],
          notifications: events,
        },
        source: {
          repositoryId: 777,
          ownerId: 42,
          repository: "example/telo-word-count",
          ref: "v0.1.0",
          commit: "a".repeat(40),
          private: false,
        },
        digest: "b".repeat(64),
        bundleHash: "c".repeat(64),
        manifestHash: "d".repeat(64),
        generation: 1,
        enabled: true,
        settings: {},
        grants: ["notifications.publish"],
        history: [],
        connections: [],
      },
    ],
  };
  const controls = { error: "", pending: Promise.resolve() };
  const writes: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${base}/777/notifications`) {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        writes.push(input);
        await controls.pending;
        if (controls.error) {
          await route.fulfill({ status: 409, json: { error: controls.error } });
          return;
        }
        if (input.action === "delete") data.subscription = undefined;
        else if (input.action === "subscribe")
          data.subscription = {
            id: "subscription",
            actor: "101",
            repositoryId: 777,
            digest: "b".repeat(64),
            generation: 1,
            botId: "900",
            events: input.events,
            enabled: true,
            revision: (data.subscription?.revision ?? 0) + 1,
            since: new Date().toISOString(),
          };
        else if (data.subscription) {
          data.subscription.enabled = input.action === "resume";
          data.subscription.revision++;
        }
      }
      await route.fulfill({ json: data });
      return;
    }
    await route.fulfill({
      json:
        path === base
          ? catalog
          : path === "/api/setup/status"
            ? { initialized: true }
            : path === "/api/admin/auth/session"
              ? {
                  admin: {
                    id: "operator",
                    username: "fixture",
                    operator: true,
                    telegramId: "101",
                  },
                  csrf: "test",
                }
              : path === "/api/admin/workspaces"
                ? [{ id: workspaceId, name: "Plugin notifications" }]
                : { entries: [], providers: [] },
    });
  });
  return {
    data,
    controls,
    writes,
    open: () =>
      page.goto(`/admin/plugins/packages/777?workspace=${workspaceId}`),
  };
}
for (const width of [1280, 390]) {
  test(`plugin event subscriptions use private saved summaries and modal editing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const region = page.getByRole("region", {
      name: "Plugin notifications",
      exact: true,
    });
    await expect(region).toContainText("No personal subscription yet");
    await expect(region.locator("input,select,form")).toHaveCount(0);
    await region
      .getByRole("button", { name: "New plugin notification subscription" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "New plugin notification subscription",
    });
    await dialog.getByRole("checkbox", { name: /Threshold alert/ }).uncheck();
    f.controls.error = "notification_plugin_unavailable";
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: /Threshold alert/ }),
    ).not.toBeChecked();
    await page.screenshot({
      path: `/tmp/telo-plugin-notifications-error-${width}.png`,
      fullPage: true,
    });
    f.controls.error = "";
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog).not.toBeVisible();
    await expect(region).toContainText("Enabled");
    await expect(region.locator("input,select,form")).toHaveCount(0);
    await region.screenshot({
      path: `/tmp/telo-plugin-notifications-saved-${width}.png`,
    });
    await region
      .getByRole("button", { name: "Edit plugin notification subscription" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit plugin notification subscription",
    });
    await editor.getByRole("checkbox", { name: /Threshold alert/ }).check();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(region).not.toContainText("Threshold alert");
    await region.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(region).toContainText("Paused");
    await region.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(region).toContainText("Enabled");
    await region
      .getByRole("button", { name: "Delete plugin notification subscription" })
      .click();
    await page
      .getByRole("dialog", { name: "Delete plugin notification subscription" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(region).toContainText("No personal subscription yet");
    expect(f.writes.length).toBe(5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
test("plugin notifications require a verified personal identity", async ({
  page,
}) => {
  const f = await fixture(page);
  f.data.canManage = false;
  await f.open();
  const region = page.getByRole("region", {
    name: "Plugin notifications",
    exact: true,
  });
  await expect(region).toContainText("Link your Telegram identity");
  await expect(
    region.getByRole("button", {
      name: "New plugin notification subscription",
    }),
  ).toBeDisabled();
});

test("editing an older subscription drops event names removed by an upgrade", async ({
  page,
}) => {
  const f = await fixture(page);
  f.data.available = false;
  f.data.subscription = {
    id: "old",
    actor: "101",
    repositoryId: 777,
    digest: "a".repeat(64),
    generation: 0,
    botId: "900",
    events: ["removed_event"],
    enabled: true,
    revision: 1,
    since: new Date().toISOString(),
  };
  await f.open();
  const region = page.getByRole("region", {
    name: "Plugin notifications",
    exact: true,
  });
  await region
    .getByRole("button", { name: "Edit plugin notification subscription" })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Edit plugin notification subscription",
  });
  await expect(
    editor.getByRole("checkbox", { name: /New item/ }),
  ).not.toBeChecked();
  await editor.getByRole("checkbox", { name: /New item/ }).check();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(f.writes[0]).toMatchObject({
    action: "subscribe",
    events: ["updated"],
    generation: 1,
  });
});
