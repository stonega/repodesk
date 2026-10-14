import { expect, type Page, type Route, test } from "@playwright/test";

async function fixture(
  page: Page,
  state: { active: boolean; operator?: boolean },
  progress?: (route: Route) => Promise<void>,
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/setup/progress" && progress) {
      await progress(route);
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: {
                  id: "fixture",
                  username: "stone",
                  operator: state.operator ?? true,
                },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: "workspace", name: "Main workspace" }]
              : path === "/api/setup/progress"
                ? {
                    version: 1,
                    active: state.active,
                    paused: true,
                    credentials: { bot: true, model: true },
                    workspaces: [],
                  }
                : path === "/api/admin/operator/logs"
                  ? { items: [], retentionDays: 7, maxEntries: 10000 }
                  : {},
    });
  });
}

async function openNavigation(page: Page, width: number) {
  if (width <= 800)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Site domain" })).toBeVisible();
}

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const active of [false, true]) {
      test(`setup entry reflects ${active ? "complete" : "incomplete"} deployment at ${width}px in ${colorScheme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await fixture(page, { active });
        const checked = page.waitForResponse("**/api/setup/progress");
        await page.goto("/admin/logs");
        await checked;
        await openNavigation(page, width);
        const setup = page.getByRole("link", { name: "Setup", exact: true });
        if (active) await expect(setup).toHaveCount(0);
        else await expect(setup).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Model settings" }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Operations", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Runtime logs", exact: true }),
        ).toBeVisible();
        await expect(page.locator("body")).toHaveJSProperty(
          "scrollWidth",
          width,
        );
        await page.screenshot({
          path: info.outputPath("setup-navigation.png"),
          fullPage: true,
        });
        if (active) {
          await page
            .getByRole("button", { name: "Workspace", exact: true })
            .click();
          await page.getByRole("menuitem", { name: "New workspace" }).click();
          await expect(page).toHaveURL(/\/setup\?new=1&step=workspace$/);
          await expect(
            page.getByRole("heading", { name: "Set up a new workspace" }),
          ).toBeVisible();
        } else {
          await setup.click();
          await expect(page).toHaveURL(/\/setup$/);
          await expect(
            page.getByRole("heading", { name: "Set up your team assistant" }),
          ).toBeVisible();
        }
      });
    }
  }

  test(`setup stays hidden during unknown or failed status and updates after navigation at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const held: Route[] = [];
    await fixture(page, { active: true }, async (route) => {
      held.push(route);
    });
    await page.goto("/admin/logs");
    await expect.poll(() => held.length).toBe(1);
    await openNavigation(page, width);
    const setup = page.getByRole("link", { name: "Setup", exact: true });
    await expect(setup).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("status-pending.png") });
    await held
      .shift()
      ?.fulfill({ status: 503, json: { error: "unavailable" } });
    await expect(setup).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("status-failed.png") });

    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Main workspace" }).click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { active: false } });
    await openNavigation(page, width);
    await expect(setup).toBeVisible();

    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Main workspace" }).click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { active: true } });
    await openNavigation(page, width);
    await expect(setup).toHaveCount(0);
  });
}

test("ordinary members do not request operator setup progress", async ({
  page,
}) => {
  let requests = 0;
  await fixture(page, { active: false, operator: false }, async (route) => {
    requests++;
    await route.fulfill({ status: 403, json: { error: "access_denied" } });
  });
  await page.goto("/admin/logs");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Setup", exact: true }),
  ).toHaveCount(0);
  expect(requests).toBe(0);
});
