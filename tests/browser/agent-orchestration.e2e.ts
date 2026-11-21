import { expect, type Page, test } from "@playwright/test";
import type { AutonomyView } from "../../src/autonomy/policy.ts";
import type { RepoQueueView } from "../../src/coding/queue.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";

async function mountOrchestrationFixture(page: Page) {
  let autonomy: AutonomyView = {
    revision: 1,
    defaultMode: "supervised",
    l3ImmutableGates: [
      "Merge or close GitHub pull requests",
      "Publish GitHub Releases, tags, or release assets",
    ],
    repositories: [
      {
        id: 1001,
        full_name: "acme/backend",
        override: "inherit",
        effectiveMode: "supervised",
      },
      {
        id: 1002,
        full_name: "acme/landing",
        override: "check_in",
        effectiveMode: "check_in",
      },
    ],
  };

  let missions = [
    {
      id: "mission-1",
      actor: "101",
      chatId: "101",
      topicId: 0,
      status: "waiting",
      goal: "Investigate traffic drop and open draft fix PR",
      autonomyMode: "check_in",
      wakeupCount: 1,
      maxWakeups: 8,
      autoTimerCount: 1,
      maxAutoTimers: 3,
      spentUsd: 0.04,
      artifactCount: 1,
      createdAt: "2026-11-20T10:00:00.000Z",
      updatedAt: "2026-11-20T10:05:00.000Z",
    },
  ];

  let queues: RepoQueueView[] = [
    {
      queue: {
        workspaceId,
        repositoryId: 1001,
        repository: "acme/backend",
        paused: false,
        concurrency: 1,
        revision: 1,
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
      running: [
        {
          id: "q-1",
          workspaceId,
          repositoryId: 1001,
          repository: "acme/backend",
          actor: "101",
          chatId: "101",
          topicId: 0,
          title: "Fix retry loop in webhook worker",
          priority: 0,
          position: 1,
          status: "running",
          carryoverEnabled: true,
          createdAt: "2026-11-20T10:00:00.000Z",
          startedAt: "2026-11-20T10:00:01.000Z",
        },
      ],
      queued: [
        {
          id: "q-2",
          workspaceId,
          repositoryId: 1001,
          repository: "acme/backend",
          actor: "101",
          chatId: "101",
          topicId: 0,
          title: "Add metrics endpoint",
          priority: 0,
          position: 2,
          status: "queued",
          carryoverEnabled: true,
          createdAt: "2026-11-20T10:02:00.000Z",
        },
      ],
      recent: [],
    },
  ];

  let failNextAutonomySave = false;

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path === "/api/setup/status") {
      return route.fulfill({ json: { initialized: true, active: true } });
    }
    if (path === "/api/admin/auth/session") {
      return route.fulfill({
        json: {
          csrf: "csrf-token",
          admin: {
            id: "admin-1",
            username: "owner",
            telegramId: "101",
            operator: true,
          },
        },
      });
    }
    if (path === "/api/admin/workspaces") {
      return route.fulfill({ json: [{ id: workspaceId, name: "Acme Team" }] });
    }
    if (path === "/api/admin/updates") {
      return route.fulfill({
        json: { current: "0.1.50", latest: "0.1.50", available: false },
      });
    }
    if (path.endsWith("/autonomy") && !path.includes("/repositories/")) {
      if (req.method() === "PATCH") {
        if (failNextAutonomySave) {
          failNextAutonomySave = false;
          return route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
        }
        const body = req.postDataJSON();
        autonomy = {
          ...autonomy,
          revision: autonomy.revision + 1,
          defaultMode: body.defaultMode,
          repositories: autonomy.repositories.map((r) => ({
            ...r,
            effectiveMode:
              r.override === "inherit" ? body.defaultMode : r.override,
          })),
        };
      }
      return route.fulfill({ json: autonomy });
    }
    if (path.includes("/github/repositories/") && path.endsWith("/autonomy")) {
      const repoId = Number(path.split("/").at(-2));
      const body = req.postDataJSON();
      autonomy = {
        ...autonomy,
        revision: autonomy.revision + 1,
        repositories: autonomy.repositories.map((r) =>
          r.id === repoId
            ? {
                ...r,
                override: body.mode,
                effectiveMode:
                  body.mode === "inherit" ? autonomy.defaultMode : body.mode,
              }
            : r,
        ),
      };
      return route.fulfill({ json: autonomy });
    }
    if (path.endsWith("/missions")) {
      return route.fulfill({
        json: { items: missions, total: missions.length, offset: 0 },
      });
    }
    if (path.endsWith("/missions/mission-1")) {
      return route.fulfill({
        json: {
          mission: {
            ...missions[0],
            workspaceId,
            originSourceIds: ["src-1"],
            autonomyRevision: 1,
            fence: 1,
            artifacts: [
              {
                id: "art-1",
                kind: "pr",
                label: "Draft PR #42",
                value: "https://github.com/acme/landing/pull/42",
                at: "2026-11-20T10:04:00.000Z",
              },
            ],
            childTaskIds: ["task-1"],
          },
          waits: [
            {
              id: "wait-1",
              workspaceId,
              missionId: "mission-1",
              joinGroup: "jg-1",
              joinMode: "all",
              kind: "timer",
              targetId: "timer:1",
              status: "pending",
              reason: "Check CI status after 10 minutes",
              dueAt: "2026-11-20T10:15:00.000Z",
              createdAt: "2026-11-20T10:05:00.000Z",
            },
          ],
        },
      });
    }
    if (path.endsWith("/missions/mission-1/cancel")) {
      missions = missions.map((m) =>
        m.id === "mission-1" ? { ...m, status: "cancelled" } : m,
      );
      return route.fulfill({ json: { mission: missions[0] } });
    }
    if (path.endsWith("/queues")) {
      return route.fulfill({ json: { items: queues } });
    }
    if (path.endsWith("/queues/1001/pause")) {
      queues = queues.map((entry) => ({
        ...entry,
        queue: {
          ...entry.queue,
          paused: true,
          revision: entry.queue.revision + 1,
        },
      }));
      return route.fulfill({ json: { queue: queues[0]?.queue } });
    }
    if (path.endsWith("/queues/1001/resume")) {
      queues = queues.map((entry) => ({
        ...entry,
        queue: {
          ...entry.queue,
          paused: false,
          revision: entry.queue.revision + 1,
        },
      }));
      return route.fulfill({ json: { queue: queues[0]?.queue } });
    }
    if (path.endsWith("/queues/1001/items/q-2/pin")) {
      queues = queues.map((entry) => ({
        ...entry,
        queued: entry.queued.map((i) =>
          i.id === "q-2" ? { ...i, priority: i.priority + 1 } : i,
        ),
      }));
      return route.fulfill({ json: { item: queues[0]?.queued[0] } });
    }
    if (path.endsWith("/queues/1001/items/q-2/cancel")) {
      queues = queues.map((entry) => ({
        ...entry,
        queued: entry.queued.filter((i) => i.id !== "q-2"),
      }));
      return route.fulfill({ json: { cancelled: { id: "q-2" } } });
    }
    return route.fulfill({ json: {} });
  });

  return {
    setFailNextAutonomySave: (v: boolean) => {
      failNextAutonomySave = v;
    },
  };
}

