import { expect, type Locator } from "@playwright/test";

/** Exercise the visible custom menu, including its real selection handler. */
export async function chooseOption(control: Locator, value: string) {
  await control.click();
  const listId = await control.getAttribute("aria-controls");
  const option = control
    .page()
    .locator(`[id=${JSON.stringify(listId)}]`)
    .getByRole("option")
    .and(control.page().locator(`[data-value=${JSON.stringify(value)}]`));
  await option.click();
  await expect(control).toHaveAttribute("value", value);
  await expect(control).toHaveAttribute("aria-expanded", "false");
}
