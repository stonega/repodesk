import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const guide = readFileSync(
  "src/skills/telegram-widgets/references/rendering.md",
  "utf8",
);
const example = /```html\n([\s\S]+?)\n```/.exec(guide)?.[1];
if (!example) throw Error("Widget example missing");
for (const width of [320, 430]) {
  for (const theme of ["light", "dark"] as const) {
    test(`widget guide example supports local controls at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      let requests = 0;
      page.on("request", () => requests++);
      await page.setContent(
        `<!doctype html><style>:root{--tg-theme-text-color:${theme === "dark" ? "#fff" : "#111"};--tg-theme-hint-color:${theme === "dark" ? "#bbb" : "#555"};background:${theme === "dark" ? "#17212b" : "#fff"}}body{margin:8px 12px}button{font:inherit;padding:8px;color:inherit;background:transparent;border:1px solid currentColor}</style>${example}`,
      );
      await expect(page.locator("#value")).toHaveText(
        "3 seats × USD 10 = USD 30",
      );
      await page.getByRole("button", { name: "+ seat" }).click();
      await expect(page.locator("#value")).toHaveText(
        "4 seats × USD 10 = USD 40",
      );
      for (let i = 0; i < 5; i++)
        await page.getByRole("button", { name: "− seat" }).click();
      await expect(page.locator("#value")).toHaveText(
        "1 seat × USD 10 = USD 10",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      expect(
        await page
          .locator("body")
          .evaluate((e) => e.getBoundingClientRect().height),
      ).toBeLessThan(560);
      expect(requests).toBe(0);
      await page.screenshot({
        path: test.info().outputPath(`widget-${theme}-${width}.png`),
      });
    });
  }
}
