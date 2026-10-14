import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { starterSkills } from "../../src/skills/catalog.ts";

const workspaceId = "preset-skills-fixture";
async function fixture(page: Page, items: Skill[]) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", operator: true, username: "fixture" },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Preset skills" }]
              : path.endsWith("/skills")
                ? {
                    items: items.map((skill) => ({ ...skill, dependents: [] })),
                    total: items.length,
                  }
                : path === "/api/setup/progress"
                  ? { active: true }
                  : {},
    });
  });
  await page.goto(`/admin/skills?workspace=${workspaceId}`);
}

for (const width of [1280, 375]) {
  for (const theme of ["light", "dark"]) {
    test(`presets expose only enable/disable and read-only previews at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const items = starterSkills();
      const skill = items[0];
      if (!skill) throw Error("Missing preset");
      const followup = items[1];
      if (followup) followup.enabled = false;
      await fixture(page, items);
      const published = structuredClone(skill.published);
      const cards = page.locator(".skill-card");
      await expect(cards).toHaveCount(2);
      for (const card of await cards.all()) {
        await expect(card.getByText("Preset", { exact: true })).toBeVisible();
        await expect(card.getByRole("button")).toHaveCount(1);
        await expect(
          card.locator(
            "input, textarea, select, .skill-card-meta, .skill-card-footer",
          ),
        ).toHaveCount(0);
        await card
          .getByText("Preview instructions & dependent schedules", {
            exact: true,
          })
          .click();
        await expect(card.locator(".prose")).toBeVisible();
      }
      await expect(
        page.getByRole("heading", { name: "Test skill policy" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Edit draft" }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Restore a published version", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("preset-skills.png"),
      });

      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actions: string[] = [];
      await page.route("**/skills/*/action", async (route) => {
        const input = route.request().postDataJSON();
        expect(input.version).toBe(skill.version);
        actions.push(input.action);
        await gate;
        skill.enabled = input.action === "enable";
        skill.version++;
        await route.fulfill({ json: skill });
      });
      const card = cards.filter({
        has: page.getByRole("heading", { name: "Team recap", exact: true }),
      });
      await card.getByRole("button", { name: "disable", exact: true }).click();
      await expect(
        card.getByRole("button", { name: "disable", exact: true }),
      ).toBeDisabled();
      await expect(
        card.getByRole("button", { name: "disable", exact: true }),
      ).toHaveAttribute("aria-busy", "true");
      await page.screenshot({
        path: test.info().outputPath("preset-pending.png"),
      });
      release();
      await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
      await expect(
        card.getByRole("button", { name: "enable", exact: true }),
      ).toBeEnabled();
      await card.getByRole("button", { name: "enable", exact: true }).click();
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
      expect(actions).toEqual(["disable", "enable"]);
      expect(skill.published).toEqual(published);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    });
  }
  test(`preset toggle failures remain recoverable without showing version controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const items = starterSkills();
    await fixture(page, items);
    await page.route("**/skills/*/action", async (route) => {
      await route.fulfill({ status: 409, json: { error: "version_conflict" } });
    });
    const card = page.locator(".skill-card").first();
    await card.getByRole("button", { name: "disable", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText(
      "Reload the page before trying again",
    );
    await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "disable", exact: true }),
    ).toBeEnabled();
    await expect(
      card.locator(".skill-card-meta, .skill-card-footer"),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("preset-error.png") });
  });
}

test("custom skill editing and version management remain available alongside presets", async ({
  page,
}) => {
  const items = starterSkills();
  const preset = items[0];
  if (!preset) throw Error("Missing preset");
  const custom: Skill = {
    ...structuredClone(preset),
    id: "custom-skill",
    preset: false,
    draft: { ...preset.draft, name: "Custom recap", slug: "custom-recap" },
  };
  items.push(custom);
  await fixture(page, items);
  const card = page.locator(".skill-card").filter({
    has: page.getByRole("heading", { name: "Custom recap", exact: true }),
  });
  await expect(
    card.getByRole("button", { name: "Edit draft", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Publish draft", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Test draft policy", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("Restore a published version", { exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Edit draft", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit Custom recap" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
