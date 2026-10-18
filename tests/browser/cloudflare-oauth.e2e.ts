import { expect, type Page, test } from "@playwright/test";
import type {
  CloudflarePage,
  CloudflareResource,
} from "../../src/cloudflare/config.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspace}/plugins/cloudflare`;
async function fixture(page: Page, connected = false) {
  const data: CloudflarePage = {
    revision: 1,
    settings: {
      enabled: connected,
      accountId: connected ? "a".repeat(32) : "",
      zoneIds: connected ? ["b".repeat(32)] : [],
      authMethod: "oauth",
    },
    resources: connected
      ? {
          account: { id: "a".repeat(32), name: "Fixture account" },
          zones: [{ id: "b".repeat(32), name: "example.com" }],
        }
      : undefined,
    tokenConfigured: false,
    oauth: {
      clientId: connected ? "fixture-client" : "",
      scopes: connected ? ["account.read"] : [],
      clientSecretConfigured: connected,
      redirectUri: "https://repodesk.example/api/admin/cloudflare/callback",
      status: connected ? "connected" : "not_connected",
      ...(connected ? { expiresAt: "2026-12-01T12:00:00Z" } : {}),
    },
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    revocationConfirmed: true,
    accounts: [
      { id: "a".repeat(32), name: "Fixture account" },
    ] as CloudflareResource[],
    zones: [
      { id: "b".repeat(32), name: "example.com" },
      { id: "c".repeat(32), name: "another.example" },
    ] as CloudflareResource[],
    inventoryPending: Promise.resolve(),
    inventoryFailure: "",
  };
  await page.route(
    "https://dash.cloudflare.com/oauth2/auth**",
    async (route) => {
      data.revision++;
      data.settings.enabled = true;
      data.settings.accountId = "a".repeat(32);
      data.resources = { account: controls.accounts[0], zones: [] };
      if (data.oauth) {
        data.oauth.status = "connected";
        data.oauth.expiresAt = "2026-12-01T12:00:00Z";
      }
      await route.fulfill({
        contentType: "text/html",
        body: "<h1>Cloudflare consent fixture</h1>",
      });
    },
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${endpoint}/oauth/resources`) {
      const body = route.request().postDataJSON();
      await controls.inventoryPending;
      if (controls.inventoryFailure) {
        await route.fulfill({
          status: 403,
          json: { error: controls.inventoryFailure },
        });
        return;
      }
      const items =
        body.resource === "accounts" ? controls.accounts : controls.zones;
      await route.fulfill({
        json: {
          items: items.slice((body.page - 1) * 50, body.page * 50),
          page: body.page,
          hasMore: body.page * 50 < items.length,
        },
      });
      return;
    }
    if (path.startsWith(endpoint)) {
      if (route.request().method() !== "GET") {
        const body = route.request().postDataJSON();
        writes.push({ path, body });
        await controls.pending;
        if (controls.failure) {
          await route.fulfill({
            status: 409,
            json: { error: controls.failure },
          });
          return;
        }
        if (path.endsWith("/connect")) {
          await route.fulfill({
            json: {
              url: "https://dash.cloudflare.com/oauth2/auth?client_id=fixture-client&response_type=code&state=fixture-state&code_challenge_method=S256",
            },
          });
          return;
        }
        if (path.endsWith("/disconnect")) {
          if (data.oauth) data.oauth.status = "not_connected";
          if (data.oauth) delete data.oauth.expiresAt;
          data.settings.enabled = false;
          data.revision++;
        } else {
          data.settings = body.settings;
          if (data.oauth?.status === "connected")
            data.resources = {
              account: controls.accounts.find(
                (item) => item.id === data.settings.accountId,
              ),
              zones: controls.zones.filter((item) =>
                data.settings.zoneIds.includes(item.id),
              ),
            };
          data.revision++;
          if (body.oauthClient && data.oauth) {
            data.oauth.clientId = body.oauthClient.clientId;
            data.oauth.scopes = body.oauthClient.scopes;
            data.oauth.clientSecretConfigured =
              !!body.oauthClient.clientSecret ||
              data.oauth.clientSecretConfigured;
          }
        }
      } else await controls.loading;
      await route.fulfill({
        json: {
          ...data,
          ...(path.endsWith("/disconnect")
            ? { revocationConfirmed: controls.revocationConfirmed }
            : {}),
        },
      });
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
              ? [{ id: workspace, name: "Cloudflare OAuth fixture" }]
              : { providers: [] },
    });
  });
  return {
    data,
    controls,
    writes,
    open: (query = "") =>
      page.goto(`/admin/plugins/cloudflare?workspace=${workspace}${query}`),
  };
}
const authorization = (page: Page) =>
  page.getByRole("region", { name: "Cloudflare authorization", exact: true });
for (const width of [1280, 390]) {
  test(`OAuth setup has saved summaries, modal credentials, consent navigation and callback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open();
    await expect(authorization(page)).toContainText("Not configured");
    await expect(authorization(page).getByRole("textbox")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Connect Cloudflare", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("oauth-empty.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Edit Cloudflare configuration",
        exact: true,
      })
      .click();
    const resources = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
      exact: true,
    });
    await expect(
      resources.getByRole("combobox", { name: "Authentication" }),
    ).toContainText("Cloudflare authorization");
    await expect(
      resources.getByLabel("API token", { exact: true }),
    ).toHaveCount(0);
    await expect(
      resources.getByLabel("Enable Cloudflare", { exact: true }),
    ).toHaveCount(0);
    await resources.screenshot({
      path: test.info().outputPath("oauth-resources-editor.png"),
    });
    await resources
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Cloudflare OAuth application" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare OAuth application",
    });
    await expect(editor).toContainText(f.data.oauth?.redirectUri ?? "");
    await editor
      .getByLabel("Client ID", { exact: true })
      .fill("discarded-client");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(0);
    await page
      .getByRole("button", { name: "Edit Cloudflare OAuth application" })
      .click();
    await editor
      .getByLabel("Client ID", { exact: true })
      .fill("fixture-client");
    await editor
      .getByLabel("Client secret", { exact: true })
      .fill("fixture-secret-server-only");
    await expect(
      editor.getByLabel("API scope IDs", { exact: true }),
    ).toHaveValue("account.read");
    await editor.screenshot({
      path: test.info().outputPath("oauth-editor.png"),
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(authorization(page)).toContainText("fixture-client");
    await expect(page.locator("body")).not.toContainText(
      "fixture-secret-server-only",
    );
    await page
      .getByRole("button", { name: "Edit Cloudflare OAuth application" })
      .click();
    await expect(
      editor.getByLabel("Client secret", { exact: true }),
    ).toHaveValue("");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Connect Cloudflare", exact: true })
      .click();
    await expect(page).toHaveURL(
      /^https:\/\/dash\.cloudflare\.com\/oauth2\/auth/,
    );
    await expect(
      page.getByRole("heading", { name: "Cloudflare consent fixture" }),
    ).toBeVisible();
    await f.open("&cloudflare=connected");
    await expect(authorization(page)).toContainText("Connected");
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).toBeChecked();
    await page.screenshot({
      path: test.info().outputPath("oauth-connected.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`OAuth named account/domain choices preserve saved display and drafts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    await f.open();
    const config = page.getByRole("region", {
      name: "Cloudflare configuration",
      exact: true,
    });
    await expect(config).toContainText("Fixture account");
    await expect(config).toContainText("example.com");
    await expect(config.getByRole("textbox")).toHaveCount(0);
    await expect(config.getByRole("checkbox")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await expect(editor.getByLabel("Account ID", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      editor.getByLabel("Allowed zone IDs", { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByRole("combobox", { name: "Account", exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByRole("checkbox", { name: "example.com", exact: true }),
    ).toBeChecked();
    await editor
      .getByRole("checkbox", { name: "another.example", exact: true })
      .check();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(0);
    await expect(config).not.toContainText("another.example");
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
    await expect(
      editor.getByRole("checkbox", { name: "another.example", exact: true }),
    ).not.toBeChecked();
    await editor.getByLabel("Search domains").fill("another");
    await editor
      .getByRole("checkbox", { name: "another.example", exact: true })
      .check();
    await editor.getByLabel("Search domains").fill("");
    await editor.screenshot({
      path: test.info().outputPath("oauth-named-domains.png"),
    });
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.failure = "version_conflict";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await editor.screenshot({
      path: test.info().outputPath("oauth-domains-pending.png"),
    });
    release();
    await expect(editor.getByRole("alert")).toContainText("another session");
    await expect(
      editor.getByRole("checkbox", { name: "another.example", exact: true }),
    ).toBeChecked();
    await editor.screenshot({
      path: test.info().outputPath("oauth-domains-save-error.png"),
    });
    f.controls.failure = "";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(config).toContainText("another.example");
    await page.getByRole("switch", { name: "Enable Cloudflare" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).not.toBeChecked();
    await page.getByRole("switch", { name: "Enable Cloudflare" }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).toBeChecked();
    await page.screenshot({
      path: test.info().outputPath("oauth-named-summary.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`OAuth multi-account callback asks only for account choice and supports Pages only at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    f.controls.accounts.push({ id: "d".repeat(32), name: "Second account" });
    f.data.settings = {
      ...f.data.settings,
      enabled: false,
      accountId: "",
      zoneIds: [],
    };
    f.data.resources = { zones: [] };
    await f.open("&cloudflare=connected");
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("region", {
        name: "Cloudflare configuration",
        exact: true,
      }),
    ).toContainText("Choose an account in Edit");
    await page.getByRole("switch", { name: "Enable Cloudflare" }).click();
    await expect(editor).toBeVisible();
    expect(f.writes).toHaveLength(0);
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await chooseOption(
      editor.getByRole("combobox", { name: "Account", exact: true }),
      "d".repeat(32),
    );
    await expect(
      editor.getByRole("checkbox", { name: "example.com", exact: true }),
    ).not.toBeChecked();
    await editor.screenshot({
      path: test.info().outputPath("oauth-account-choice.png"),
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: "Cloudflare configuration",
        exact: true,
      }),
    ).toContainText("Second account");
    await expect(
      page.getByRole("region", {
        name: "Cloudflare configuration",
        exact: true,
      }),
    ).toContainText("Pages only");
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).toBeChecked();
    expect(f.writes.at(-1)?.body.settings).toMatchObject({
      accountId: "d".repeat(32),
      zoneIds: [],
      enabled: true,
    });
  });
  test(`OAuth discovery paginates named choices and clears domains on account change at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    f.controls.accounts.push({ id: "d".repeat(32), name: "Second account" });
    f.controls.zones.push(
      ...Array.from({ length: 49 }, (_, i) => ({
        id: (i + 1).toString(16).padStart(32, "0"),
        name: `domain-${i}.example`,
      })),
    );
    await f.open();
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await editor
      .getByRole("button", { name: "More domains", exact: true })
      .click();
    await editor.getByLabel("Search domains").fill("domain-48");
    await editor
      .getByRole("checkbox", { name: "domain-48.example", exact: true })
      .check();
    await expect(editor).toContainText("2 of 20 domains selected");
    await chooseOption(
      editor.getByRole("combobox", { name: "Account", exact: true }),
      "d".repeat(32),
    );
    await expect(editor).toContainText("0 of 20 domains selected");
    await expect(editor.getByLabel("Search domains")).toHaveValue("");
    await expect(
      editor.getByRole("checkbox", { name: "example.com", exact: true }),
    ).not.toBeChecked();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(f.writes.at(-1)?.body.settings).toMatchObject({
      accountId: "d".repeat(32),
      zoneIds: [],
    });
  });
  test(`OAuth inventory loading, failure recovery and empty domains at ${width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    let release = () => {};
    f.controls.inventoryPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open();
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await expect(editor).toContainText("Allowed domains");
    await editor.screenshot({
      path: test.info().outputPath("oauth-inventory-loading-dark.png"),
    });
    f.controls.inventoryFailure = "cloudflare_access_denied";
    release();
    await expect(editor.getByRole("alert").first()).toContainText(
      "denied access",
    );
    await editor.screenshot({
      path: test.info().outputPath("oauth-inventory-error-dark.png"),
    });
    f.controls.inventoryFailure = "";
    f.controls.zones = [];
    await editor.getByRole("button", { name: "Retry", exact: true }).click();
    await editor
      .getByRole("button", { name: "Retry domains", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await expect(
      editor.getByRole("checkbox", { name: "example.com", exact: true }),
    ).toBeChecked();
    await editor
      .getByRole("checkbox", { name: "example.com", exact: true })
      .click();
    await expect(editor.getByRole("checkbox")).toHaveCount(0);
    await expect(editor).toContainText("No domains available");
    await editor.screenshot({
      path: test.info().outputPath("oauth-inventory-empty-dark.png"),
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
  });
  test(`OAuth loading, pending saves and recoverable errors preserve the correct state at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let loaded = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    await f.open();
    await expect(authorization(page)).toHaveAttribute("aria-busy", "true");
    await expect(authorization(page)).not.toContainText("Not connected");
    await page.screenshot({
      path: test.info().outputPath("oauth-loading.png"),
      fullPage: true,
    });
    loaded();
    await page
      .getByRole("button", { name: "Edit Cloudflare OAuth application" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare OAuth application",
    });
    await editor
      .getByLabel("Client ID", { exact: true })
      .fill("fixture-client");
    await editor
      .getByLabel("Client secret", { exact: true })
      .fill("fixture-secret-server-only");
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.failure = "version_conflict";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await editor.screenshot({
      path: test.info().outputPath("oauth-pending.png"),
    });
    release();
    await expect(editor.getByRole("alert")).toContainText("another session");
    await expect(editor.getByLabel("Client ID", { exact: true })).toHaveValue(
      "fixture-client",
    );
    await editor.screenshot({
      path: test.info().outputPath("oauth-save-error.png"),
    });
    f.controls.failure = "";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    f.controls.failure = "cloudflare_oauth_failed";
    await page
      .getByRole("button", { name: "Connect Cloudflare", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("authorization failed");
    await expect(authorization(page)).toContainText("Not connected");
    await page.screenshot({
      path: test.info().outputPath("oauth-connect-error.png"),
      fullPage: true,
    });
  });
  test(`OAuth reconnect and confirmed disconnect follow dark theme and preserve failures at ${width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    if (f.data.oauth) f.data.oauth.status = "reconnect_required";
    await f.open();
    await expect(authorization(page)).toContainText("Reconnect required");
    await expect(
      page.getByRole("button", { name: "Reconnect Cloudflare" }),
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("oauth-reconnect-dark.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Disconnect Cloudflare" });
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(0);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.failure = "version_conflict";
    await modal
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(
      modal.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    release();
    await expect(modal.getByRole("alert")).toContainText("another session");
    await modal.screenshot({
      path: test.info().outputPath("oauth-disconnect-error-dark.png"),
    });
    f.controls.failure = "";
    f.controls.revocationConfirmed = false;
    await modal
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(modal).toHaveCount(0);
    await expect(authorization(page)).toContainText("Not connected");
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).not.toBeChecked();
    await expect(page.getByRole("alert")).toContainText(
      "revocation could not be confirmed",
    );
    await page.screenshot({
      path: test.info().outputPath("oauth-disconnected-dark.png"),
      fullPage: true,
    });
  });
}
