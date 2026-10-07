import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "skills-search-fixture";
const skills: Skill[] = [
  ["Weekly recap", "weekly-recap", "Summarize decisions and blockers", true],
  ["Release notes", "release-notes", "Summarize shipped changes", false],
  ["Follow ups", "action-list", "Track decisions and owners", false],
].map(([name, slug, description, enabled], index) => ({
  id: `skill-${index}`,
  version: 1,
  draft: {
    name: String(name),
    slug: String(slug),
    description: String(description),
    body: "Use the supplied sources.",
    tools: [],
    settings: { sections: "Decisions and next steps", maxWords: 400 },
  },
  published: [],
  enabled: Boolean(enabled),
  archived: false,
  tests: [],
}));

async function fixture(page: Page, items = skills, total = items.length) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Skills workspace" }]
              : path.endsWith("/skills")
                ? { items: items.map((s) => ({ ...s, dependents: [] })), total }
                : {},
    });
  });
  await page.goto(`/admin/skills?workspace=${workspaceId}`);
}

for (const width of [1280, 375]) {
  test(`skill search combines words and state with accessible recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    const search = page.getByRole("searchbox", { name: "Search skills" });
    const state = page.getByRole("combobox", { name: "Skill state" });
    const cards = page.locator(".skill-card");
    const count = page.locator(".skill-catalog-count");
    await expect(cards).toHaveCount(3);
    await expect(count).toHaveText("3 of 3 skills");
    await expect(page.getByText("Search skills", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("Skill state", { exact: true })).toHaveCount(0);
    await search.fill("  DECISIONS   weekly  ");
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole("heading")).toHaveText("Weekly recap");
    await chooseOption(state, "disabled");
    await expect(cards).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "No skills match" }),
    ).toBeVisible();
    await expect(count).toHaveText("0 of 3 skills");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toBeFocused();
    await expect(state).toHaveAttribute("value", "disabled");
    await expect(cards).toHaveCount(2);
    await search.fill("ACTION-LIST");
    await expect(cards.getByRole("heading")).toHaveText("Follow ups");
    await search.fill("nonexistent");
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(state).toHaveAttribute("value", "all");
    await expect(cards).toHaveCount(3);
    await search.fill("   ");
    await expect(cards).toHaveCount(3);
    await state.focus();
    await state.press("ArrowDown");
    await state.press("Home");
    await state.press("ArrowDown");
    await state.press("Enter");
    await expect(state).toHaveAttribute("value", "enabled");
    await expect(cards).toHaveCount(1);
    await chooseOption(state, "all");
    await search.fill("decisions");
    await expect(cards).toHaveCount(2);
    const controls = await page
      .locator(".skill-catalog-controls")
      .boundingBox();
    const toolbar = await page.locator(".skill-catalog-toolbar").boundingBox();
    expect(controls).not.toBeNull();
    expect(toolbar).not.toBeNull();
    if (controls && toolbar && width > 1000) {
      expect(controls.x).toBeGreaterThan(toolbar.x + toolbar.width / 3);
      expect(
        Math.abs(controls.x + controls.width - toolbar.x - toolbar.width),
      ).toBeLessThan(2);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath("skills-search.png"),
    });
  });
}

test("empty skills catalog is distinct from filtered results", async ({
  page,
}) => {
  await fixture(page, []);
  await expect(
    page.getByRole("heading", { name: "No skills yet" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset filters" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Add skill" })).toBeVisible();
});

test("paginated search identifies the current page", async ({ page }) => {
  await fixture(page, skills, 103);
  await expect(page.locator(".skill-catalog-count")).toHaveText(
    "3 of 3 skills on this page",
  );
  await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
});
