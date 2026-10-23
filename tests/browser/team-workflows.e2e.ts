import { expect, type Page, test } from "@playwright/test";
import type { Skill, Workflow } from "../../src/domain.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { spec } from "../fixtures.ts";
import {
  reusableSkill,
  successfulRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

async function fixture(page: Page, noSkill = false, unlinked = false) {
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
  if (noSkill) w.skills = [];
  const workflow: Workflow & { next: string[] } = {
    id: "repository-report",
    version: 1,
    owner: "101",
    status: "active",
    spec: {
      ...spec(w),
      name: "Repository report",
      github: { revision: 1, repositoryIds: [7001] },
    },
    skillVersion: noSkill ? undefined : 1,
    versions: [],
    next: [
      "2026-10-09T09:00:00Z",
      "2026-10-16T09:00:00Z",
      "2026-10-23T09:00:00Z",
    ],
  };
  Object.assign(workflow.spec, { budgetUsd: 0.1 });
  let saved:
    | {
        version: number;
        spec: {
          skillId?: string;
          github?: { revision: number; repositoryIds: number[] };
        };
      }
    | undefined;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path.endsWith("/workflows")) {
      workflow.spec = req.postDataJSON();
      workflow.skillVersion = undefined;
      workflow.status = "draft";
      saved = { version: 1, spec: workflow.spec };
      await route.fulfill({ json: { workflow, approval: {} } });
      return;
    }
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
          mode: unlinked ? "operator" : "member",
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
      expect(input).toEqual({ version: draft.version, action: "enable" });
      draft.published.push(structuredClone(draft.draft));
      draft.enabled = true;
      draft.version++;
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
                  ...(unlinked ? {} : { telegramId: "101" }),
                },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: w.id, name: "Team workflows" }]
              : path.endsWith("/workflows")
                ? {
                    mode: unlinked ? "operator" : "member",
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
  return { w, draft, workflow, saved: () => saved };
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
  const skill = dialog.getByRole("combobox", { name: "Skill", exact: true });
  await expect(skill).toHaveText(f.w.skills[0]?.draft.name as string);
  await skill.click();
  await page.getByRole("option", { name: "No skill", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Preview approval proposal" })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(f.saved()?.spec.github).toEqual({
    revision: 2,
    repositoryIds: [7001, 7002],
  });
  expect(f.saved()?.spec.skillId).toBeUndefined();
  expect(f.saved()?.spec).not.toHaveProperty("budgetUsd");
});

