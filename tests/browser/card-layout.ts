import { expect, type Locator } from "@playwright/test";

export async function expectTopRightAction(frame: Locator, action: Locator) {
  await expect(action).toBeVisible();
  const inset = await frame.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top:
        bounds.top +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.paddingTop),
      right:
        bounds.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
    };
  });
  const bounds = await action.boundingBox();
  if (!bounds) throw new Error("Card action has no rendered bounds");
  expect(Math.abs(bounds.y - inset.top)).toBeLessThan(1);
  expect(Math.abs(bounds.x + bounds.width - inset.right)).toBeLessThan(1);
}