test("Missions & Orchestration separates saved autonomy display from modal editors, manages missions, and controls repo queues", async ({
  page,
}) => {
  const ctl = await mountOrchestrationFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/admin/missions?workspace=${workspaceId}`);

  // Saved display is read-only text (no inline form controls inside the card)
  const autonomyCard = page.locator('section[aria-label="Autonomy policy"]');
  await expect(autonomyCard).toContainText("Supervised");
  await expect(autonomyCard).toContainText("acme/backend");
  await expect(autonomyCard).toContainText("acme/landing");
  await expect(autonomyCard.locator("select, input")).toHaveCount(0);

  // Open workspace autonomy modal, trigger error, verify draft retained, then succeed
  await autonomyCard
    .getByRole("button", { name: "Edit autonomy policy" })
    .click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await chooseOption(
    dialog.getByRole("combobox", { name: "Workspace default mode" }),
    "check_in",
  );

  ctl.setFailNextAutonomySave(true);
  await dialog.getByRole("button", { name: "Save policy" }).click();
  await expect(dialog).toContainText("version_conflict");

  // Retry succeeds and updates saved display
  await dialog.getByRole("button", { name: "Save policy" }).click();
  await expect(dialog).toBeHidden();
  await expect(autonomyCard).toContainText("Automatic with audit trail");

  // Inspect mission detail modal, then cancel mission via confirmation modal
  const missionsCard = page.locator(
    'section[aria-label="Background missions"]',
  );
  await expect(missionsCard).toContainText("Investigate traffic drop");
  await missionsCard.getByRole("button", { name: "View" }).click();
  const detailDialog = page.locator("dialog[open]");
  await expect(detailDialog).toContainText("Draft PR #42");
  await expect(detailDialog).toContainText("Check CI status after 10 minutes");
  await detailDialog
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(detailDialog).toBeHidden();

  await missionsCard.getByRole("button", { name: "Cancel" }).click();
  const cancelDialog = page.locator("dialog[open]");
  await cancelDialog
    .getByRole("button", { name: "Cancel mission", exact: true })
    .click();
  await expect(missionsCard).toContainText("cancelled");

  // Edit per-repository autonomy override via row Edit icon modal
  await autonomyCard
    .getByRole("button", { name: "Edit autonomy for acme/backend" })
    .click();
  const repoDialog = page.locator("dialog[open]");
  await expect(repoDialog).toBeVisible();
  await chooseOption(
    repoDialog.getByRole("combobox", { name: "Repository autonomy mode" }),
    "supervised",
  );
  await repoDialog.getByRole("button", { name: "Save override" }).click();
  await expect(repoDialog).toBeHidden();

  // Repository queue: single opposite-state Pause/Resume button + Pin + Cancel
  const queueCard = page.locator(
    'section[aria-label="Repository task queues"]',
  );
  await expect(queueCard).toContainText("acme/backend");
  await queueCard.getByRole("button", { name: "Pause queue" }).click();
  await expect(
    queueCard.getByRole("button", { name: "Resume queue" }),
  ).toBeVisible();
  await queueCard.getByRole("button", { name: "Resume queue" }).click();
  await expect(
    queueCard.getByRole("button", { name: "Pause queue" }),
  ).toBeVisible();

  await queueCard.getByRole("button", { name: "Pin" }).click();
  await expect(queueCard).toContainText("Add metrics endpoint");

  // Mobile 390px and dark theme check: no horizontal page overflow
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(autonomyCard).toBeVisible();
  await expect(missionsCard).toBeVisible();
  await expect(queueCard).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  expect(overflow).toBe(false);
});
