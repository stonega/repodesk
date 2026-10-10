import { expect, type Route, test } from "@playwright/test";

test("mobile sign-out locks the sheet while pending and keeps failures recoverable", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let logout: Route | undefined;
  let posts = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/auth/logout") {
      posts++;
      logout = route;
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "stone", operator: true },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: "one", name: "Main workspace" }]
              : path === "/api/setup/progress"
                ? { workspaces: [], version: 1 }
                : {},
    });
  });
  await page.goto("/admin/operations");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
  const signOut = sheet.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await expect(sheet).toHaveAttribute("aria-busy", "true");
  await expect(signOut).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "Close Navigation" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(380, 150);
  await expect(sheet).toBeVisible();
  await page.screenshot({
    path: info.outputPath("navigation-pending-mobile.png"),
  });
  expect(posts).toBe(1);
  await logout?.fulfill({
    status: 503,
    json: { error: "Sign-out unavailable. Try again." },
  });
  await expect(sheet.getByRole("alert")).toContainText("Sign-out unavailable");
  await expect(signOut).toBeEnabled();
  await sheet.getByRole("alert").scrollIntoViewIfNeeded();
  expect(
    (await sheet.locator(".account small").boundingBox())?.height,
  ).toBeLessThanOrEqual(24);
  await page.screenshot({
    path: info.outputPath("navigation-error-mobile.png"),
  });
  await expect(sheet.locator("aside")).toHaveJSProperty(
    "scrollWidth",
    await sheet.locator("aside").evaluate((node) => node.clientWidth),
  );
  await signOut.click();
  await expect.poll(() => posts).toBe(2);
  await logout?.fulfill({ json: {} });
  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.locator(".app-version")).toHaveCSS("position", "static");
  await page.screenshot({
    path: info.outputPath("signed-out-mobile.png"),
    fullPage: true,
  });
});
