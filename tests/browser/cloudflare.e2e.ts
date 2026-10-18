import { expect, test } from "@playwright/test";
import { fixture } from "./cloudflare-fixture.ts";

for (const width of [1280, 390]) {
  test(`Token setup opens resource choices without OAuth at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open();
    const auth = page.getByRole("region", { name: "Cloudflare authorization" });
    await expect(auth).toContainText("Not configured");
    await expect(auth.locator("input, textarea, select")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Connect Cloudflare|OAuth application/,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Edit Cloudflare configuration" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Edit Cloudflare API token" })
      .click();
    const token = page.getByRole("dialog", {
      name: "Edit Cloudflare API token",
    });
    await expect(token.getByLabel("Client ID")).toHaveCount(0);
    await expect(
      token.getByRole("link", { name: "Create an API token" }),
    ).toHaveAttribute("href", "https://dash.cloudflare.com/profile/api-tokens");
    await token
      .getByLabel("API token", { exact: true })
      .fill("fixture-direct-token-123456");
    await token.screenshot({
      path: test.info().outputPath("token-editor.png"),
    });
    await token.getByRole("button", { name: "Save", exact: true }).click();
    const resources = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await expect(resources).toBeVisible();
    await expect(resources).toContainText("Fixture account");
    await expect(
      resources.getByRole("checkbox", { name: "example.com", exact: true }),
    ).not.toBeChecked();
    await resources.getByRole("button", { name: "Save", exact: true }).click();
    await expect(resources).toHaveCount(0);
    expect(f.writes[0]?.body).toMatchObject({
      apiToken: "fixture-direct-token-123456",
      settings: { enabled: false, authMethod: "api_token" },
    });
    expect(f.writes[1]?.body).toMatchObject({
      verifyResources: true,
      settings: { enabled: true, accountId: "a".repeat(32), zoneIds: [] },
    });
    await expect(auth).toContainText("Configured");
    await expect(
      page.getByRole("region", { name: "Cloudflare configuration" }),
    ).toContainText("Pages only");
    await expect(page.locator("body")).not.toContainText(
      "fixture-direct-token-123456",
    );
    await page.screenshot({
      path: test.info().outputPath("saved.png"),
      fullPage: true,
    });
    const cardSpacing = await page
      .locator(".cloudflare-summary-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
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
    for (const gaps of cardSpacing)
      for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(1);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`Token cancellation, replacement, blank preservation and removal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    await f.open();
    const open = () =>
      page.getByRole("button", { name: "Edit Cloudflare API token" }).click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare API token",
    });
    await open();
    await expect(editor.getByLabel("Replace API token")).toHaveValue("");
    await editor
      .getByLabel("Replace API token")
      .fill("discarded-fixture-token-123");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(0);
    await open();
    await expect(editor.getByLabel("Replace API token")).toHaveValue("");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(f.writes[0]?.body).not.toHaveProperty("apiToken");
    await open();
    await editor
      .getByLabel("Replace API token")
      .fill("fixture-replacement-token-123");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Edit Cloudflare configuration" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Enable Cloudflare" }),
    ).not.toBeChecked();
    await open();
    await editor
      .getByLabel("Remove saved token and disable Cloudflare")
      .check();
    await expect(editor.getByLabel("Replace API token")).toBeDisabled();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(f.writes.at(-1)?.body).toMatchObject({
      removeToken: true,
      settings: { enabled: false },
    });
    await expect(
      page.getByRole("region", { name: "Cloudflare authorization" }),
    ).toContainText("Not configured");
  });
  test(`Token loading, pending, errors and legacy replacement at ${width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    f.data.settings.authMethod = "oauth";
    let loaded = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    await f.open();
    const auth = page.getByRole("region", { name: "Cloudflare authorization" });
    await expect(auth).toHaveAttribute("aria-busy", "true");
    await expect(auth).not.toContainText("Not configured");
    await page.screenshot({
      path: test.info().outputPath("loading-dark.png"),
      fullPage: true,
    });
    loaded();
    await page
      .getByRole("button", { name: "Edit Cloudflare API token" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare API token",
    });
    await expect(editor).toContainText(
      "replaces this workspace’s OAuth connection",
    );
    await editor
      .getByLabel("API token", { exact: true })
      .fill("fixture-token-draft-123456");
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.failure = "version_conflict";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByLabel("API token", { exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await editor.screenshot({
      path: test.info().outputPath("pending-dark.png"),
    });
    release();
    await expect(editor.getByRole("alert")).toContainText("another session");
    await expect(editor.getByLabel("API token", { exact: true })).toHaveValue(
      "fixture-token-draft-123456",
    );
    await editor.screenshot({ path: test.info().outputPath("error-dark.png") });
    f.controls.failure = "";
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Edit Cloudflare configuration" }),
    ).toBeVisible();
  });
  test(`Restricted tokens can use manual IDs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    f.controls.inventoryFailure = "cloudflare_access_denied";
    await f.open();
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit Cloudflare configuration",
    });
    await expect(editor.getByRole("alert").first()).toContainText(
      "User Memberships Read",
    );
    await editor.getByRole("button", { name: "Enter IDs manually" }).click();
    await editor.getByLabel("Account ID", { exact: true }).fill("c".repeat(32));
    await editor.getByLabel("Allowed zone IDs", { exact: true }).fill("");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(f.writes[0]?.body).not.toHaveProperty("verifyResources");
    expect(f.writes[0]?.body.settings).toMatchObject({
      accountId: "c".repeat(32),
      zoneIds: [],
    });
  });
  test(`Token page load failures recover without showing unknown state as saved at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page, true);
    f.controls.loadError = "cloudflare_credentials_unavailable";
    await f.open();
    await expect(page.getByRole("alert")).toContainText(
      "credential storage is unavailable",
    );
    await expect(
      page.getByRole("button", { name: "Edit Cloudflare API token" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    await page.getByRole("button", { name: "Reload saved settings" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Cloudflare authorization" }),
    ).toContainText("Configured");
    await expect(
      page.getByRole("button", { name: "Edit Cloudflare API token" }),
    ).toBeEnabled();
  });
}
