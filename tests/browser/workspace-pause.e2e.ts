import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/settings`;

async function fixture(page: Page, paused = false) {
  const data = {
    version: 3,
    settings: settingsSchema.parse({
      name: "Pause fixture",
      timezone: "Asia/Taipei",
      paused,
    }),
  };
  const writes: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint && route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      writes.push(input);
      data.settings = input.settings;
      data.version++;
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
              ? [{ id: workspaceId, name: data.settings.name }]
              : path.endsWith("/overview")
                ? { ...data, counts: { members: 0, runs: 0, workflows: 0 } }
                : path === endpoint
                  ? data
                  : {},
    });
  });
  await page.goto(`/admin/settings?workspace=${workspaceId}`);
  return { data, writes };
}

for (const width of [1280, 390]) {
  test(`pause requires confirmation and preserves configuration at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { data, writes } = await fixture(page);
    const original = { ...data.settings };
    const activity = page.getByRole("region", { name: "Workspace activity" });
    const pause = activity.getByRole("button", { name: "Pause workspace" });
    await expect(activity).toContainText("Active");
    const links = await page.locator("aside nav a").allTextContents();
    expect(links.indexOf("Settings")).toBe(links.indexOf("Plugins") + 1);
    await expect(
      page.getByRole("heading", { name: "Model capacity" }),
    ).toHaveCount(0);
    await pause.click();
    const dialog = page.getByRole("dialog", { name: "Pause workspace?" });
    await expect(dialog).toContainText("Pause fixture");
    await expect(dialog).toContainText("cancels queued or running");
    expect(writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pause).toBeFocused();
    expect(writes).toHaveLength(0);
    await pause.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await pause.click();
    await page.screenshot({
      path: test.info().outputPath("pause-confirmation.png"),
      fullPage: true,
    });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await dialog
      .getByRole("button", { name: "Pause workspace", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(activity).toContainText("Paused");
    await expect(page.getByRole("status")).toContainText("Workspace paused.");
    expect(writes).toEqual([
      { version: 3, settings: { ...original, paused: true } },
    ]);
    await page.reload();
    await expect(activity).toContainText("Paused");
    await activity.getByRole("button", { name: "Resume workspace" }).click();
    const resume = page.getByRole("dialog", { name: "Resume workspace?" });
    await expect(resume).toContainText("will not restart");
    await resume
      .getByRole("button", { name: "Resume workspace", exact: true })
      .click();
    await expect(activity).toContainText("Active");
    expect(writes[1]).toEqual({ version: 4, settings: original });
    await page.goto(`/admin/overview?workspace=${workspaceId}`);
    await page.getByRole("button", { name: "Edit team configuration" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Edit team configuration" })
        .getByLabel("Pause workspace"),
    ).toHaveCount(0);
  });
}

test("pending pause prevents dismissal and stale saves require renewed confirmation", async ({
  page,
}) => {
  const { data, writes } = await fixture(page);
  let held: Route | undefined;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    held = route;
  });
  await page
    .getByRole("button", { name: "Pause workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Pause workspace?" });
  await dialog
    .getByRole("button", { name: "Pause workspace", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Working…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!held).toBe(true);
  data.version = 4;
  data.settings.monthlyBudgetUsd = 25;
  await held?.fulfill({ status: 409, json: { error: "version_conflict" } });
  await expect(dialog.getByRole("alert")).toContainText("version_conflict");
  await expect(
    page.getByRole("region", { name: "Workspace activity" }),
  ).toContainText("Active");
  await dialog.getByRole("button", { name: "Reload current version" }).click();
  await expect(dialog).toHaveCount(0);
  await page.unroute(`**${endpoint}`);
  await page
    .getByRole("button", { name: "Pause workspace", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Pause workspace", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    { version: 4, settings: { ...data.settings, paused: true } },
  ]);
});
