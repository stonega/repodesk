import { expect, type Page, type Route, test } from "@playwright/test";

async function fixture(page: Page, workspaces = true, operator = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: {
                  id: "fixture",
                  username: "stone",
                  operator,
                  telegramId: "123",
                },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? workspaces
                ? [
                    { id: "one", name: "Main workspace" },
                    { id: "two", name: "Second workspace" },
                  ]
                : []
              : path === "/api/admin/operator/health"
                ? {
                    workers: 1,
                    pending: 0,
                    oldest_seconds: 0,
                    failed_runs: 6,
                    unknown_deliveries: 0,
                    paused: false,
                    audit: [],
                  }
                : path === "/api/admin/operator/logs"
                  ? { items: [], retentionDays: 7, maxEntries: 10000 }
                  : path === "/api/setup/progress"
                    ? { workspaces: [], version: 1 }
                    : {},
    });
  });
}

for (const width of [320, 390, 800]) {
  test(`mobile navigation is a dismissible left sheet at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    await page.goto("/admin/operations");
    const trigger = page.getByRole("button", { name: "Open navigation" });
    const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
    const main = page.locator("main");
    const header = page.locator(".mobile-header");
    const version = page.locator(".app-version");
    await expect(trigger).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    const before = await main.boundingBox();
    expect(before?.y).toBe(64);
    const label = await version.boundingBox();
    expect(label?.y).toBe(0);
    expect((label?.x ?? 0) + (label?.width ?? 0)).toBeLessThanOrEqual(
      width - 12,
    );
    await page.screenshot({ path: info.outputPath("mobile-closed.png") });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(sheet).toBeVisible();
    const bounds = await sheet.boundingBox();
    expect(bounds?.x).toBe(0);
    expect(bounds?.y).toBe(0);
    expect(bounds?.height).toBe(844);
    expect(bounds?.width).toBeLessThanOrEqual(width - 48);
    expect(await main.boundingBox()).toEqual(before);
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    const close = sheet.getByRole("button", { name: "Close Navigation" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      sheet.getByRole("button", { name: /Switch to .* theme/ }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await sheet.locator("aside").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath("mobile-open.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.mouse.click(width - 10, 150);
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await close.click();
    await expect(sheet).toHaveCount(0);
    await trigger.click();
    await sheet.getByRole("link", { name: "Operations", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await trigger.click();
    await sheet.getByRole("button", { name: "Workspace", exact: true }).click();
    await sheet
      .getByRole("menuitemradio", { name: "Second workspace" })
      .click();
    await expect(page).toHaveURL(/workspace=two/);
    await expect(sheet).toHaveCount(0);
    await trigger.click();
    await expect(
      sheet.getByRole("button", { name: "Workspace", exact: true }),
    ).toContainText("Second workspace");
    await sheet
      .getByRole("link", { name: "Runtime logs", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/logs/);
    await expect(sheet).toHaveCount(0);
    await trigger.click();
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    await main.evaluate((node) => {
      node.style.minHeight = "1800px";
    });
    await page.evaluate(() => window.scrollTo(0, 500));
    expect((await header.boundingBox())?.y).toBe(0);
    expect((await version.boundingBox())?.y).toBe(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await trigger.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toHaveCount(0);
    await expect(page.locator("aside")).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    expect((await version.boundingBox())?.y).toBeGreaterThan(850);
    await page.setViewportSize({ width, height: 844 });
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
}

test("short-screen navigation scrolls to account controls and respects workspace permissions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await fixture(page, true, false);
  await page.goto("/admin/operations");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect(
    sheet.getByRole("link", { name: "Operations", exact: true }),
  ).toHaveCount(0);
  await expect(
    sheet.getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(
    sheet.getByRole("menuitem", { name: "New workspace" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", { name: "Sign out" })
    .scrollIntoViewIfNeeded();
  await expect(
    sheet.getByRole("button", { name: "Sign out" }),
  ).toBeInViewport();
  await expect(
    sheet.getByRole("button", { name: "Switch to light theme" }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("mobile-short-dark.png") });
});

test("empty workspaces retain deployment navigation and New opens setup", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, false);
  await page.goto("/admin/operations");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect(
    sheet.getByRole("link", { name: "Overview", exact: true }),
  ).toHaveCount(0);
  await expect(
    sheet.getByRole("link", { name: "Operations", exact: true }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("mobile-empty-workspaces.png"),
  });
  await sheet.getByRole("menuitem", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/setup\?new=1/);
  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveCount(0);
  await expect(page.locator(".app-version")).toHaveCSS("position", "static");
});

test("desktop keeps the persistent sidebar and bottom-right version", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  await page.goto("/admin/operations");
  await expect(page.locator("aside")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveCount(0);
  expect((await page.locator("main").boundingBox())?.x).toBe(248);
  expect((await page.locator(".app-version").boundingBox())?.y).toBeGreaterThan(
    850,
  );
  await page.screenshot({
    path: info.outputPath("desktop.png"),
    fullPage: true,
  });
});

for (const width of [1280, 390]) {
  test(`navigation remains usable during page loading and failure at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    let held: Route | undefined;
    await page.route("**/api/admin/operator/health", (route) => {
      held = route;
    });
    await page.goto("/admin/operations");
    await expect.poll(() => !!held).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Operations", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("page-loading.png") });
    await held?.fulfill({
      status: 503,
      json: { error: "Health check unavailable" },
    });
    await expect(page.getByRole("alert")).toContainText(
      "Health check unavailable",
    );
    await page.screenshot({ path: info.outputPath("page-error.png") });
    if (width <= 800)
      await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .locator("aside")
      .getByRole("link", { name: "Runtime logs", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Runtime logs", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Navigation", exact: true }),
    ).toHaveCount(0);
  });
}
