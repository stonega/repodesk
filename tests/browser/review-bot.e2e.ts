import { expect, type Page, test } from "@playwright/test";
import type { ReviewPage } from "../../src/review-bot/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/review-bot`;
async function fixture(page: Page, delay = false) {
  const data: ReviewPage = {
    revision: 1,
    settings: { enabled: false, repositories: [] },
    botHandle: "repodesk[bot]",
    webhookUrl: "https://repodesk.example/github/webhook/operator",
    webhookConfigured: true,
    repositories: [
      {
        id: 7001,
        full_name: "example/workspace",
        maintainers: [{ id: "101", name: "Alice" }],
      },
      {
        id: 7002,
        full_name: "example/second",
        maintainers: [{ id: "101", name: "Alice" }],
      },
    ],
    tasks: [],
  };
  const writes: unknown[] = [];
  const failures = { save: "" };
  let release: () => void = () => {};
  const wait = delay
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (failures.save) {
          await route.fulfill({ status: 409, json: { error: failures.save } });
          return;
        }
        data.settings = body.settings;
        data.revision++;
      } else await wait;
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
              ? [{ id: workspaceId, name: "Review fixture" }]
              : {},
    });
  });
  await page.goto(`/admin/plugins/review-bot?workspace=${workspaceId}`);
  return { data, writes, release, failures };
}
for (const width of [1280, 390])
  test(`Review Bot selects repositories and saves independent policies at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await expect(
      page.getByRole("heading", { name: "Review Bot", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("@repodesk[bot]", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Repository", exact: true }),
    ).toHaveValue("example/workspace");
    await page
      .getByRole("checkbox", {
        name: "Allow explicitly requested fixes to the same PR",
      })
      .check();
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toEqual({
      revision: 1,
      settings: {
        enabled: false,
        repositories: [
          {
            repositoryId: 7001,
            reviewer: "101",
            autoReview: true,
            acceptRequests: true,
            allowFixes: true,
          },
        ],
      },
    });
    await page.getByRole("switch", { name: "Enable Review Bot" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Review Bot" }),
    ).toBeChecked();
    await expect.poll(() => f.writes.length).toBe(2);
    expect(f.data.settings.enabled).toBe(true);
    await page.screenshot({
      path: `/tmp/repodesk-review-bot-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
test("Review Bot keeps its structure visible while configuration loads", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await expect(
    page.getByRole("heading", { name: "Review Bot", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "GitHub webhook configuration" }),
  ).toBeVisible();
  f.release();
  await expect(
    page.getByRole("switch", { name: "Enable Review Bot" }),
  ).toBeVisible();
});

for (const width of [1280, 390])
  test(`Review Bot errors use recoverable toasts without shifting the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const f = await fixture(page);
    const toggle = page.getByRole("switch", { name: "Enable Review Bot" });
    await expect(toggle).toBeEnabled();
    const webhook = page.getByRole("heading", {
      name: "GitHub webhook",
      exact: true,
    });
    const position = await webhook.boundingBox();
    f.failures.save = "review_webhook_required";
    await toggle.click();
    const toast = page.getByRole("region", {
      name: "Notification",
      exact: true,
    });
    await expect(toast.getByRole("alert")).toHaveText(
      "Configure the GitHub webhook first.",
    );
    await expect(toast).toHaveCSS("position", "fixed");
    await expect(toast).toHaveClass(/toast-error/);
    await expect(toggle).not.toBeChecked();
    await expect(page.locator(".notice[role='alert']")).toHaveCount(0);
    expect(await webhook.boundingBox()).toEqual(position);
    const bounds = await toast.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.clock.fastForward(7000);
    await expect(toast).toBeVisible();
    await page.screenshot({
      path: `/tmp/repodesk-error-toast-${width}.png`,
      fullPage: true,
    });
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    await toggle.click();
    await expect(toast.getByRole("alert")).toHaveText(
      "Configure the GitHub webhook first.",
    );
    await toast.getByRole("button", { name: "Reload saved settings" }).click();
    await expect(toast).toHaveCount(0);
    f.failures.save = "";
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(toast.getByRole("status")).toHaveText(
      "Review Bot settings saved.",
    );
    await page.clock.fastForward(6001);
    await expect(toast).toHaveCount(0);
  });
