import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { starterSkills } from "../../src/skills/catalog.ts";

const workspaceId = "managed-skills-fixture";
function customSkill(): Skill {
  const skill = starterSkills()[0];
  if (!skill) throw Error("Missing skill fixture");
  return {
    ...skill,
    preset: false,
    enabled: false,
    published: [],
    draft: { ...skill.draft, name: "Custom recap", slug: "custom-recap" },
    githubSource: {
      repository: "example/skills",
      ref: "main",
      path: "skills/recap/SKILL.md",
      commit: "a".repeat(40),
      blobSha: "b".repeat(40),
      draftHash: "fixture",
      importedAt: "2026-10-22T00:00:00Z",
      access: "public",
    },
  };
}
async function fixture(page: Page, items: Skill[], load?: () => Promise<void>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/skills")) await load?.();
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "fixture", operator: true },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Skills workspace" }]
              : path.endsWith("/skills")
                ? {
                    items: items.map((skill) => ({ ...skill, dependents: [] })),
                    total: items.length,
                  }
                : {},
    });
  });
  await page.goto(`/admin/skills?workspace=${workspaceId}`);
}

async function expectNoPolicyTest(page: Page) {
  await expect(
    page.getByRole("button", { name: "Test skill policy", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Test skill policy", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Sample input for deterministic test", { exact: true }),
  ).toHaveCount(0);
}

async function expectCardPadding(card: Locator) {
  const spacing = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const first = element.firstElementChild?.getBoundingClientRect();
    const last = element.lastElementChild?.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: (first?.top ?? 0) - box.top,
      bottom: box.bottom - (last?.bottom ?? 0),
      paddingTop: parseFloat(style.paddingTop),
      paddingBottom: parseFloat(style.paddingBottom),
    };
  });
  expect(Math.abs(spacing.top - spacing.paddingTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(spacing.bottom - spacing.paddingBottom)).toBeLessThanOrEqual(
    1,
  );
}

