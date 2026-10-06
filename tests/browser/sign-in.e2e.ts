import { expect, type Route, test } from "@playwright/test";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const session = {
  admin: { id: "operator", username: "fixture", operator: true },
  csrf: "test",
};

for (const width of [1280, 390]) {
  test(`sign-in keeps its form and loading button until home is ready at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const held: Route[] = [];
    let signingIn = false;
    let attempts = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/auth/login") {
        signingIn = true;
        attempts++;
        held.push(route);
        return;
      }
      if (
        signingIn &&
        ["/api/admin/auth/session", "/api/admin/workspaces"].includes(path)
      ) {
        held.push(route);
        return;
      }
      if (path === "/api/admin/auth/session") {
        await route.fulfill({ status: 401, json: { error: "unauthorized" } });
        return;
      }
      await route.fulfill({
        json:
          path === "/api/setup/status"
            ? { initialized: true }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Sign-in fixture" }]
              : {},
      });
    });
    await page.goto("/admin");
    await page.getByLabel("Username").fill("fixture");
    await page.getByLabel("Password").fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    const button = page.getByRole("button", { name: "Signing in…" });
    const expectPendingForm = async () => {
      await expect(
        page.getByRole("heading", { name: "Welcome back" }),
      ).toBeVisible();
      await expect(page.getByLabel("Username")).toHaveValue("fixture");
      await expect(page.getByLabel("Password")).toHaveValue("fixture-password");
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button.locator("svg")).toBeVisible();
      await expect(page.locator(".app-loading")).toHaveCount(0);
    };
    await expect.poll(() => held.length).toBe(1);
    await expectPendingForm();
    await page.locator(".auth-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
    });
    expect(attempts).toBe(1);
    await page.screenshot({
      path: test.info().outputPath("signing-in.png"),
      fullPage: true,
    });

    await held.shift()?.fulfill({ json: { csrf: "test" } });
    await expect.poll(() => held.length).toBe(1);
    await expectPendingForm();
    await held.shift()?.fulfill({ json: session });
    await expect.poll(() => held.length).toBe(1);
    await expectPendingForm();
    signingIn = false;
    await held.shift()?.fulfill({
      json: [{ id: workspaceId, name: "Sign-in fixture" }],
    });
    await expect(
      page.getByRole("heading", { name: "Your team, in view", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".auth-form")).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin$/);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  });
}

for (const failure of ["login", "session", "workspaces"]) {
  test(`sign-in preserves credentials and allows retry after ${failure} fails`, async ({
    page,
  }) => {
    let signingIn = false;
    let fail = true;
    const held: Route[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/auth/login") signingIn = true;
      if (path === "/api/admin/auth/session" && !signingIn) {
        await route.fulfill({ status: 401, json: { error: "unauthorized" } });
        return;
      }
      if (
        signingIn &&
        path ===
          `/api/admin/${failure === "workspaces" ? failure : `auth/${failure}`}`
      ) {
        if (fail) {
          fail = false;
          await route.fulfill({
            status: 503,
            json: { error: "Please try again" },
          });
        } else {
          held.push(route);
        }
        return;
      }
      await route.fulfill({
        json: path === "/api/setup/status" ? { initialized: true } : session,
      });
    });
    await page.goto("/admin");
    await page.getByLabel("Username").fill("fixture");
    await page.getByLabel("Password").fill("fixture-password");
    const button = page.getByRole("button", { name: "Sign in", exact: true });
    await button.click();
    await expect(page.getByRole("alert")).toHaveText("Please try again");
    await expect(button).toBeEnabled();
    await expect(page.getByLabel("Username")).toHaveValue("fixture");
    await expect(page.getByLabel("Password")).toHaveValue("fixture-password");
    await button.click();
    await expect.poll(() => held.length).toBe(1);
    await expect(page.getByText("Please try again")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Signing in…" }),
    ).toBeDisabled();
  });
}
