import { expect, test } from "@playwright/test";
import { fixture } from "./cloudflare-fixture.ts";
import { chooseOption } from "./dropdown-helpers.ts";

for (const width of [1280, 390]) {
  test(`Token named account/domain choices preserve saved display and drafts at ${width}px`, async ({
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
      path: test.info().outputPath("token-named-domains.png"),
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
      path: test.info().outputPath("token-domains-pending.png"),
    });
    release();
    await expect(editor.getByRole("alert")).toContainText("another session");
    await expect(
      editor.getByRole("checkbox", { name: "another.example", exact: true }),
    ).toBeChecked();
    await editor.screenshot({
      path: test.info().outputPath("token-domains-save-error.png"),
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
      path: test.info().outputPath("token-named-summary.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`Token multi-account setup asks for account choice and supports Pages only at ${width}px`, async ({
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
    await f.open();
    await page
      .getByRole("button", { name: "Edit Cloudflare configuration" })
      .click();
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
      path: test.info().outputPath("token-account-choice.png"),
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
  test(`Token discovery paginates named choices and clears domains on account change at ${width}px`, async ({
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
  test(`Token inventory loading, failure recovery and empty domains at ${width}px`, async ({
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
      path: test.info().outputPath("token-inventory-loading-dark.png"),
    });
    f.controls.inventoryFailure = "cloudflare_access_denied";
    release();
    await expect(editor.getByRole("alert").first()).toContainText(
      "denied access",
    );
    await editor.screenshot({
      path: test.info().outputPath("token-inventory-error-dark.png"),
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
      path: test.info().outputPath("token-inventory-empty-dark.png"),
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
  });
}
