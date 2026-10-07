import { expect, type Page, test } from "@playwright/test";
import type { Skill } from "../../src/domain.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { spec } from "../fixtures.ts";
import {
  reusableSkill,
  successfulRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

async function fixture(page: Page) {
  const w = teamWorkspace(),
    source = successfulRun(w);
  const draft: Skill = {
    id: "conversation-draft",
    version: 1,
    draft: {
      ...reusableSkill,
      tools: ["read_chat_context", "load_skill"],
      settings: { sections: "Evidence and next steps", maxWords: 400 },
    },
    published: [],
    enabled: false,
    archived: false,
    tests: [],
    origin: {
      actor: "101",
      runId: source.id,
      references: memoryReferences(source.sources),
      sharedAt: new Date().toISOString(),
    },
  };
  w.skills.push(draft);
  const workflow = {
    id: "repository-report",
    version: 1,
    owner: "101",
    status: "active",
    spec: {
      ...spec(w),
      name: "Repository report",
      github: { revision: 1, repositoryIds: [7001] },
    },
    skillVersion: 1,
    versions: [],
    next: [],
  };
  let saved:
    | {
        version: number;
        spec: { github?: { revision: number; repositoryIds: number[] } };
      }
    | undefined;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (
      req.method() === "PUT" &&
      path.endsWith("/workflows/repository-report")
    ) {
      saved = req.postDataJSON();
      await route.fulfill({ json: { workflow, approval: {} } });
      return;
    }
    if (
      req.method() === "POST" &&
      path.endsWith("/skills/conversation-draft/action")
    ) {
      const input = req.postDataJSON();
      if (input.action === "publish") {
        draft.published.push(structuredClone(draft.draft));
        draft.version++;
      }
      await route.fulfill({ json: draft });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: {
                  id: "fixture",
                  username: "fixture",
                  operator: true,
                  telegramId: "101",
                },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: w.id, name: "Team workflows" }]
              : path.endsWith("/workflows")
                ? {
                    mode: "member",
                    items: [workflow],
                    total: 1,
                    repositorySources: {
                      revision: 2,
                      repositories: w.github?.repositories,
                    },
                  }
                : path.endsWith("/skills")
                  ? {
                      items: w.skills.map((s) => ({ ...s, dependents: [] })),
                      total: w.skills.length,
                    }
                  : path.endsWith("/approvals")
                    ? { items: [] }
                    : {},
    });
  });
  return { w, draft, saved: () => saved };
}

test("repository schedule editing preserves selections and submits numeric sources with the current connection revision", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/admin/workflows?workspace=${f.w.id}`);
  await expect(page.getByText("Repositories: example/private")).toBeVisible();
  await page.getByRole("button", { name: "Edit proposal" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Repository report" });
  await expect(
    dialog.getByRole("checkbox", { name: "example/private" }),
  ).toBeChecked();
  await dialog.getByRole("checkbox", { name: "example/public" }).check();
  await dialog
    .getByRole("button", { name: "Preview approval proposal" })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(f.saved()?.spec.github).toEqual({
    revision: 2,
    repositoryIds: [7001, 7002],
  });
});

test("conversation skill provenance and explicit publication remain usable on desktop and mobile", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/admin/skills?workspace=${f.w.id}`);
  const card = page.locator(".skill-card").filter({
    has: page.getByRole("heading", { name: "Bug triage", exact: true }),
  });
  await expect(
    card.getByText(/Saved from a conversation by 101/),
  ).toBeVisible();
  await expect(
    card.getByText(/Publication saves this procedure independently/),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/repodesk-team-workflows-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    card.getByRole("button", { name: "Publish draft" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/repodesk-team-workflows-mobile.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "Publish draft" }).click();
  await expect(
    card.getByText("Approved reusable instruction skill.", { exact: false }),
  ).toBeVisible();
  expect(f.draft.published).toHaveLength(1);
});
