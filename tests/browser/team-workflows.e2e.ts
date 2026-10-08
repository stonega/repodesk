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
    next: [
      "2026-10-09T09:00:00Z",
      "2026-10-16T09:00:00Z",
      "2026-10-23T09:00:00Z",
    ],
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
      req.method() === "POST" &&
      path.endsWith("/workflows/repository-report/action")
    ) {
      const input = req.postDataJSON();
      expect(input.version).toBe(workflow.version);
      workflow.status = input.action === "delete" ? "deleted" : "paused";
      await route.fulfill({ json: workflow });
      return;
    }
    if (
      req.method() === "GET" &&
      path.endsWith("/workflows/repository-report")
    ) {
      await route.fulfill({
        json: {
          mode: "member",
          workflow,
          repositorySources: {
            revision: 2,
            repositories: w.github?.repositories,
          },
        },
      });
      return;
    }
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
                    items: workflow.status === "deleted" ? [] : [workflow],
                    total: workflow.status === "deleted" ? 0 : 1,
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

test("workflow cards link to readable details with local times and retain list pagination", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/admin/workflows?workspace=${f.w.id}&offset=100`);
  const card = page.locator(".workflow-card");
  await expect(card.getByText("Every Friday at 17:00")).toBeVisible();
  await expect(card.getByText("Asia/Taipei")).toBeVisible();
  await expect(card.locator("time")).toHaveText("Oct 9, 2026, 17:00");
  await expect(
    card.getByText("repository-report", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Repository report", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/admin/workflows/repository-report\\?workspace=${f.w.id}&offset=100`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: "Task", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Recap the team", { exact: true })).toBeVisible();
  await expect(page.getByText("Pinned version 1")).toBeVisible();
  await expect(
    page.getByText("repository-report", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Upcoming schedule times" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Recap the team", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "pause", exact: true }).click();
  await expect(page.getByText("Not scheduled while paused")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workflow-detail-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit proposal" }).click();
  await expect(
    page.getByRole("dialog").getByRole("checkbox", { name: "example/private" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "Back to Workflows" }).click();
  await expect(page).toHaveURL(
    `/admin/workflows?workspace=${f.w.id}&offset=100`,
  );
  await page.screenshot({
    path: "test-results/workflow-list-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Repository report", exact: true })
    .click();
  await page.getByRole("button", { name: "delete", exact: true }).click();
  await expect(page).toHaveURL(
    `/admin/workflows?workspace=${f.w.id}&offset=100`,
  );
  await expect(page.getByText("No scheduled workflows yet.")).toBeVisible();
});

test("operator workflow details remain read-only and recover from unavailable records", async ({
  page,
}) => {
  const f = await fixture(page);
  const workflow = {
    id: "operator-workflow",
    name: "Daily GitHub development report — stonega/repodesk",
    owner: "101",
    version: 2,
    status: "paused",
    budgetUsd: 0.1,
    recurrence: {
      frequency: "daily",
      weekday: 7,
      hour: 9,
      minute: 0,
      timezone: "Asia/Taipei",
    },
    next: ["2026-10-09T01:00:00Z"],
    reason: "Paused by owner",
  };
  let unavailable = false;
  await page.route("**/api/admin/workspaces/*/workflows/**", async (route) => {
    if (unavailable)
      await route.fulfill({ status: 404, json: { error: "not_found" } });
    else await route.fulfill({ json: { mode: "operator", workflow } });
  });
  await page.goto(`/admin/workflows/operator-workflow?workspace=${f.w.id}`);
  await expect(page.getByText("Not scheduled while paused")).toBeVisible();
  await expect(page.getByText("Every day at 09:00")).toBeVisible();
  await expect(
    page.getByText("Workspace schedule details are read-only here.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Task", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit proposal" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "pause", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/workflow-detail-desktop.png",
    fullPage: true,
  });
  unavailable = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Workflow not found or no longer available.",
  );
  await expect(page.locator(".workflow-card")).toHaveCount(0);
  unavailable = false;
  workflow.recurrence.frequency = "weekly";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: workflow.name }),
  ).toBeVisible();
  await expect(page.getByText("Every Sunday at 09:00")).toBeVisible();
});
