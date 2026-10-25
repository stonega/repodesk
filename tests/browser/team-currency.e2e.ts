import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/settings`;
async function fixture(page: Page) {
  const loads: Route[] = [];
  const saves: Route[] = [];
  const saved = {
    version: 1,
    settings: settingsSchema.parse({
      name: "Currency team",
      timezone: "Asia/Taipei",
      runBudgetUsd: 12,
    }),
  };
  let holdLoads = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        saves.push(route);
        return;
      }
      if (holdLoads) {
        loads.push(route);
        return;
      }
      return route.fulfill({ json: saved });
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: saved.settings.name }]
            : {};
    await route.fulfill({ json });
  });
  await page.goto(`/admin/settings?workspace=${workspaceId}`);
  await expect.poll(() => loads.length).toBe(1);
  return {
    loads,
    saves,
    saved,
    releaseLoads: () => {
      holdLoads = false;
    },
  };
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`team currency has saved display, modal editing and recovery at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const f = await fixture(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const card = page.getByRole("region", {
        name: "Team currency",
        exact: true,
      });
      const edit = card.getByRole("button", { name: "Edit team currency" });
      const dialog = page.getByRole("dialog", {
        name: "Edit team currency",
        exact: true,
      });
      const currency = dialog.getByRole("combobox", {
        name: "Team currency",
        exact: true,
      });
      const save = dialog.getByRole("button", {
        name: "Save configuration",
        exact: true,
      });
      const checkCardLayout = async () => {
        const bounds = await card.boundingBox();
        const editBounds = await edit.boundingBox();
        const lastBounds = await card
          .locator(":scope > p")
          .last()
          .boundingBox();
        const inset = await card.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            top:
              Number.parseFloat(style.paddingTop) +
              Number.parseFloat(style.borderTopWidth),
            right:
              Number.parseFloat(style.paddingRight) +
              Number.parseFloat(style.borderRightWidth),
            bottom:
              Number.parseFloat(style.paddingBottom) +
              Number.parseFloat(style.borderBottomWidth),
          };
        });
        if (!bounds || !editBounds || !lastBounds)
          throw Error("Card must be visible");
        // Content follows the card's responsive padding without extra margins.
        expect(
          Math.abs(
            bounds.x +
              bounds.width -
              editBounds.x -
              editBounds.width -
              inset.right,
          ),
        ).toBeLessThan(2);
        expect(Math.abs(editBounds.y - bounds.y - inset.top)).toBeLessThan(2);
        expect(
          Math.abs(
            bounds.y +
              bounds.height -
              lastBounds.y -
              lastBounds.height -
              inset.bottom,
          ),
        ).toBeLessThan(2);
      };
      await expect(
        card.getByRole("heading", { name: "Team currency" }),
      ).toBeVisible();
      await expect(edit).toBeDisabled();
      await expect(card.getByRole("combobox")).toHaveCount(0);
      await expect(card).toHaveAttribute("aria-busy", "true");
      await checkCardLayout();
      await page.screenshot({
        path: test.info().outputPath("loading.png"),
        fullPage: true,
      });
      await f.loads
        .shift()
        ?.fulfill({ status: 503, json: { error: "Settings unavailable" } });
      await expect(card).toContainText("Unavailable");
      await expect(edit).toBeDisabled();
      await checkCardLayout();
      await page.screenshot({
        path: test.info().outputPath("load-error.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => f.loads.length).toBe(1);
      await f.loads.shift()?.fulfill({ json: f.saved });
      f.releaseLoads();
      await expect(card.locator(".settings-item-value")).toHaveText("USD");
      await edit.click();
      await expect(currency).toBeFocused();
      await chooseOption(currency, "TWD");
      await currency.click();
      await page.screenshot({
        path: test.info().outputPath("currency-menu.png"),
        fullPage: true,
      });
      await currency.press("Escape");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
      await expect(card.locator(".settings-item-value")).toHaveText("USD");
      expect(f.saves).toHaveLength(0);
      await edit.click();
      await expect(currency).toHaveAttribute("value", "USD");
      await chooseOption(currency, "TWD");
      await save.click();
      await expect.poll(() => f.saves.length).toBe(1);
      await expect(dialog).toHaveAttribute("aria-busy", "true");
      await expect(currency).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(card.locator(".settings-item-value")).toHaveText("USD");
      await page.screenshot({
        path: test.info().outputPath("pending.png"),
        fullPage: true,
      });
      await f.saves
        .shift()
        ?.fulfill({ status: 503, json: { error: "Could not save currency" } });
      await expect(dialog.getByRole("alert")).toContainText(
        "Could not save currency",
      );
      await expect(currency).toHaveAttribute("value", "TWD");
      await page.screenshot({
        path: test.info().outputPath("save-error.png"),
        fullPage: true,
      });
      await save.click();
      await expect.poll(() => f.saves.length).toBe(1);
      const request = f.saves.shift();
      const input = request?.request().postDataJSON();
      expect(input).toEqual({
        version: 1,
        settings: { ...f.saved.settings, currency: "TWD" },
      });
      f.saved.settings.currency = "TWD";
      f.saved.version++;
      await request?.fulfill({ json: f.saved });
      await expect(dialog).toHaveCount(0);
      await expect(card.locator(".settings-item-value")).toHaveText("TWD");
      await expect(page.getByRole("status")).toContainText(
        "Team currency saved.",
      );
      await page.reload();
      await expect(card.locator(".settings-item-value")).toHaveText("TWD");
      await expect(card.getByRole("combobox")).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await checkCardLayout();
      await page.screenshot({
        path: test.info().outputPath("saved.png"),
        fullPage: true,
      });
      await edit.click();
      await chooseOption(currency, "EUR");
      await save.click();
      await expect.poll(() => f.saves.length).toBe(1);
      f.saved.settings.currency = "JPY";
      f.saved.version++;
      await f.saves
        .shift()
        ?.fulfill({ status: 409, json: { error: "version_conflict" } });
      await expect(currency).toHaveAttribute("value", "EUR");
      await dialog
        .getByRole("button", { name: "Reload current version" })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(card.locator(".settings-item-value")).toHaveText("JPY");
      await edit.click();
      await expect(currency).toHaveAttribute("value", "JPY");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });
  }
}