for (const width of [1280, 390]) {
  test(`unlinked admins manage free-form schedules in modals and retain drafts on failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, true, true);
    let finishLoading: (() => void) | undefined;
    let loading = true;
    await page.route(
      "**/api/admin/workspaces/*/workflows/repository-report",
      async (route) => {
        if (loading)
          await new Promise<void>((resolve) => {
            finishLoading = resolve;
          });
        await route.fallback();
      },
    );
    await page.goto(`/admin/workflows/repository-report?workspace=${f.w.id}`);
    await expect.poll(() => !!finishLoading).toBe(true);
    await expect(page.locator(".workflow-card")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/workflow-loading-${width}.png`,
      fullPage: true,
    });
    loading = false;
    finishLoading?.();
    await expect(page.getByText("No skill", { exact: true })).toBeVisible();
    await expect(page.getByText(/Pinned version/)).toHaveCount(0);
    await expect(page.locator(".workflow-card form")).toHaveCount(0);
    await expect(page.getByText("Budget per run", { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: `test-results/workflow-no-skill-detail-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Edit proposal" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Repository report" });
    await expect(edit.getByLabel("Budget per run (USD)")).toHaveCount(0);
    await expect(
      edit.getByRole("combobox", { name: "Skill", exact: true }),
    ).toHaveText("No skill");
    await edit
      .getByRole("button", { name: "Cancel", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/workflow-edit-${width}.png`,
      fullPage: true,
    });
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("link", { name: "Back to Workflows" }).click();
    await expect(page.getByText("Budget per run", { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: `test-results/workflow-list-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Add workflow" }).click();
    const dialog = page.getByRole("dialog", { name: "Propose a schedule" });
    await expect(dialog.getByLabel("Budget per run (USD)")).toHaveCount(0);
    await expect(
      dialog.getByRole("combobox", { name: "Skill", exact: true }),
    ).toHaveText("No skill");
    await dialog.getByLabel("Workflow name").fill("Daily reminder");
    await dialog
      .getByLabel("Task", { exact: true })
      .fill("Remind me to take a break");
    await dialog.getByLabel("Destination chat ID").fill("101");
    let finish: (() => void) | undefined;
    let fail = true;
    await page.route("**/api/admin/workspaces/*/workflows", async (route) => {
      if (route.request().method() !== "POST" || !fail) return route.fallback();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await route.fulfill({ status: 409, json: { error: "version_conflict" } });
    });
    await dialog
      .getByRole("combobox", { name: "Skill", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/workflow-no-skill-editor-${width}.png`,
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Preview approval proposal" })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: `test-results/workflow-no-skill-pending-${width}.png`,
      fullPage: true,
    });
    await expect.poll(() => !!finish).toBe(true);
    finish?.();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByLabel("Task", { exact: true })).toHaveValue(
      "Remind me to take a break",
    );
    await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/workflow-no-skill-error-${width}.png`,
      fullPage: true,
    });
    fail = false;
    await dialog
      .getByRole("button", { name: "Preview approval proposal" })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(f.saved()?.spec.skillId).toBeUndefined();
    expect(f.saved()?.spec).not.toHaveProperty("budgetUsd");
    await page
      .getByRole("link", { name: "Daily reminder", exact: true })
      .click();
    await expect(
      page.getByText("Remind me to take a break", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("No skill", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "delete", exact: true }).click();
    await expect(page.getByText("No scheduled workflows yet.")).toBeVisible();
    await page.screenshot({
      path: `test-results/workflow-empty-${width}.png`,
      fullPage: true,
    });
  });
}

test("conversation skill provenance and direct enablement remain usable on desktop and mobile", async ({
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
    card.getByText(/Review the instructions before enabling this skill/),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: /publish|draft|rollback/i }),
  ).toHaveCount(0);
  await expect(card.locator("input, textarea, select")).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/repodesk-team-workflows-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    card.getByRole("button", { name: "enable", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/repodesk-team-workflows-mobile.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "enable", exact: true }).click();
  await expect(
    card.getByText("Saved reusable instruction skill.", { exact: false }),
  ).toBeVisible();
  expect(f.draft.published).toHaveLength(1);
  expect(f.draft.enabled).toBe(true);
  await page.reload();
  await expect(
    card.getByText(/Saved from a conversation by 101/),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "disable", exact: true }),
  ).toBeEnabled();
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

test("unlinked admins see full workflow details and controls and recover from unavailable records", async ({
  page,
}) => {
  const f = await fixture(page, false, true);
  f.workflow.spec.name = "Daily GitHub development report — stonega/repodesk";
  f.workflow.status = "paused";
  f.workflow.spec.recurrence.frequency = "daily";
  f.workflow.spec.recurrence.hour = 9;
  let unavailable = false;
  await page.route(
    "**/api/admin/workspaces/*/workflows/repository-report",
    async (route) => {
      if (unavailable)
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      else await route.fallback();
    },
  );
  await page.goto(`/admin/workflows/repository-report?workspace=${f.w.id}`);
  await expect(page.getByText("Not scheduled while paused")).toBeVisible();
  await expect(page.getByText("Every day at 09:00")).toBeVisible();
  await expect(
    page.getByText(/Workspace schedule details are read-only/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Task", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit proposal" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "pause", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workflow-card form")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/workflow-operator-detail-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator(".workflow-card");
  const bounds = await card.boundingBox();
  const editBounds = await card
    .getByRole("button", { name: "Edit proposal" })
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(editBounds).not.toBeNull();
  if (bounds && editBounds) {
    expect(editBounds.x + editBounds.width).toBeGreaterThan(
      bounds.x + bounds.width - 30,
    );
    expect(editBounds.y).toBeLessThan(bounds.y + 32);
  }
  await page.screenshot({
    path: "test-results/workflow-operator-detail-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit proposal" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task", { exact: true })).toHaveValue(
    "Recap the team",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit proposal" }),
  ).toBeFocused();
  unavailable = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Workflow not found or no longer available.",
  );
  await expect(page.locator(".workflow-card")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/workflow-operator-unavailable-mobile.png",
    fullPage: true,
  });
  unavailable = false;
  f.workflow.spec.recurrence.frequency = "weekly";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: f.workflow.spec.name }),
  ).toBeVisible();
  await expect(page.getByText("Every Friday at 09:00")).toBeVisible();
  let approved = false;
  f.workflow.status = "draft";
  await page.route("**/api/admin/workspaces/*/approvals**", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ approve: true });
      approved = true;
      f.workflow.status = "active";
      await route.fulfill({ json: { decision: "approved" } });
    } else {
      await route.fulfill({
        json: {
          items: approved
            ? []
            : [
                {
                  id: "pending-workflow",
                  actor: "101",
                  kind: "workflow",
                  version: 1,
                  payload: { spec: f.workflow.spec, owner: "101" },
                  expiresAt: "2030-01-01T00:00:00Z",
                },
              ],
        },
      });
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "Approve exact proposal" }).click();
  await expect(page.getByText("No pending proposals.")).toBeVisible();
  await expect(page.locator(".workflow-card .pill")).toHaveText("active");
  expect(approved).toBe(true);
});
