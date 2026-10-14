import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import type { GitHubSkillDiscovery } from "../../src/skills/github-source.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "github-skills-fixture";
const url = "https://github.com/example/private-skills";
const spec = (slug: string) => ({
  slug,
  name: slug,
  description: `Instructions for ${slug}`,
  body: "Use authorized supplied context. Cite sources.",
  tools: [] as Skill["draft"]["tools"],
  settings: { sections: "Next steps", maxWords: 400 },
});
const discovery: GitHubSkillDiscovery = {
  repository: "example/private-skills",
  ref: "main",
  scope: "",
  commit: "a".repeat(40),
  access: "connected",
  skills: [
    {
      path: "skills/recap/SKILL.md",
      sha: "b".repeat(40),
      spec: spec("source-recap"),
    },
    {
      path: "skills/review/SKILL.md",
      sha: "c".repeat(40),
      spec: spec("source-review"),
    },
    {
      path: "skills/broken/SKILL.md",
      sha: "d".repeat(40),
      error: "frontmatter_required",
    },
  ],
};
function importedSkill(): Skill {
  return {
    id: "source-skill",
    version: 1,
    draft: spec("source-recap"),
    enabled: false,
    archived: false,
    tests: [],
    published: [],
    githubSource: {
      repository: discovery.repository,
      ref: discovery.ref,
      path: "skills/recap/SKILL.md",
      commit: discovery.commit,
      blobSha: "b".repeat(40),
      draftHash: "fixture",
      importedAt: "2026-10-14T00:00:00Z",
      access: "connected",
      repositoryId: 7001,
      installationId: 501,
    },
  };
}
async function fixture(page: Page, items: Skill[] = []) {
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
              ? [{ id: workspaceId, name: "Skills" }]
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
  test(`unchanged sources and successful updates keep published instructions at ${width}px in dark mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("repodesk.theme", "dark"),
    );
    const skill = importedSkill();
    skill.published = [structuredClone(skill.draft)];
    skill.enabled = true;
    await fixture(page, [skill]);
    const published = structuredClone(skill.published);
    let changed = false;
    await page.route("**/github/check", async (route) => {
      await route.fulfill({
        json: {
          changed,
          locallyModified: false,
          commit: "e".repeat(40),
          spec: { ...spec("source-recap"), body: "New source instructions." },
        },
      });
    });
    await page.route("**/github/update", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        version: 1,
        commit: "e".repeat(40),
        replaceLocal: false,
      });
      skill.draft.body = "New source instructions.";
      skill.version++;
      if (skill.githubSource) skill.githubSource.commit = "e".repeat(40);
      await route.fulfill({ json: skill });
    });
    await page
      .locator(".skill-card")
      .getByRole("button", { name: "Check for updates" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Update source-recap" });
    await dialog
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toHaveText(
      "This skill is up to date with its source.",
    );
    await expect(
      dialog.getByRole("button", { name: "Save update draft" }),
    ).toHaveCount(0);
    changed = true;
    await dialog
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    const comparison = dialog.locator(".skill-update-comparison");
    await expect(comparison).toHaveCSS("display", "grid");
    const columns = await comparison
      .locator("section")
      .evaluateAll((sections) =>
        sections.map((section) => ({
          x: section.getBoundingClientRect().x,
          y: section.getBoundingClientRect().y,
        })),
      );
    if (width > 600)
      expect((columns[1]?.x ?? 0) - (columns[0]?.x ?? 0)).toBeGreaterThan(100);
    else {
      expect(columns[1]?.x).toBe(columns[0]?.x);
      expect(columns[1]?.y).toBeGreaterThan(columns[0]?.y ?? 0);
    }
    await page.screenshot({
      path: test.info().outputPath("github-update-dark.png"),
    });
    await dialog.getByRole("button", { name: "Save update draft" }).click();
    await expect(dialog).toHaveCount(0);
    const card = page.locator(".skill-card");
    await expect(card.getByText("Revision 2", { exact: true })).toBeVisible();
    await expect(
      card.getByText("1 published version", { exact: true }),
    ).toBeVisible();
    await expect(card.getByText(/main at eeeeeee/)).toBeVisible();
    await expect(
      card.getByRole("button", { name: "disable", exact: true }),
    ).toBeVisible();
    expect(skill.published).toEqual(published);
    await page.screenshot({
      path: test.info().outputPath("github-updated-summary-dark.png"),
    });
  });
  test(`private multi-skill discovery selects drafts and keeps saved source display separate at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const items: Skill[] = [];
    await fixture(page, items);
    let finishDiscovery = () => {};
    const discovering = new Promise<void>((resolve) => {
      finishDiscovery = resolve;
    });
    await page.route("**/skills/github/discover", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ url });
      await discovering;
      await route.fulfill({ json: discovery });
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saves = 0;
    await page.route("**/skills/github/import", async (route) => {
      saves++;
      expect(route.request().postDataJSON()).toEqual({
        url,
        commit: discovery.commit,
        paths: ["skills/recap/SKILL.md", "skills/review/SKILL.md"],
      });
      await gate;
      items.push(importedSkill());
      await route.fulfill({ json: { items } });
    });
    const trigger = page.getByRole("button", {
      name: "Import skill",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Import SKILL.md" });
    await expect(
      page.getByRole("heading", { name: "No skills yet" }),
    ).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "GitHub link", exact: true })
      .fill(url);
    await dialog.getByRole("button", { name: "Find skills" }).click();
    await expect(
      dialog.getByRole("button", { name: "Checking…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("github-discovery-pending.png"),
    });
    finishDiscovery();
    await expect(
      dialog.getByText(/3 skills found · Connected GitHub App/),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "skills/broken/SKILL.md" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Import selected drafts" }),
    ).toBeDisabled();
    await dialog
      .getByRole("checkbox", { name: "source-recap", exact: true })
      .check();
    await dialog
      .getByRole("checkbox", { name: "source-review", exact: true })
      .check();
    await expect(dialog.locator(".modal-actions button")).toHaveText([
      "Import 2 drafts",
      "Cancel",
    ]);
    await page.screenshot({
      path: test.info().outputPath("github-discovery.png"),
    });
    await dialog
      .getByRole("button", { name: "Import 2 drafts", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close Import SKILL.md" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("github-import-pending.png"),
    });
    release();
    await expect(dialog).toHaveCount(0);
    expect(saves).toBe(1);
    const card = page.locator(".skill-card");
    await expect(card.getByText(/Source:/)).toBeVisible();
    await expect(card.getByRole("link")).toHaveAttribute(
      "href",
      /github.com\/example\/private-skills\/blob\/main\/skills\/recap\/SKILL.md/,
    );
    await expect(card.locator("input, select, textarea")).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "enable", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath("github-source-summary.png"),
    });
  });
  test(`update review protects local drafts and retains source errors at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const skill = importedSkill();
    skill.draft.body = "Local draft changes.";
    skill.published = [spec("source-recap")];
    skill.enabled = true;
    await fixture(page, [skill]);
    await page.route("**/github/check", async (route) => {
      await route.fulfill({
        json: {
          changed: true,
          locallyModified: true,
          commit: "e".repeat(40),
          spec: {
            ...spec("source-recap"),
            body: "Updated source instructions.",
          },
        },
      });
    });
    let updates = 0;
    await page.route("**/github/update", async (route) => {
      updates++;
      expect(route.request().postDataJSON()).toEqual({
        version: 1,
        commit: "e".repeat(40),
        replaceLocal: true,
      });
      await route.fulfill({
        status: 409,
        json: { error: "github_skill_source_changed" },
      });
    });
    await page
      .locator(".skill-card")
      .getByRole("button", { name: "Check for updates" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Update source-recap" });
    await dialog
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(
      dialog.getByText("Local draft changes.", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Updated source instructions.", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Save update draft" }),
    ).toBeDisabled();
    await dialog
      .getByRole("checkbox", { name: "Replace my local draft edits" })
      .check();
    await expect(dialog.locator(".modal-actions button")).toHaveText([
      "Save update draft",
      "Cancel",
    ]);
    await page.screenshot({
      path: test.info().outputPath("github-update-review.png"),
    });
    await dialog.getByRole("button", { name: "Save update draft" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "repository changed since this preview",
    );
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("github-update-error.png"),
    });
    expect(updates).toBe(1);
    await expect(
      page.locator(".skill-card").getByText("1 published version"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .locator(".skill-card")
        .getByRole("button", { name: "Check for updates" }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("empty and failed discovery preserve entered links; changing links invalidates selection", async ({
  page,
}) => {
  await fixture(page);
  let fail = true;
  await page.route("**/skills/github/discover", async (route) => {
    await route.fulfill(
      fail
        ? { status: 403, json: { error: "github_access_denied" } }
        : { json: { ...discovery, skills: [] } },
    );
  });
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "GitHub link", exact: true })
    .fill(url);
  await dialog.getByRole("button", { name: "Find skills" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "connect it to this workspace",
  );
  await expect(
    dialog.getByRole("textbox", { name: "GitHub link", exact: true }),
  ).toHaveValue(url);
  fail = false;
  await dialog.getByRole("button", { name: "Find skills" }).click();
  await expect(dialog.getByText(/No SKILL.md files found/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Import selected drafts" }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "GitHub link", exact: true })
    .fill(`${url}/tree/main/skills`);
  await expect(
    dialog.getByRole("region", { name: "Discovered skills" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Find skills" }),
  ).toBeVisible();
});

test("Markdown imports remain available through the shared modal", async ({
  page,
}) => {
  await fixture(page);
  let saved = false;
  await page.route("**/skills/import", async (route) => {
    expect(route.request().postDataJSON().markdown).toContain(
      "name: local-skill",
    );
    saved = true;
    await route.fulfill({ json: importedSkill() });
  });
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await chooseOption(
    dialog.getByRole("combobox", { name: "Import from" }),
    "markdown",
  );
  await dialog
    .getByLabel("Markdown contents")
    .fill(
      "---\nname: local-skill\ndescription: A local skill\n---\nInstructions.",
    );
  await dialog
    .getByRole("button", { name: "Import draft", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toBe(true);
});
