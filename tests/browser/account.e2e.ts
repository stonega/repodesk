import { expect, type Page, test } from "@playwright/test";

async function fixture(page: Page, username = "stone") {
  let signedOut = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/auth/logout") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
      signedOut = true;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username, operator: true },
                csrf: "fixture-csrf",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: "fixture-workspace", name: "Theme preview" }]
              : {},
    });
  });
  return () => signedOut;
}

for (const width of [1280, 390]) {
  test(`account controls switch themes and keep logout working at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    const signedOut = await fixture(page);
    await page.goto("/admin");
    if (width <= 800)
      await page.getByRole("button", { name: "Open navigation" }).click();
    const account = page.locator(".account");
    await expect(account.getByText("stone", { exact: true })).toBeVisible();
    const darkSwitch = account.getByRole("button", {
      name: "Switch to dark theme",
    });
    await expect(darkSwitch).toBeVisible();
    await darkSwitch.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("aside")).toHaveCSS(
      "background-color",
      "rgb(25, 33, 43)",
    );
    await page.screenshot({
      path: test.info().outputPath("account-dark.png"),
      fullPage: true,
    });
    await page.reload();
    if (width <= 800)
      await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const lightSwitch = account.getByRole("button", {
      name: "Switch to light theme",
    });
    await lightSwitch.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("aside")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.screenshot({
      path: test.info().outputPath("account-light.png"),
      fullPage: true,
    });
    const identity = await account.locator("small").boundingBox();
    const logout = await account
      .getByRole("button", { name: "Sign out" })
      .boundingBox();
    const theme = await darkSwitch.boundingBox();
    expect(identity).not.toBeNull();
    expect(logout).not.toBeNull();
    expect(theme).not.toBeNull();
    if (!identity || !logout || !theme) throw Error("Missing account controls");
    expect(logout.x - (identity.x + identity.width)).toBeLessThanOrEqual(8);
    expect(theme.x).toBeGreaterThan(logout.x + logout.width);
    expect(logout.height).toBeGreaterThanOrEqual(44);
    expect(theme.height).toBeGreaterThanOrEqual(44);
    expect((await account.boundingBox())?.height).toBeLessThanOrEqual(52);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await account.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(signedOut).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
}

test("saved theme applies before the application bundle loads", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() =>
    localStorage.setItem("repodesk.theme", "dark"),
  );
  await page.route("**/assets/app.js?*", (route) => route.abort());
  await page.goto("/admin");
  await expect(page.locator("#root")).toBeEmpty();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#11171e",
  );
});

test("theme defaults to the system preference and works without browser storage", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });
  });
  await fixture(page);
  await page.goto("/admin");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("long account identities wrap without hiding either control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await fixture(page, "a-long-account-name-that-needs-to-wrap-in-the-sidebar");
  await page.goto("/admin");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to .* theme/ }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
});
