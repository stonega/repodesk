import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "skill-classification-fixture";
const repositories = [
  { id: 1001, full_name: "acme/api" },
  { id: 1002, full_name: "acme/web" },
];

function fixtureSkills(): Skill[] {
  return [
    {
      id: "skill-global-manual",
      version: 1,
      enabled: true,
      archived: false,
      draft: {
        slug: "weekly-ship-log",
        name: "Weekly ship log",
        description: "Cross-project weekly engineering summary",
        scope: { kind: "global" },
        audience: "chat",
        body: "Summarize shipped highlights, metrics, and risks.",
        tools: ["read_chat_context", "load_skill"],
        settings: { sections: "Highlights, risks", maxWords: 400 },
      },
      published: [
        {
          slug: "weekly-ship-log",
          name: "Weekly ship log",
          description: "Cross-project weekly engineering summary",
          scope: { kind: "global" },
          audience: "chat",
          body: "Summarize shipped highlights, metrics, and risks.",
          tools: ["read_chat_context", "load_skill"],
          settings: { sections: "Highlights, risks", maxWords: 400 },
        },
      ],
      tests: [],
    },
    {
      id: "skill-project-auto",
      version: 2,
      enabled: true,
      archived: false,
      auto: {
        sourceKind: "coding_task",
        sourceId: "task-42",
        extractedAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-21T08:00:00Z",
        rationale: "Captured database test bootstrap after repair loop.",
        confidence: "high",
        revisions: 2,
      },
      usage: {
        loads: 1,
        codingInjections: 3,
      },
      draft: {
        slug: "api-db-bootstrap",
        name: "API DB test bootstrap",
        description: "Run PostgreSQL migrations before testing acme/api",
        scope: { kind: "project", repositoryId: 1001, repository: "acme/api" },
        audience: "coding",
        body: "Apply migrations/ before running bun test against src/db/.",
        tools: ["load_skill"],
        settings: { sections: "Prerequisites, checks", maxWords: 400 },
      },
      published: [
        {
          slug: "api-db-bootstrap",
          name: "API DB test bootstrap",
          description: "Run PostgreSQL migrations before testing acme/api",
          scope: {
            kind: "project",
            repositoryId: 1001,
            repository: "acme/api",
          },
          audience: "coding",
          body: "Apply migrations/ before running bun test against src/db/.",
          tools: ["load_skill"],
          settings: { sections: "Prerequisites, checks", maxWords: 400 },
        },
      ],
      tests: [],
    },
  ];
}

async function openFixture(page: Page, items: Skill[]) {
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path.endsWith("/skills")) {
      const spec = req.postDataJSON();
      const created: Skill = {
        id: "skill-created",
        version: 1,
        enabled: false,
        archived: false,
        draft: spec,
        published: [spec],
        tests: [],
      };
      items.push(created);
      await route.fulfill({ status: 201, json: created });
      return;
    }
    if (req.method() === "PUT" && path.includes("/skills/")) {
      const id = path.split("/").at(-1);
      const input = req.postDataJSON();
      const target = items.find((s) => s.id === id);
      if (target) {
        target.draft = input.spec;
        target.published.push(input.spec);
        target.version++;
        await route.fulfill({ json: target });
        return;
      }
    }
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
              ? [{ id: workspaceId, name: "Classified skills" }]
              : path.endsWith("/skills")
                ? {
                    items: items.map((s) => ({ ...s, dependents: [] })),
                    total: items.length,
                    repositories,
                    autoExtraction: {
                      enabled: true,
                      autoCount: items.filter((s) => !!s.auto && !s.archived)
                        .length,
                      suppressedCount: 0,
                    },
                  }
                : {},
    });
  });
  await page.goto(`/admin/skills?workspace=${workspaceId}`);
}

for (const width of [1280, 375]) {
  for (const theme of ["light", "dark"]) {
    test(`skills filter by Global/Project scope and show auto-extracted provenance at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("telo.theme", value),
        theme,
      );
      const items = fixtureSkills();
      await openFixture(page, items);

      const cards = page.locator(".skill-card");
      await expect(cards).toHaveCount(2);

      const autoCard = cards.filter({ hasText: "API DB test bootstrap" });
      await expect(
        autoCard.locator(".skill-card-title .pill", { hasText: /^Auto$/ }),
      ).toBeVisible();
      await expect(
        autoCard.locator(".skill-card-title .pill", {
          hasText: /^Project · acme\/api$/,
        }),
      ).toBeVisible();
      await expect(
        autoCard.getByText(
          "Auto-extracted from coding task · Updated 1 time · Used 4 times.",
        ),
      ).toBeVisible();
      // Saved summary cards remain strictly read-only.
      await expect(autoCard.locator("input, textarea, select")).toHaveCount(0);

      // Expand preview and verify Scope & Applies to metadata.
      await autoCard
        .getByText("Preview instructions & dependent schedules")
        .click();
      await expect(autoCard.getByLabel("Settings")).toContainText(
        "Project · acme/api",
      );
      await expect(autoCard.getByLabel("Settings")).toContainText(
        "Coding & reviews",
      );

      // Filter by scope: Global only, then Project: acme/api, then empty acme/web + Reset filters.
      const scope = page.getByRole("combobox", { name: "Skill scope" });
      await chooseOption(scope, "global");
      await expect(cards).toHaveCount(1);
      await expect(cards.getByRole("heading")).toHaveText("Weekly ship log");

      await chooseOption(scope, "project:1001");
      await expect(cards).toHaveCount(1);
      await expect(cards.getByRole("heading")).toHaveText(
        "API DB test bootstrap",
      );

      await chooseOption(scope, "project:1002");
      await expect(cards).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "No skills match" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Reset filters" }).click();
      await expect(cards).toHaveCount(2);

      // Edit project skill scope to Global via shared modal.
      await autoCard.getByRole("button", { name: "Edit", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Edit API DB test bootstrap",
      });
      await expect(dialog).toBeVisible();
      const scopeField = dialog.getByRole("combobox", { name: "Scope" });
      await chooseOption(scopeField, "global");
      await dialog
        .getByRole("button", { name: "Save skill", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(
        autoCard.locator(".skill-card-title .pill", {
          hasText: /^Project · acme\/api$/,
        }),
      ).toHaveCount(0);

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: test.info().outputPath("skill-classification.png"),
        fullPage: true,
      });
    });
  }
}
