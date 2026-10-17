import { expect, type Page, test } from "@playwright/test";
import type { CloudflarePage } from "../../src/cloudflare/config.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const endpoint = `/api/admin/workspaces/${workspace}/plugins/cloudflare`;
async function fixture(page: Page, empty = false) {
  const data: CloudflarePage = {
    revision: 1,
    settings: {
      enabled: !empty,
      accountId: empty ? "" : accountId,
      zoneIds: empty ? [] : [zoneId],
    },
    tokenConfigured: !empty,
  };
  const writes: Record<string, unknown>[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    loadError: "",
    saveError: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await controls.pending;
        if (controls.saveError) {
          await route.fulfill({
            status: 409,
            json: { error: controls.saveError },
          });
          return;
        }
        data.revision++;
        data.settings = body.settings;
        if (body.apiToken) data.tokenConfigured = true;
        if (body.removeToken) data.tokenConfigured = false;
      } else {
        await controls.loading;
        if (controls.loadError) {
          await route.fulfill({
            status: 503,
            json: { error: controls.loadError },
          });
          return;
        }
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
              ? [{ id: workspace, name: "Cloudflare fixture" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 1,
                    source: "panel",
                    entries: [],
                    workspaces: [],
                    audit: [],
                  }
                : /\/plugins\/(code-truth|coding|review-bot)$/.test(path)
                  ? { settings: { enabled: false } }
                  : { providers: [] },
    });
  });
  return {
    data,
    writes,
    controls,
    open: () => page.goto(`/admin/plugins/cloudflare?workspace=${workspace}`),
  };
}
const card = (page: Page) =>
  page.getByRole("region", { name: "Cloudflare configuration", exact: true });
const dialog = (page: Page) =>
  page.getByRole("dialog", {
    name: "Edit Cloudflare configuration",
    exact: true,
  });
for (const width of [1280, 390]) {
  test(`Cloudflare saved summary, modal cancel, save, token replacement and removal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open();
    await expect(card(page)).toContainText(accountId);
    await expect(card(page)).toContainText(zoneId);
    await expect(card(page).getByRole("textbox")).toHaveCount(0);
    await expect(
      page.getByLabel("Enable Cloudflare", { exact: true }),
    ).toBeChecked();
    const titleBox = await card(page)
      .getByRole("heading", { name: "Configuration", exact: true })
      .boundingBox();
    const editBox = await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .boundingBox();
    expect(
      titleBox &&
        editBox &&
        editBox.y < titleBox.y + 44 &&
        editBox.x > titleBox.x,
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("saved.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await expect(
      dialog(page).getByLabel("Account ID", { exact: true }),
    ).toHaveValue(accountId);
    await expect(
      dialog(page).getByLabel("Replace API token", { exact: true }),
    ).toHaveValue("");
    await dialog(page)
      .getByLabel("Account ID", { exact: true })
      .fill("c".repeat(32));
    await dialog(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect(f.writes).toHaveLength(0);
    await expect(card(page)).toContainText(accountId);
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await dialog(page)
      .getByLabel("Allowed zone IDs", { exact: true })
      .fill(`${zoneId}\n${"d".repeat(32)}`);
    await dialog(page).screenshot({
      path: test.info().outputPath("editor.png"),
    });
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    expect(f.writes[0]).not.toHaveProperty("apiToken");
    await page.reload();
    await expect(card(page)).toContainText("d".repeat(32));
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await dialog(page)
      .getByLabel("Replace API token", { exact: true })
      .fill("fixture-replacement-token-12345");
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    expect(f.writes[1]?.apiToken).toBe("fixture-replacement-token-12345");
    await expect(page.locator("body")).not.toContainText(
      "fixture-replacement-token-12345",
    );
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await dialog(page)
      .getByLabel("Remove saved token and disable Cloudflare", { exact: true })
      .check();
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page)).toContainText("Not configured");
    await expect(
      page.getByLabel("Enable Cloudflare", { exact: true }),
    ).not.toBeChecked();
    expect(f.writes[2]?.removeToken).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`Cloudflare empty setup and locked pending save at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    await f.open();
    await expect(card(page)).toContainText("No zones selected");
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await page.getByLabel("Enable Cloudflare", { exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page)
      .getByLabel("Account ID", { exact: true })
      .fill(accountId);
    await dialog(page)
      .getByLabel("API token", { exact: true })
      .fill("fixture-cloudflare-token-12345");
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      dialog(page).getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog(page).getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog(page).getByRole("button", {
        name: "Close Edit Cloudflare configuration",
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    await dialog(page).screenshot({
      path: test.info().outputPath("pending.png"),
    });
    release();
    await expect(dialog(page)).toHaveCount(0);
    expect(f.writes).toHaveLength(1);
    await expect(card(page)).toContainText("Configured");
  });
  test(`Cloudflare loading, request recovery and failed editor preserves draft at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let release = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open();
    await expect(card(page)).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByRole("heading", { name: "Queries and actions" }),
    ).toBeVisible();
    await expect(card(page)).not.toContainText("Not configured");
    await expect(
      page.getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.controls.loadError = "cloudflare_credentials_unavailable";
    release();
    await expect(page.getByRole("alert")).toContainText("credential storage");
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    await page.getByRole("button", { name: "Reload saved settings" }).click();
    await expect(card(page)).toContainText(accountId);
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await dialog(page)
      .getByLabel("Allowed zone IDs", { exact: true })
      .fill("e".repeat(32));
    f.controls.saveError = "version_conflict";
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "another session",
    );
    await expect(
      dialog(page).getByLabel("Allowed zone IDs", { exact: true }),
    ).toHaveValue("e".repeat(32));
    await expect(card(page)).toContainText(zoneId);
    await dialog(page).screenshot({
      path: test.info().outputPath("save-error.png"),
    });
    await dialog(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Reload saved settings" }),
    ).toBeVisible();
    f.controls.saveError = "";
    await page.getByRole("button", { name: "Reload saved settings" }).click();
    await expect(card(page)).toContainText(zoneId);
  });
  test(`Cloudflare catalog link and dark saved/editor appearance at ${width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 950 });
    await fixture(page);
    await page.goto(`/admin/plugins?workspace=${workspace}`);
    const link = page.getByRole("link", {
      name: "Open Cloudflare",
      exact: true,
    });
    await expect(link).toContainText("Enabled");
    await link.click();
    await expect(
      page.getByRole("heading", { name: "Cloudflare", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: test.info().outputPath("saved-dark.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    await dialog(page).screenshot({
      path: test.info().outputPath("editor-dark.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });
}
