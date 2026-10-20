import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const bundle = execFileSync(
  "bun",
  [
    "build",
    "./tests/browser/checkbox-fixture.tsx",
    "--target=browser",
    "--minify",
  ],
  { encoding: "utf8" },
);
const style = readFileSync("web/style.css", "utf8");

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`checkbox choices and editors at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(
        `<html lang="en" data-theme="${theme}"><head><style>${style}</style></head><body><div id="fixture"></div></body></html>`,
      );
      await page.addScriptTag({ content: bundle });

      const domain = page.getByRole("checkbox", { name: "example.com" });
      await page.getByText("example.com", { exact: true }).click();
      await expect(domain).toBeChecked();
      await domain.press("Space");
      await expect(domain).not.toBeChecked();
      await expect(domain).toBeFocused();
      await expect(domain).toHaveCSS("outline-style", "solid");
      await expect(domain).toHaveCSS("outline-width", "3px");

      for (const name of ["Already imported", "Unavailable choice"]) {
        await expect(page.getByRole("checkbox", { name })).toBeDisabled();
        // Deliberately tap the disabled label; the browser must keep its state.
        await page.getByText(name, { exact: true }).click({ force: true });
      }
      await expect(
        page.getByRole("checkbox", { name: "Already imported" }),
      ).toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: "Unavailable choice" }),
      ).not.toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: "Some repositories selected" }),
      ).toBeChecked({ indeterminate: true });

      for (const control of await page.getByRole("checkbox").all()) {
        await expect(control).toHaveCSS("width", "20px");
        await expect(control).toHaveCSS("height", "20px");
        const row = await control.locator("..").boundingBox();
        expect(row?.height).toBeGreaterThanOrEqual(44);
        expect((row?.x ?? 0) + (row?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      for (const control of await page.getByRole("switch").all()) {
        await expect(control).toHaveCSS("width", "44px");
        await expect(control).toHaveCSS("height", "24px");
        await expect(control).toHaveCSS("border-radius", "999px");
        expect(
          await control.evaluate(
            (input) => getComputedStyle(input, "::before").maskImage,
          ),
        ).toBe("none");
      }
      const plugin = page.getByRole("switch", {
        name: "Enable Example plugin",
      });
      await plugin.press("Space");
      await expect(plugin).not.toBeChecked();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({ path: test.info().outputPath("choices.png") });

      const summary = page.getByRole("region", { name: "Saved configuration" });
      // Saved values remain readable text; the shared modal owns editing.
      await expect(page.getByText("Automatic review: Off")).toBeVisible();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit configuration" });
      const review = dialog.getByRole("checkbox", { name: "Automatic review" });
      const contents = dialog.getByRole("checkbox", {
        name: /^Read repository/,
      });
      await review.press("Space");
      await contents.locator("..").click();
      await expect(review).toBeChecked();
      await expect(contents).toBeChecked();
      for (const control of await dialog.getByRole("checkbox").all()) {
        await expect(control).toHaveCSS("width", "20px");
      }
      await page.screenshot({ path: test.info().outputPath("editor.png") });
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(review).toBeDisabled();
      await expect(contents).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("pending.png") });
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("checkbox-save", { detail: "reject" }),
        ),
      );
      await expect(dialog.getByRole("alert")).toHaveText(
        "Save failed. Try again.",
      );
      await expect(review).toBeEnabled();
      await expect(contents).toBeChecked();
      await page.screenshot({ path: test.info().outputPath("error.png") });
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await page.evaluate(() =>
        window.dispatchEvent(new Event("checkbox-save")),
      );
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("Automatic review: On")).toBeVisible();
      await expect(page.getByText("Tools: metadata, contents")).toBeVisible();
      await expect(summary.getByRole("checkbox")).toHaveCount(0);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(review).toBeChecked();
      await review.press("Space");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText("Automatic review: On")).toBeVisible();

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(domain).toHaveCSS("transition-duration", "0s");
      await page.emulateMedia({ forcedColors: "active" });
      await expect(domain).toHaveCSS("appearance", "auto");
      await domain.press("Space");
      await expect(domain).toBeChecked();
      await page.screenshot({
        path: test.info().outputPath("forced-colors.png"),
      });
    });
  }
}
