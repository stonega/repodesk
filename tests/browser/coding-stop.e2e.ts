import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodingPage, CodingTask } from "../../src/coding/config.ts";
import type { DevelopmentTask } from "../../src/coding/development.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;

async function fixture(page: Page) {
  const now = new Date().toISOString();
  const reviewed: CodingTask = {
    id: "1e8f2aab-3b09-4e8e-858e-75c20d832517",
    actor: "101",
    runId: "fixture-run",
    chatId: "101",
    topicId: 3,
    state: "running",
    createdAt: now,
    updatedAt: now,
    payload: {
      repositoryId: 7001,
      repository: "example/repo",
      installationId: 501,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      backend: "podman",
      authMode: "device_code",
      title: "Reviewed fixture task",
      body: "Fixture",
    },
  };
  const continuous: DevelopmentTask = {
    ...reviewed,
    id: "2e8f2aab-3b09-4e8e-858e-75c20d832517",
    payload: { ...reviewed.payload, title: "Continuous fixture task" },
    workspaceId,
    botId: "999",
    sourceId: "fixture-source",
    policy: { executionMode: "direct", publishByDefault: false },
    state: "working",
    phase: "work",
    revision: 1,
    consumedRevision: 1,
    verifiedRevision: 0,
    fence: 1,
    attempts: 1,
    tokens: 0,
    activeMs: 0,
    canImplement: true,
    canPublish: false,
    cancelRequested: false,
  };
  const data: CodingPage = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "device_code",
      repositories: [],
    },
    repositories: [],
    members: [],
    tasks: [reviewed],
    developmentTasks: [continuous],
    legacyActionsConfiguration: false,
    providerApiKeyConfigured: false,
    deviceAuth: { state: "connected" },
  };
  const cancellations: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith(`${endpoint}/`) && path.endsWith("/cancel")) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      const task = [reviewed, continuous].find(
        (task) => path === `${endpoint}/${task.id}/cancel`,
      );
      if (!task) throw new Error("Unexpected cancellation target");
      cancellations.push(task.id);
      task.cancelRequested = true;
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Stop fixture" }]
              : path === endpoint
                ? data
                : {},
    });
  });
  await page.goto(`/admin/plugins/codex?workspace=${workspaceId}`);
  await expect(
    page.getByRole("region", { name: "Coding tasks" }),
  ).toContainText(continuous.payload.title);
  return { reviewed, continuous, cancellations };
}

for (const width of [1280, 390]) {
  for (const mode of ["reviewed", "continuous"] as const) {
    test(`${mode} Stop requires confirmation at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await fixture(page);
      const task = f[mode];
      const row = page.getByRole("row").filter({ hasText: task.payload.title });
      const stop = row.getByRole("button", {
        name: `Stop coding task ${task.payload.title}`,
      });
      await expect(stop).toHaveText("");
      await expect(stop).toHaveAttribute(
        "title",
        `Stop coding task ${task.payload.title}`,
      );
      await stop.click();
      const dialog = page.getByRole("dialog", { name: "Stop coding task?" });
      await expect(dialog).toContainText(task.payload.title);
      await expect(dialog).toContainText(task.payload.repository);
      await expect(dialog).toContainText("remain on GitHub");
      expect(f.cancellations).toEqual([]);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(stop).toBeFocused();
      expect(f.cancellations).toEqual([]);
      await stop.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(f.cancellations).toEqual([]);
      await stop.click();
      await dialog.screenshot({
        path: test.info().outputPath("stop-confirmation.png"),
      });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await dialog.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(stop).toBeDisabled();
      expect(f.cancellations).toEqual([task.id]);
      const other = f[mode === "reviewed" ? "continuous" : "reviewed"];
      await expect(
        page.getByRole("button", {
          name: `Stop coding task ${other.payload.title}`,
        }),
      ).toBeEnabled();
    });
  }
}

test("pending Stop locks the modal and rejected cancellation can be retried", async ({
  page,
}) => {
  const f = await fixture(page);
  const cancelPath = `**${endpoint}/${f.reviewed.id}/cancel`;
  let held: Route | undefined;
  let attempts = 0;
  await page.route(cancelPath, async (route) => {
    attempts++;
    held = route;
  });
  await page
    .getByRole("button", {
      name: `Stop coding task ${f.reviewed.payload.title}`,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Stop coding task?" });
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Stopping…" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Close Stop coding task?" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!held).toBe(true);
  expect(attempts).toBe(1);
  await held?.fulfill({ status: 403, json: { error: "access_denied" } });
  await expect(dialog.getByRole("alert")).toContainText("access_denied");
  await expect(
    dialog.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  expect(f.cancellations).toEqual([]);
  await page.unroute(cancelPath);
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.cancellations).toEqual([f.reviewed.id]);
});

test("task completion while confirming disables Stop without cancelling", async ({
  page,
}) => {
  const f = await fixture(page);
  await page
    .getByRole("button", {
      name: `Stop coding task ${f.continuous.payload.title}`,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Stop coding task?" });
  f.continuous.state = "cancelled";
  await expect(dialog.getByRole("status")).toContainText(
    "no longer available",
    {
      timeout: 10000,
    },
  );
  await expect(
    dialog.getByRole("button", { name: "Stop", exact: true }),
  ).toBeDisabled();
  expect(f.cancellations).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