for (const width of [1280, 375]) {
  for (const theme of ["light", "dark"]) {
    test(`skills save directly with recoverable dialogs and GitHub history at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const skill = customSkill();
      await fixture(page, [skill]);
      const card = page.locator(".skill-card");
      await expect(card).toBeVisible();
      await expectNoPolicyTest(page);
      await expectCardPadding(card);
      await expect(
        page.getByText(
          /Manage skill instructions and version history on GitHub/,
        ),
      ).toBeVisible();
      const source = card.getByRole("link", { name: "Source", exact: true });
      const updates = card.getByRole("button", { name: "Check for updates" });
      await expect(source).toHaveAttribute(
        "href",
        "https://github.com/example/skills/blob/main/skills/recap/SKILL.md",
      );
      await expect(source).toHaveAttribute("target", "_blank");
      await expect(source).toHaveAttribute("rel", "noreferrer");
      await expect(source.locator("svg[aria-hidden='true']")).toHaveCount(1);
      const appearance = (element: HTMLElement | SVGElement) => {
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          font: style.font,
          color: style.color,
          background: style.backgroundColor,
          border: style.border,
          radius: style.borderRadius,
          padding: style.padding,
        };
      };
      expect(await source.evaluate(appearance)).toEqual(
        await updates.evaluate(appearance),
      );
      await expect(source).toHaveCSS("text-decoration-line", "none");
      await source.hover();
      const sourceHover = await source.evaluate(appearance);
      await updates.hover();
      expect(sourceHover).toEqual(await updates.evaluate(appearance));
      await source.focus();
      await expect(source).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(updates).toBeFocused();
      await expect(
        card.locator(
          "input, textarea, select, .skill-card-meta, .skill-card-versions, .skill-card-rollback",
        ),
      ).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: /publish|draft|rollback/i }),
      ).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: "enable", exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: test.info().outputPath("skill-summary.png"),
        fullPage: true,
      });
      const edit = card.getByRole("button", { name: "Edit", exact: true });
      await edit.click();
      const dialog = page.getByRole("dialog", { name: "Edit Custom recap" });
      await expect(
        dialog.getByRole("button", { name: "Save skill", exact: true }),
      ).toBeVisible();
      await dialog
        .getByLabel("Instructions", { exact: true })
        .fill("Discarded edits.");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
      await edit.click();
      await expect(
        dialog.getByLabel("Instructions", { exact: true }),
      ).toHaveValue(skill.draft.body);
      await dialog
        .getByLabel("Instructions", { exact: true })
        .fill("Saved instructions for future runs.");
      let fail = true;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writes = 0;
      await page.route(`**/skills/${skill.id}`, async (route) => {
        writes++;
        const input = route.request().postDataJSON();
        expect(input.version).toBe(skill.version);
        if (fail) {
          await route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
          return;
        }
        await gate;
        skill.draft = input.spec;
        skill.published.push(structuredClone(skill.draft));
        skill.version++;
        await route.fulfill({ json: skill });
      });
      await dialog
        .getByRole("button", { name: "Save skill", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText("version_conflict");
      await expect(
        dialog.getByLabel("Instructions", { exact: true }),
      ).toHaveValue("Saved instructions for future runs.");
      await page.screenshot({
        path: test.info().outputPath("skill-editor-error.png"),
      });
      fail = false;
      await dialog
        .getByRole("button", { name: "Save skill", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Saving…", exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("skill-editor-pending.png"),
      });
      release();
      await expect(dialog).toHaveCount(0);
      expect(writes).toBe(2);
      await expect(page.locator(".toast").getByRole("status")).toHaveText(
        "Skill saved.",
      );
      await card.locator(".skill-card-preview > summary").click();
      await expect(
        card.getByText("Saved instructions for future runs.", { exact: true }),
      ).toBeVisible();
      await expect(card.locator("input, textarea, select")).toHaveCount(0);
      await page.route("**/skills/*/action", async (route) => {
        expect(route.request().postDataJSON().action).toBe("enable");
        skill.enabled = true;
        skill.version++;
        await route.fulfill({ json: skill });
      });
      await card.getByRole("button", { name: "enable", exact: true }).click();
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await expectNoPolicyTest(page);
      await expectCardPadding(card);
      await page.screenshot({
        path: test.info().outputPath("skill-saved.png"),
        fullPage: true,
      });
    });
  }
  test(`skills keep GitHub guidance through loading, empty and request failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fixture(page, [], () => gate);
    await expect(
      page.getByRole("heading", { name: "Agent skills" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Loading skills" }),
    ).toHaveAttribute("aria-busy", "true");
    await expectNoPolicyTest(page);
    await page.screenshot({
      path: test.info().outputPath("skill-loading.png"),
    });
    release();
    await expect(
      page.getByRole("heading", { name: "No skills yet" }),
    ).toBeVisible();
    await expectNoPolicyTest(page);
    await expect(
      page.getByText(
        "Import skills from GitHub to get started, or create a custom skill.",
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("skill-empty.png") });
    await page.route("**/skills?offset=0", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Skills temporarily unavailable" },
      }),
    );
    await page.reload();
    await expect(page.locator(".toast-error").getByRole("alert")).toContainText(
      "Skills temporarily unavailable",
    );
    await expect(
      page.getByRole("button", { name: "Retry skills" }),
    ).toBeVisible();
    await expectNoPolicyTest(page);
    await expect(
      page.getByText(/Manage skill instructions and version history on GitHub/),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("skill-load-error.png"),
    });
    await page.unroute("**/skills?offset=0");
    await page.getByRole("button", { name: "Retry skills" }).click();
    await expect(
      page.getByRole("heading", { name: "No skills yet" }),
    ).toBeVisible();
    await expect(page.locator(".toast-error")).toHaveCount(0);
  });
}
