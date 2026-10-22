import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { starterSkills } from "../../src/skills/catalog.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspaceId = "preset-skills-fixture";
async function fixture(
  page: Page,
  items: (Skill & { dependents?: unknown[] })[],
) {
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
                    items: items.map((skill) => ({
                      ...skill,
                      dependents: skill.dependents ?? [],
                    })),
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
        await expect(card.getByLabel("Settings")).toContainText(
          "Maximum words",
        );
        await expect(card.getByLabel("Settings")).toContainText("400");
        await expect(card.getByLabel("Settings")).toContainText(
          "Decisions, blockers, next steps",
        );
        const tools = card.getByRole("list", { name: "Required tools" });
        await expect(tools.getByRole("listitem")).toHaveText(skill.draft.tools);
        const toolsBounds = await tools.boundingBox();
        expect(toolsBounds?.height).toBeLessThan(width > 640 ? 90 : 160);
        expect((await card.boundingBox())?.height).toBeLessThan(
          width > 640 ? 450 : 700,
        );
        await expect(
          card.getByText("No dependent workflows", { exact: true }),
        ).toBeVisible();
        await expectTopRightAction(card, card.getByRole("button"));
        const toggle = card.locator(".skill-card-preview > summary");
        expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(card.locator(".prose")).toBeHidden();
        await page.keyboard.press("Enter");
        await expect(card.locator(".prose")).toBeVisible();
      }
      await expect(
        page.getByRole("heading", { name: "Test skill policy" }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
      await expect(
        page.getByText("Restore a published version", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page
        .getByRole("heading", { name: "Agent skills", exact: true })
        .click();
      await page.screenshot({
        path: test.info().outputPath("preset-skills.png"),
        fullPage: true,
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
    await expect(page.locator(".toast-error").getByRole("alert")).toContainText(
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

for (const width of [1280, 375]) {
  test(`custom previews retain long content, dependencies and empty tools at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const [preset] = starterSkills();
    if (!preset) throw Error("Missing preset");
    const longText = "team_decision_".repeat(30);
    const custom: Skill & { dependents: unknown[] } = {
      ...preset,
      id: "custom-preview",
      preset: false,
      draft: {
        ...preset.draft,
        name: "Custom recap",
        body: `${preset.draft.body}\n${longText}`,
        settings: { maxWords: 400, sections: longText },
        tools: ["read_chat_context", "propose_instruction"],
      },
      dependents: [
        {
          id: "weekday-recap",
          name: "Weekday recap",
          version: 1,
          status: "active",
        },
      ],
    };
    await fixture(page, [custom]);
    const card = page.locator(".skill-card");
    await expect(card.locator("input, textarea, select")).toHaveCount(0);
    const toggle = card.locator(".skill-card-preview > summary");
    await toggle.click();
    await expect(card.locator(".prose")).toHaveText(custom.draft.body);
    await expect(card.getByLabel("Settings").locator("dd").first()).toHaveText(
      "400",
    );
    await expect(card.getByLabel("Settings")).toContainText(longText);
    await expect(
      card.getByRole("list", { name: "Required tools" }).getByRole("listitem"),
    ).toHaveText(custom.draft.tools);
    await expect(card.locator(".skill-preview-dependents")).toContainText(
      "Weekday recap",
    );
    await expect(card.getByText("No dependent workflows")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath("custom-preview-long.png"),
      fullPage: true,
    });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Edit Custom recap" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("custom-preview-editor.png"),
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card.locator(".prose")).toHaveText(custom.draft.body);

    custom.draft.tools = [];
    custom.dependents = [];
    await page.reload();
    await toggle.click();
    await expect(card.getByText("No tools required")).toBeVisible();
    await expect(card.getByText("No dependent workflows")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("custom-preview-empty.png"),
      fullPage: true,
    });
  });
}

test("custom skill editing uses direct saves without version management alongside presets", async ({
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
    card.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Publish draft", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Test skill policy", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("Restore a published version", { exact: true }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit Custom recap" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
