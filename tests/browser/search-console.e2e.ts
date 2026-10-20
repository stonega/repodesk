import { expect, type Page, test } from "@playwright/test";
import type { SearchConsolePage } from "../../src/search-console/config.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspace}/plugins/search-console`;
async function fixture(page: Page, connected = false) {
  const data: SearchConsolePage = {
    revision: 1,
    settings: {
      enabled: connected,
      siteUrls: connected ? ["sc-domain:example.com"] : [],
    },
    credentialConfigured: connected,
    email: connected ? "repodesk@fixture.iam.gserviceaccount.com" : undefined,
  };
  const writes: Record<string, unknown>[] = [];
  const control = {
    load: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
    propertiesError: "",
    items: [
      "sc-domain:example.com",
      "https://blog.example.com/",
      "sc-domain:averylongdomainname-used-for-mobile-layout.example.com",
    ],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${endpoint}/properties`) {
      await route.fulfill(
        control.propertiesError
          ? { status: 403, json: { error: control.propertiesError } }
          : {
              json: {
                items: control.items.map((siteUrl) => ({
                  siteUrl,
                  permissionLevel: "siteOwner",
                })),
              },
            },
      );
      return;
    }
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await control.pending;
        if (control.failure) {
          await route.fulfill({
            status: 409,
            json: { error: control.failure },
          });
          return;
        }
        data.revision++;
        data.settings = body.settings;
        if (body.serviceAccount) {
          data.credentialConfigured = true;
          data.email = "repodesk@fixture.iam.gserviceaccount.com";
          data.settings = { enabled: false, siteUrls: [] };
        }
        if (body.removeCredential) {
          data.credentialConfigured = false;
          delete data.email;
          data.settings = { enabled: false, siteUrls: [] };
        }
      } else {
        await control.load;
        if (control.loadError) {
          await route.fulfill({
            status: 503,
            json: { error: control.loadError },
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
              ? [{ id: workspace, name: "Search Console fixture" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 1,
                    source: "empty",
                    entries: [],
                    workspaces: [
                      { id: workspace, name: "Search Console fixture" },
                    ],
                    audit: [],
                  }
                : { settings: { enabled: false }, providers: [] },
    });
  });
  return {
    data,
    writes,
    control,
    open: () =>
      page.goto(`/admin/plugins/search-console?workspace=${workspace}`),
  };
}
for (const width of [1280, 390]) {
  test(`Search Console setup, saved summary and modal selection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open();
    const auth = page.getByRole("region", {
      name: "Search Console authorization",
    });
    const properties = page.getByRole("region", {
      name: "Search Console properties",
      exact: true,
    });
    await expect(auth).toContainText("Not configured");
    await expect(auth.locator("input, textarea, select")).toHaveCount(0);
    await expect(properties.locator("input, textarea, select")).toHaveCount(0);
    const edit = page.getByRole("button", {
      name: "Edit Search Console service account",
    });
    await expectTopRightAction(auth, edit);
    await expect(
      page.getByRole("button", { name: "Edit Search Console properties" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await edit.click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Service account JSON").fill("fixture-json");
    await page.screenshot({
      path: test.info().outputPath("credential.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(page.getByLabel("Service account JSON")).toHaveValue("");
    await page.getByLabel("Service account JSON").fill("fixture-json");
    await dialog
      .getByRole("button", { name: "Save service account", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Edit Search Console properties",
    });
    await expect(dialog.getByRole("checkbox")).toHaveCount(3);
    await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(
      0,
    );
    await dialog.getByLabel("Search properties").fill("blog");
    await expect(dialog.getByRole("checkbox")).toHaveCount(1);
    await dialog
      .getByRole("checkbox", { name: "https://blog.example.com/", exact: true })
      .check();
    await dialog.getByLabel("Search properties").fill("");
    await page.screenshot({
      path: test.info().outputPath("properties.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Save properties", exact: true })
      .click();
    await expect(properties).toContainText("https://blog.example.com/");
    const toggle = page.getByRole("switch", {
      name: "Enable Google Search Console",
    });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.screenshot({
      path: test.info().outputPath("saved.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator(".plugin-back-link").click();
    await expect(
      page.getByRole("link", {
        name: "Open Google Search Console",
      }),
    ).toBeVisible();
    expect(f.writes).toHaveLength(3);
  });
  test(`Search Console retains failed drafts and locks pending saves at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    await f.open();
    await page
      .getByRole("button", { name: "Edit Search Console properties" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", { name: "https://blog.example.com/", exact: true })
      .check();
    f.control.failure = "version_conflict";
    await dialog
      .getByRole("button", { name: "Save properties", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("another session");
    await expect(
      dialog.getByRole("checkbox", {
        name: "https://blog.example.com/",
        exact: true,
      }),
    ).toBeChecked();
    await page.screenshot({
      path: test.info().outputPath("save-error.png"),
      fullPage: true,
    });
    f.control.failure = "";
    let release = () => {};
    f.control.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await dialog
      .getByRole("button", { name: "Save properties", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("pending.png"),
      fullPage: true,
    });
    release();
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toHaveLength(2);
  });
  test(`Search Console loading, failure, discovery recovery and removal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    let release = () => {};
    f.control.load = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open();
    const auth = page.getByRole("region", {
      name: "Search Console authorization",
    });
    await expect(auth).toBeVisible();
    await expect(auth).not.toContainText("Not configured");
    await expect(
      page.getByRole("button", { name: "Edit Search Console service account" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.control.loadError = "search_console_unavailable";
    release();
    await expect(page.getByRole("alert")).toContainText("could not be reached");
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.control.loadError = "";
    await page
      .getByRole("button", { name: "Reload saved Search Console settings" })
      .click();
    await expect(auth).toContainText("Configured");
    f.control.propertiesError = "search_console_access_denied";
    await page
      .getByRole("button", { name: "Edit Search Console properties" })
      .click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText(
      "Google denied access",
    );
    f.control.propertiesError = "";
    await dialog
      .getByRole("button", { name: "Retry loading properties" })
      .click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit Search Console service account" })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Service account JSON")).toHaveValue("");
    await dialog
      .getByRole("checkbox", {
        name: "Remove saved credentials and disable Google Search Console",
      })
      .check();
    await dialog
      .getByRole("button", { name: "Save service account", exact: true })
      .click();
    await expect(auth).toContainText("Not configured");
    await expect(page.getByRole("switch")).not.toBeChecked();
  });
}
