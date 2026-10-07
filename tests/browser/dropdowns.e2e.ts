import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { chooseOption } from "./dropdown-helpers.ts";

const bundle = execFileSync(
  "bun",
  [
    "build",
    "./tests/browser/dropdown-fixture.tsx",
    "--target=browser",
    "--minify",
  ],
  { encoding: "utf8" },
);
const style = readFileSync("web/style.css", "utf8");

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`dropdown forms and keyboard behavior at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.setContent(
        `<html data-theme="${theme}"><head><style>${style}</style></head><body><div id="fixture"></div></body></html>`,
      );
      await page.addScriptTag({ content: bundle });
      const control = page.getByRole("combobox", { name: "Controlled" });
      await expect(control).toHaveText("Alpha");
      const appearance = (element: Element) => {
        const css = getComputedStyle(element);
        return [
          css.backgroundColor,
          css.color,
          css.borderRadius,
          css.fontSize,
          css.fontWeight,
          css.minHeight,
        ];
      };
      expect(await control.evaluate(appearance)).toEqual(
        await page
          .getByRole("button", { name: "Workspace reference" })
          .evaluate(appearance),
      );
      await control.press("ArrowDown");
      await expect(
        page.getByRole("option", { name: "Alpha", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("option", { name: "Alpha", exact: true }).locator("svg"),
      ).toHaveCount(1);
      await expect(
        page.getByRole("option", { name: "Blocked" }),
      ).toHaveAttribute("aria-disabled", "true");
      await control.press("ArrowDown");
      await control.press("Enter");
      await expect(control).toHaveText("Charlie");
      await control.press("Space");
      await control.press("Home");
      await control.press("Escape");
      await expect(control).toHaveText("Charlie");
      await expect(control).toBeFocused();
      await control.press("a");
      await control.press("Enter");
      await expect(control).toHaveText("Alpha");
      await control.click();
      await control.press("Tab");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await page.getByRole("button", { name: "Update selection" }).click();
      await expect(control).toHaveText("Charlie");
      await control.click();
      await page.getByRole("button", { name: "Workspace reference" }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Disabled", exact: true }),
      ).toBeDisabled();
      const model = page.getByRole("combobox", { name: "Model", exact: true });
      await model.fill("model");
      await model.press("ArrowDown");
      await model.press("Enter");
      await expect(model).toHaveValue("model-one");
      await model.fill("model");
      await page
        .getByRole("option", { name: "model-two", exact: true })
        .click();
      await expect(model).toHaveValue("model-two");
      await model.fill("custom-model");
      await model.press("Tab");
      await expect(model).toHaveValue("custom-model");
      await expect(page.getByRole("listbox")).toHaveCount(0);

      await page.getByRole("button", { name: "Open form" }).click();
      const dialog = page.getByRole("dialog");
      const zone = dialog.getByRole("combobox", {
        name: "Timezone",
        exact: true,
      });
      await expect(zone).toBeFocused();
      await expect(zone).toHaveAttribute("aria-expanded", "false");
      await dialog.getByRole("button", { name: "Save form" }).click();
      await expect(zone).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("output")).toHaveText("");
      await zone.click();
      await expect(
        dialog.getByText("Suggested", { exact: true }),
      ).toBeVisible();
      await zone.press("End");
      await expect(
        dialog.getByRole("option", { name: "Timezone 39", exact: true }),
      ).toBeInViewport();
      const bounds = await dialog.locator(".dropdown-popup").boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error("Dropdown has no bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
      await page.screenshot({ path: test.info().outputPath("dropdown.png") });
      await zone.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(zone).toBeFocused();
      await chooseOption(zone, "UTC");
      await dialog.getByRole("button", { name: "Save form" }).click();
      await expect(page.locator("output")).toHaveText("UTC");
      await dialog.getByRole("button", { name: "Reset form" }).click();
      await expect(zone).toHaveText("Choose timezone");
      await zone.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Open form" }),
      ).toBeFocused();
    });
  }
}
