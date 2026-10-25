import { expect, type Page, test } from "@playwright/test";
import { type GooglePage, googleScopes } from "../../src/google/config.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function expectApiGuide(page: Page) {
  const guide = page.getByRole("region", {
    name: "Google API setup",
    exact: true,
  });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(
    "project that owns the Web application OAuth",
  );
  await expect(guide).toContainText("Google sign-in and consent do not enable");
  await expect(guide).toContainText("SERVICE_DISABLED");
  await expect(guide).toContainText("accessNotConfigured");
  await expect(guide).toContainText("wait a few minutes");
  await expect(guide).toContainText("/google properties");
  await expect(guide).toContainText("Reconnecting alone will not fix");
  await expect(guide.locator("input,textarea,select,button")).toHaveCount(0);
  for (const [name, service] of [
    ["Google Docs API", "docs.googleapis.com"],
    ["Google Sheets API", "sheets.googleapis.com"],
    ["Google Drive API", "drive.googleapis.com"],
    ["Gmail API", "gmail.googleapis.com"],
    ["Google Search Console API", "searchconsole.googleapis.com"],
  ]) {
    const link = guide.getByRole("link", { name: `${name} ↗`, exact: true });
    await expect(link).toHaveAttribute(
      "href",
      `https://console.cloud.google.com/apis/library/${service}`,
    );
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  return guide;
}
async function fixture(page: Page, connected = true) {
  const pages = {
    google: {
      revision: 1,
      settings: { enabled: connected },
      clientId: connected ? "shared.apps.googleusercontent.com" : "",
      clientSecretConfigured: connected,
      redirectUri: "https://admin.example.test/api/admin/google/callback",
      scope: googleScopes.join(" "),
    },
  } as { google: GooglePage };
  const writes: { plugin: "google"; body: Record<string, unknown> }[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/plugins/google")) {
      const data = pages.google;
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push({ plugin: "google", body });
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
        if (body.clientSecret) data.clientSecretConfigured = true;
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
  test(`Google application summary, modal and copy controls at ${width}px`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open("google");
    const card = page.getByRole("region", {
      name: "Google application",
      exact: true,
    });
    const edit = page.getByRole("button", { name: "Edit Google application" });
    await expect(card).toContainText("shared.apps.googleusercontent.com");
    await expect(card).toContainText("Each member connects their own account");
    await expectApiGuide(page);
    await expect(card.locator("input,textarea,select")).toHaveCount(0);
    await expectTopRightAction(card, edit);
    await expect(
      page.getByRole("button", {
        name: /Connect.*Google|Disconnect|Edit Search Console/,
      }),
    ).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`summary-${theme}.png`),
        fullPage: true,
      });
      await (await expectApiGuide(page)).screenshot({
        path: test.info().outputPath(`api-guide-${theme}.png`),
      });
      await edit.click();
      const dialog = page.getByRole("dialog", {
        name: "Edit Google application",
      });
      await expect(dialog.getByLabel("Replace client secret")).toHaveValue("");
      await expect(
        dialog.getByRole("button", { name: /Connect.*Google|Disconnect/ }),
      ).toHaveCount(0);
      await expect(dialog).toContainText("confirms the account there");
      await expect(dialog).toContainText(
        "Read-only access to Docs, Sheets, Drive, Gmail and Search Console.",
      );
      const scopes = dialog.locator(".google-oauth-scopes");
      const disclosure = scopes.locator("summary");
      await expect(disclosure).toHaveText("OAuth scopes");
      await expect(scopes).not.toHaveAttribute("open");
      for (const scope of googleScopes)
        await expect(dialog.getByText(scope, { exact: true })).toBeHidden();
      await expect(
        dialog.getByRole("button", { name: "Copy Callback URL", exact: true }),
      ).toBeVisible();
      await dialog.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: test.info().outputPath(`editor-collapsed-${theme}.png`),
        fullPage: true,
      });
      await dialog.getByLabel("Replace client secret").fill("draft-secret");
      const values = [
        ["Callback URL", f.pages.google.redirectUri],
        ...googleScopes.map((scope) => ["Read scope", scope]),
      ] as const;
      for (const [index, [label, value]] of values.entries()) {
        if (index === 1) {
          const box = await disclosure.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          await disclosure.focus();
          await page.keyboard.press("Enter");
          await expect(scopes).toHaveAttribute("open");
        }
        const row = dialog.locator(".service-url").filter({ hasText: value });
        const copy = row.getByRole("button", {
          name: `Copy ${label}`,
          exact: true,
        });
        const box = await copy.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
        await copy.focus();
        await page.keyboard.press("Enter");
        await expect(
          row.getByRole("button", { name: `Copied ${label}`, exact: true }),
        ).toBeDisabled();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          value,
        );
        await expect(copy).toBeEnabled();
      }
      expect(
        await dialog
          .locator(".google-connection-details")
          .evaluateAll((rows) =>
            rows.every((el) => el.scrollWidth <= el.clientWidth),
          ),
      ).toBe(true);
      await dialog.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: test.info().outputPath(`editor-expanded-${theme}.png`),
        fullPage: true,
      });
      await disclosure.focus();
      await page.keyboard.press("Space");
      await expect(scopes).not.toHaveAttribute("open");
      for (const scope of googleScopes)
        await expect(dialog.getByText(scope, { exact: true })).toBeHidden();
      await expect(dialog.getByLabel("Replace client secret")).toHaveValue(
        "draft-secret",
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
    }
    expect(f.writes).toHaveLength(0);
    const spacing = await page
      .locator(".google-summary-card")
      .evaluateAll((cards) =>
        cards.flatMap((card) => {
          const box = card.getBoundingClientRect(),
            style = getComputedStyle(card),
            first = card.firstElementChild?.getBoundingClientRect(),
            last = card.lastElementChild?.getBoundingClientRect();
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
    for (const gap of spacing) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`Google first setup, errors, pending save and enable without a personal account at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, false);
    await f.open("google");
    const card = page.getByRole("region", {
      name: "Google application",
      exact: true,
    });
    await expect(card).toContainText("Not configured");
    await expectApiGuide(page);
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await page.getByRole("switch", { name: "Enable Google" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Google application",
    });
    await dialog
      .getByLabel("Client ID", { exact: true })
      .fill("google.apps.googleusercontent.com");
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
    let release = () => {};
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
    await expect(
      dialog.getByLabel("Client ID", { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByLabel("Client secret", { exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("pending.png"),
      fullPage: true,
    });
    release();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText("Configured");
    await page.getByRole("switch", { name: "Enable Google" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Google" }),
    ).toBeChecked();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Edit Google application" }).click();
    await expect(dialog.getByLabel("Replace client secret")).toHaveValue("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(f.writes.at(-1)?.body).not.toHaveProperty("clientSecret");
  });
  test(`Google loading, retry and legacy Web client reuse at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let release = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open("google");
    await expect(
      page.getByRole("heading", { name: "Web application" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit Google application" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Google application", exact: true }),
    ).not.toContainText("Not configured");
    await expectApiGuide(page);
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.controls.loadError = "google_credentials_unavailable";
    release();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    await expectApiGuide(page);
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    f.pages.google.legacy = true;
    await page.getByRole("button", { name: "Reload Google settings" }).click();
    await expect(
      page.getByRole("region", { name: "Google application", exact: true }),
    ).toContainText("Web application client can be reused");
    await page.getByRole("button", { name: "Edit Google application" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Google application",
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.writes[0]?.body).not.toHaveProperty("clientSecret");
  });
  test(`Google copy failure keeps manual recovery and drafts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open("google");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw Error("denied");
          },
        },
      });
    });
    await page.getByRole("button", { name: "Edit Google application" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Google application",
    });
    await dialog.getByLabel("Replace client secret").fill("draft-secret");
    await dialog
      .getByRole("button", { name: "Copy Callback URL", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("Select the URL");
    await expect(dialog.getByLabel("Replace client secret")).toHaveValue(
      "draft-secret",
    );
    const scopes = dialog.locator(".google-oauth-scopes");
    await scopes.locator("summary").click();
    const scopeRow = scopes
      .locator(".service-url")
      .filter({ hasText: googleScopes[0] });
    await scopeRow.getByRole("button", { name: "Copy Read scope" }).click();
    await expect(scopeRow.getByRole("alert")).toContainText("Select the URL");
    await expect(dialog.getByLabel("Replace client secret")).toHaveValue(
      "draft-secret",
    );
    expect(f.writes).toHaveLength(0);
    await page.screenshot({
      path: test.info().outputPath("copy-failure.png"),
      fullPage: true,
    });
  });
  test(`Google catalog and old product routes lead to application setup at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    for (const old of [
      "google-docs",
      "google-sheets",
      "google-drive",
      "gmail",
      "search-console",
    ]) {
      await page.goto(`/admin/plugins/${old}?workspace=${workspace}`);
      await expect(
        page.getByRole("heading", { name: "Google", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Edit Search Console properties" }),
      ).toHaveCount(0);
    }
    await page
      .getByRole("link", { name: "Plugins", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("link", { name: "Open Google", exact: true }),
    ).toHaveCount(1);
    expect(f.writes).toHaveLength(0);
  });
}
