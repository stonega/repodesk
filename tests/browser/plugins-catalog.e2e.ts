import { expect, type Route, test } from "@playwright/test";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins`;

for (const width of [1280, 390]) {
  test(`Plugins hides Markets without leaving space at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const held: Route[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === endpoint) {
        held.push(route);
        return;
      }
      await route.fulfill({
        json:
          path === "/api/setup/status"
            ? { initialized: true }
            : path === "/api/admin/auth/session"
              ? {
                  admin: {
                    id: "operator",
                    username: "fixture",
                    operator: true,
                  },
                  csrf: "test",
                }
              : path === "/api/admin/workspaces"
                ? [{ id: workspaceId, name: "Plugins fixture" }]
                : { settings: { enabled: false } },
      });
    });
    const catalog = page.getByRole("region", {
      name: "Installed",
      exact: true,
    });
    const expectCatalog = async (state: string) => {
      await expect(catalog).toBeVisible();
      await expect(page.getByRole("heading", { name: "Markets" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("link", { name: /Pi catalog/ })).toHaveCount(
        0,
      );
      await expect(page.getByText(/Selection based on the/)).toHaveCount(0);
      await expect(page.locator('a[href*="/plugins/market/"]')).toHaveCount(0);
      await expect(
        catalog.getByRole("link", { name: "Open Code Truth" }),
      ).toBeVisible();
      await expect(
        catalog.getByRole("link", { name: "Open Codex" }),
      ).toBeVisible();
      await expect(catalog).toHaveCSS("margin-bottom", "0px");
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await page.screenshot({
          path: test.info().outputPath(`${state}-${theme}.png`),
          fullPage: true,
        });
      }
    };
    await page.goto(`/admin/plugins?workspace=${workspaceId}`);
    await expect.poll(() => held.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Add plugin" }),
    ).toBeDisabled();
    await expectCatalog("loading");
    await held
      .shift()
      ?.fulfill({ status: 503, json: { error: "fixture_unavailable" } });
    await expect(page.getByRole("alert")).toContainText("fixture_unavailable");
    await expectCatalog("error");
    await page
      .getByRole("button", { name: "Retry loading saved plugins" })
      .click();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({ json: { revision: 1, entries: [] } });
    await expect(
      page.getByRole("button", { name: "Add plugin" }),
    ).toBeEnabled();
    await expect(catalog.getByRole("link")).toHaveCount(7);
    await expect(
      catalog.getByRole("link", { name: "Open Qwen3-ASR" }),
    ).toBeVisible();
    await expectCatalog("empty");
    await page.reload();
    await expect.poll(() => held.length).toBe(1);
    await held.shift()?.fulfill({
      json: { revision: 1, entries: [{ id: "word-count", enabled: true }] },
    });
    await expect(
      catalog.getByRole("link", { name: "Open word-count" }),
    ).toBeVisible();
    await expectCatalog("saved");
  });
}
