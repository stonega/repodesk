import { expect, type Page, test } from "@playwright/test";
import { type GooglePage, googleScopes } from "../../src/google/config.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function fixture(page: Page, connected = true) {
  const pages = {
    google: {
      revision: 1,
      settings: { enabled: connected },
      clientId: connected ? "shared.apps.googleusercontent.com" : "",
      clientSecretConfigured: connected,
      redirectUri: "https://admin.example.test/api/admin/google/callback",
      scope: googleScopes.join(" "),
      status: connected ? "connected" : "not_connected",
      account: connected
        ? "fixture-with-a-long-account-name@example.test"
        : undefined,
      siteUrls: connected ? ["sc-domain:example.test"] : [],
    },
  } as { google: GooglePage };
  const writes: { plugin: "google"; body: Record<string, unknown> }[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
    connectError: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = /\/plugins\/(google)(\/(connect|disconnect))?$/.exec(path);
    if (match) {
      const plugin = match[1] as "google";
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
        data.legacy = false;
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
    open: (plugin: "google") =>
      page.goto(`/admin/plugins/${plugin}?workspace=${workspace}`),
  };
}
for (const width of [1280, 390]) {
  for (const plugin of ["google"] as const) {
    const name = "Google";
    test(`${name} saved display and separate modal at ${width}px`, async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
      for (const [label, value] of [
        ["Callback URL", f.pages[plugin].redirectUri],
        ["Read scope", googleScopes[0]],
      ]) {
        const copy = dialog
          .getByRole("button", {
            name: `Copy ${label}`,
            exact: true,
          })
          .first();
        const box = await copy.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
        await copy.focus();
        await page.keyboard.press("Enter");
        await expect(
          dialog
            .getByRole("button", { name: `Copied ${label}`, exact: true })
            .first(),
        ).toBeDisabled();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          value,
        );
        await expect(copy).toBeEnabled();
      }
      expect(f.writes).toHaveLength(0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        const contained = await dialog
          .locator(".google-connection-details")
          .evaluate((details) => details.scrollWidth <= details.clientWidth);
        expect(contained).toBe(true);
        await page.screenshot({
          path: test.info().outputPath(`copy-editor-${theme}.png`),
          fullPage: true,
        });
      }
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
  test(`Google copy failure preserves the editor and allows retry at ${width}px`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, false);
    await f.open("google");
    await page.getByRole("button", { name: "Edit Google connection" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Google connection" });
    await dialog
      .getByLabel("Client ID", { exact: true })
      .fill("draft.apps.googleusercontent.com");
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new DOMException("Clipboard denied", "NotAllowedError");
        },
      });
    });
    await dialog.getByRole("button", { name: "Copy Callback URL" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Could not copy. Select the URL to copy it manually.",
    );
    await expect(dialog.getByLabel("Client ID", { exact: true })).toHaveValue(
      "draft.apps.googleusercontent.com",
    );
    await expect(dialog.locator("code").first()).toHaveText(
      f.pages.google.redirectUri,
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`copy-error-${theme}.png`),
        fullPage: true,
      });
    }
    await page.evaluate(() => {
      delete (navigator.clipboard as Partial<Clipboard>).writeText;
    });
    await dialog.getByRole("button", { name: "Copy Callback URL" }).click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      f.pages.google.redirectUri,
    );
    expect(f.writes).toHaveLength(0);
  });
  test(`Google first setup, pending locks and failed-save draft preservation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, false);
    await f.open("google");
    const card = page.getByRole("region", {
      name: "Google connection",
      exact: true,
    });
    await expect(card).toContainText("Not connected");
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await page.getByRole("switch", { name: "Enable Google" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Google connection" });
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
      .getByRole("button", { name: "Reload Google settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Google connection", exact: true })
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
      page.getByRole("switch", { name: "Enable Google" }),
    ).not.toBeChecked();
    await expect(card).toContainText("Configured");
    await page.getByRole("button", { name: "Edit Google connection" }).click();
    f.controls.connectError = "google_reconnect_required";
    await dialog
      .getByRole("button", { name: "Connect Google account" })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Reconnect your Google account",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  test(`Google initial loading, retry and single catalog entry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let release!: () => void;
    f.controls.loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open("google");
    await expect(
      page.getByRole("heading", { name: "Google", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit Google connection" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Google connection", exact: true }),
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
    await page.getByRole("button", { name: "Reload Google settings" }).click();
    await expect(
      page.getByRole("region", { name: "Google connection", exact: true }),
    ).toContainText("Connected");
    await page
      .getByRole("link", { name: "Plugins", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("link", { name: "Open Google", exact: true }),
    ).toHaveCount(1);
    for (const old of [
      "Google Docs",
      "Google Sheets",
      "Google Drive",
      "Gmail",
      "Google Search Console",
    ])
      await expect(
        page.getByRole("link", { name: `Open ${old}`, exact: true }),
      ).toHaveCount(0);
    await page.getByRole("link", { name: "Open Google", exact: true }).click();
    await page.getByRole("switch", { name: "Enable Google" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Google" }),
    ).not.toBeChecked();
    expect(f.pages.google.settings.enabled).toBe(false);
  });
  test(`Google reuses the registered client but requires consent after merging at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, false);
    Object.assign(f.pages.google, {
      legacy: true,
      clientId: "existing.apps.googleusercontent.com",
      clientSecretConfigured: true,
    });
    await f.open("google");
    await expect(
      page.getByRole("region", { name: "Google connection", exact: true }),
    ).toContainText("existing Web application client can be reused");
    await page.getByRole("button", { name: "Edit Google connection" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Client ID", { exact: true })).toHaveValue(
      "existing.apps.googleusercontent.com",
    );
    await expect(
      dialog.getByRole("button", { name: "Connect Google account" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(f.writes[0]?.body).not.toHaveProperty("clientSecret");
    await page.getByRole("button", { name: "Edit Google connection" }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Connect Google account" }),
    ).toBeEnabled();
  });
  test(`Google disconnect disables the shared connection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open("google");
    await page.getByRole("button", { name: "Edit Google connection" }).click();
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
      page.getByRole("region", { name: "Google connection", exact: true }),
    ).toContainText("Not connected");
    expect(f.pages.google.status).toBe("not_connected");
  });
}
test("Google connect follows the server's Google consent URL", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open("google");
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Fixture consent" }),
  );
  await page.getByRole("button", { name: "Edit Google connection" }).click();
  await page.getByRole("button", { name: "Reconnect Google account" }).click();
  await expect(page).toHaveURL(/accounts\.google\.com.*state=fixture-google/);
});
