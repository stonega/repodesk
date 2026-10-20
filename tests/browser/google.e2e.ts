import { expect, type Page, test } from "@playwright/test";
import {
  type GooglePage,
  type GooglePlugin,
  googleDefinitions,
  googlePlugins,
} from "../../src/google/config.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function fixture(page: Page, connected = true) {
  const pages = Object.fromEntries(
    googlePlugins.map((plugin) => [
      plugin,
      {
        revision: 1,
        settings: { enabled: connected },
        clientId: connected ? `${plugin}.apps.googleusercontent.com` : "",
        clientSecretConfigured: connected,
        redirectUri: `https://admin.example.test/api/admin/google/${plugin}/callback`,
        scope: googleDefinitions[plugin].scope,
        status: connected ? "connected" : "not_connected",
        account: connected
          ? "fixture-with-a-long-account-name@example.test"
          : undefined,
      },
    ]),
  ) as Record<GooglePlugin, GooglePage>;
  const writes: { plugin: GooglePlugin; body: Record<string, unknown> }[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
    connectError: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match =
      /\/plugins\/google\/(google-docs|google-sheets|google-drive|gmail)(\/(connect|disconnect))?$/.exec(
        path,
      );
    if (match) {
      const plugin = match[1] as GooglePlugin;
      const data = pages[plugin];
      if (match[3] === "connect") {
        await controls.pending;
        await route.fulfill(
          controls.connectError
            ? { status: 409, json: { error: controls.connectError } }
            : {
                json: {
                  url: `https://accounts.google.com/o/oauth2/v2/auth?state=fixture-${plugin}`,
                },
              },
        );
        return;
      }
      if (match[3] === "disconnect") {
        data.status = "not_connected";
        data.account = undefined;
        data.settings.enabled = false;
        data.revision++;
      } else if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push({ plugin, body });
        await controls.pending;
        if (controls.failure) {
          await route.fulfill({
            status: 409,
            json: { error: controls.failure },
          });
          return;
        }
        data.revision++;
        data.settings = body.settings;
        if (body.clientId) data.clientId = body.clientId;
        if (body.clientSecret) {
          data.clientSecretConfigured = true;
          data.status = "not_connected";
          data.account = undefined;
          data.settings.enabled = false;
        }
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
              ? [{ id: workspace, name: "Google fixture" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 1,
                    source: "empty",
                    entries: [],
                    workspaces: [{ id: workspace, name: "Google fixture" }],
                    audit: [],
                  }
                : { providers: [] },
    });
  });
  return {
    pages,
    writes,
    controls,
    open: (plugin: GooglePlugin) =>
      page.goto(`/admin/plugins/${plugin}?workspace=${workspace}`),
  };
}
for (const width of [1280, 390]) {
  for (const plugin of googlePlugins) {
    const name = googleDefinitions[plugin].name;
    test(`${name} saved display and separate modal at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 950 });
      const f = await fixture(page);
      await f.open(plugin);
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toHaveCount(1);
      const card = page.getByRole("region", {
        name: `${name} connection`,
        exact: true,
      });
      await expect(card).toContainText("Connected");
      await expect(card).toContainText(f.pages[plugin].account ?? "");
      await expect(card.locator("input,textarea,select")).toHaveCount(0);
      const edit = page.getByRole("button", {
        name: `Edit ${name} connection`,
      });
      await expectTopRightAction(card, edit);
      await expect(
        page.getByRole("switch", { name: `Enable ${name}` }),
      ).toBeChecked();
      await page.screenshot({
        path: test.info().outputPath("saved-light.png"),
        fullPage: true,
      });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await page.screenshot({
        path: test.info().outputPath("saved-dark.png"),
        fullPage: true,
      });
      await edit.click();
      const dialog = page.getByRole("dialog", {
        name: `Edit ${name} connection`,
      });
      await expect(dialog.getByLabel("Replace client secret")).toHaveValue("");
      await page.screenshot({
        path: test.info().outputPath("editor-dark.png"),
        fullPage: true,
      });
      await expect(dialog).toContainText(f.pages[plugin].redirectUri);
      await dialog
        .getByLabel("Client ID", { exact: true })
        .fill("discarded.apps.googleusercontent.com");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
      expect(f.writes).toHaveLength(0);
      await edit.click();
      await expect(dialog.getByLabel("Client ID", { exact: true })).toHaveValue(
        f.pages[plugin].clientId,
      );
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(f.writes[0]?.body).not.toHaveProperty("clientSecret");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const spacing = await page
        .locator(".google-summary-card")
        .evaluateAll((cards) =>
          cards.flatMap((card) => {
            const box = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            const first = card.firstElementChild?.getBoundingClientRect();
            const last = card.lastElementChild?.getBoundingClientRect();
            return first && last
              ? [
                  first.top -
                    box.top -
                    parseFloat(style.borderTopWidth) -
                    parseFloat(style.paddingTop),
                  box.bottom -
                    last.bottom -
                    parseFloat(style.borderBottomWidth) -
                    parseFloat(style.paddingBottom),
                ]
              : [Infinity];
          }),
        );
      for (const gap of spacing) expect(Math.abs(gap)).toBeLessThan(1);
    });
  }
  test(`Google first setup, pending locks and failed-save draft preservation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, false);
    await f.open("gmail");
    const card = page.getByRole("region", {
      name: "Gmail connection",
      exact: true,
    });
    await expect(card).toContainText("Not connected");
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await page.getByRole("switch", { name: "Enable Gmail" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Gmail connection" });
    await expect(
      dialog.getByRole("button", { name: "Connect Google account" }),
    ).toBeDisabled();
    await dialog
      .getByLabel("Client ID", { exact: true })
      .fill("gmail.apps.googleusercontent.com");
    await dialog
      .getByLabel("Client secret", { exact: true })
      .fill("fixture-secret");
    f.controls.failure = "version_conflict";
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("another session");
    await expect(
      dialog.getByLabel("Client secret", { exact: true }),
    ).toHaveValue("fixture-secret");
    await page.screenshot({
      path: test.info().outputPath("save-error.png"),
      fullPage: true,
    });
    f.controls.failure = "";
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("another session");
    await page
      .getByRole("button", { name: "Reload Gmail settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Gmail connection", exact: true })
      .click();
    await dialog
      .getByLabel("Client ID", { exact: true })
      .fill("gmail.apps.googleusercontent.com");
    await dialog
      .getByLabel("Client secret", { exact: true })
      .fill("fixture-secret");
    let release!: () => void;
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Saving…", exact: true }),
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
    await expect(
      page.getByRole("switch", { name: "Enable Gmail" }),
    ).not.toBeChecked();
    await expect(card).toContainText("Configured");
    await page.getByRole("button", { name: "Edit Gmail connection" }).click();
    f.controls.connectError = "google_reconnect_required";
    await dialog
      .getByRole("button", { name: "Connect Google account" })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Reconnect your Google account",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  test(`Google initial loading, retry and independent catalog entries at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let release!: () => void;
    f.controls.loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open("google-docs");
    await expect(
      page.getByRole("heading", { name: "Google Docs", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit Google Docs connection" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Google Docs connection", exact: true }),
    ).not.toContainText("Not connected");
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.controls.loadError = "google_credentials_unavailable";
    release();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    await page
      .getByRole("button", { name: "Reload Google Docs settings" })
      .click();
    await expect(
      page.getByRole("region", { name: "Google Docs connection", exact: true }),
    ).toContainText("Connected");
    await page
      .getByRole("link", { name: "Plugins", exact: true })
      .first()
      .click();
    for (const plugin of googlePlugins)
      await expect(
        page
          .getByRole("link", {
            name: new RegExp(googleDefinitions[plugin].name),
          })
          .last(),
      ).toBeVisible();
    await page.getByRole("link", { name: "Open Gmail", exact: true }).click();
    await page.getByRole("switch", { name: "Enable Gmail" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Gmail" }),
    ).not.toBeChecked();
    expect(f.pages["google-docs"].settings.enabled).toBe(true);
    expect(f.pages["google-sheets"].settings.enabled).toBe(true);
  });
  test(`Google disconnect clears only its local connection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open("gmail");
    await page.getByRole("button", { name: "Edit Gmail connection" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Connect Google account" }),
    ).toBeEnabled();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Gmail connection", exact: true }),
    ).toContainText("Not connected");
    expect(f.pages["google-docs"].status).toBe("connected");
  });
}
test("Google connect follows the server's Google consent URL", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open("gmail");
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Fixture consent" }),
  );
  await page.getByRole("button", { name: "Edit Gmail connection" }).click();
  await page.getByRole("button", { name: "Reconnect Google account" }).click();
  await expect(page).toHaveURL(/accounts\.google\.com.*state=fixture-gmail/);
});
