import { expect, type Page, test } from "@playwright/test";
import type { CodingPage } from "../../src/coding/config.ts";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import type { CodingEnvironment } from "../../src/coding/local/protocol.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const codingEndpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
const envEndpoint = `${codingEndpoint}/environments`;
const volActive = "deepx-codex-env-a1b2c3d4e5f60718293a4b5c-7001";
const volIdle = "deepx-codex-env-a1b2c3d4e5f60718293a4b5c-7002";
const volDisconnected = "deepx-codex-env-a1b2c3d4e5f60718293a4b5c-9002";

async function fixture(
  page: Page,
  options: {
    environments?: CodingEnvironment[];
    activeTask?: boolean;
  } = {},
) {
  let environments: CodingEnvironment[] = options.environments ?? [
    { repositoryId: 7001, volume: volActive },
    { repositoryId: 7002, volume: volIdle },
    { repositoryId: 9002, volume: volDisconnected },
  ];
  const now = new Date().toISOString();
  const tasks: DevelopmentTask[] = options.activeTask
    ? [
        {
          id: "1e8f2aab-3b09-4e8e-858e-75c20d832517",
          actor: "101",
          chatId: "101",
          topicId: 3,
          workspaceId,
          botId: "999",
          sourceId: "fixture-source-1",
          policy: { publishByDefault: true },
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
          state: "working",
          createdAt: now,
          updatedAt: now,
          payload: {
            repositoryId: 7001,
            repository: "example/active-repo",
            installationId: 501,
            githubRevision: 1,
            configRevision: 1,
            baseBranch: "main",
            backend: "podman",
            authMode: "provider_key",
            title: "Active work task",
            body: "Fixture",
          },
        },
      ]
    : [];
  const codingPage: CodingPage = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
    },
    repositories: [
      { id: 7001, full_name: "example/active-repo" },
      { id: 7002, full_name: "example/web-app" },
    ],
    tasks,
    legacyActionsConfiguration: false,
    providerApiKeyConfigured: true,
  };

  let loadError = "";
  let resetError = "";
  let loadHold: Promise<void> | undefined;
  let resetHold: Promise<void> | undefined;
  const resets: number[] = [];

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === envEndpoint) {
      await loadHold;
      if (loadError) {
        await route.fulfill({
          status: loadError === "coding_runner_not_configured" ? 409 : 503,
          json: { error: loadError },
        });
        return;
      }
      await route.fulfill({ json: { environments } });
      return;
    }
    if (path.startsWith(`${envEndpoint}/`) && path.endsWith("/reset")) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      const repoId = Number(path.split("/").at(-2));
      resets.push(repoId);
      await resetHold;
      if (resetError) {
        await route.fulfill({
          status: resetError === "coding_environment_in_use" ? 409 : 503,
          json: { error: resetError },
        });
        return;
      }
      const before = environments.length;
      environments = environments.filter((e) => e.repositoryId !== repoId);
      await route.fulfill({ json: { removed: environments.length < before } });
      return;
    }
    if (path === "/api/admin/operator/coding-runtime") {
      await route.fulfill({
        json: {
          revision: 1,
          selection: null,
          engine: "docker",
          environmentDefault: "docker",
          retainedTasks: 0,
        },
      });
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
              ? [{ id: workspaceId, name: "Environment fixture" }]
              : path === codingEndpoint
                ? codingPage
                : {},
    });
  });

  return {
    resets,
    setLoadError: (code: string) => {
      loadError = code;
    },
    setResetError: (code: string) => {
      resetError = code;
    },
    setLoadHold: (p: Promise<void> | undefined) => {
      loadHold = p;
    },
    setResetHold: (p: Promise<void> | undefined) => {
      resetHold = p;
    },
    open: () => page.goto(`/admin/plugins/codex?workspace=${workspaceId}`),
  };
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`cached environments list, confirmation modal, pending lock and reset toast at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const f = await fixture(page, { activeTask: true });
      await f.open();

      const card = page.getByRole("region", {
        name: "Cached environments",
        exact: true,
      });
      await expect(card).toContainText("example/active-repo");
      await expect(card).toContainText("In use");
      await expect(card).toContainText("example/web-app");
      await expect(card).toContainText("Repository #9002");

      // Active repository reset control is disabled; idle repository reset is enabled.
      const activeReset = card.getByRole("button", {
        name: "Reset cached environment for example/active-repo",
      });
      const idleReset = card.getByRole("button", {
        name: "Reset cached environment for example/web-app",
      });
      await expect(activeReset).toBeDisabled();
      await expect(idleReset).toBeEnabled();
      await card.screenshot({
        path: test.info().outputPath("environments-list.png"),
      });

      // Open confirmation modal and test Cancel first (no POST, focus returns).
      await idleReset.click();
      const dialog = page.getByRole("dialog", {
        name: "Reset cached environment?",
      });
      await expect(dialog).toContainText("example/web-app");
      await expect(dialog).toContainText(volIdle);
      const resetButton = dialog.getByRole("button", {
        name: "Reset",
        exact: true,
      });
      const cancelButton = dialog.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      const resetBox = await resetButton.boundingBox();
      const cancelBox = await cancelButton.boundingBox();
      expect(
        resetBox &&
          cancelBox &&
          (resetBox.x < cancelBox.x || resetBox.y < cancelBox.y),
      ).toBe(true);
      await cancelButton.click();
      await expect(dialog).toHaveCount(0);
      expect(f.resets).toEqual([]);
      await expect(idleReset).toBeFocused();

      // Reopen, simulate 409 in-use error inside modal.
      await idleReset.click();
      f.setResetError("coding_environment_in_use");
      await resetButton.click();
      await expect(dialog.getByRole("alert")).toContainText(
        "currently using this cached environment",
      );
      await expect(card).toContainText("example/web-app");

      // Retry with pending lock, confirm Escape/Cancel disabled, then succeed.
      f.setResetError("");
      let release = () => {};
      f.setResetHold(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await resetButton.click();
      await expect(cancelButton).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await dialog.screenshot({
        path: test.info().outputPath("environments-reset-pending.png"),
      });
      release();

      await expect(dialog).toHaveCount(0);
      await expect(card).not.toContainText("example/web-app");
      await expect(
        page.getByRole("region", { name: "Notification" }),
      ).toContainText("Cached environment reset for example/web-app.");
      expect(f.resets).toEqual([7002, 7002]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }

  test(`cached environments loading, empty and load-error recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, { environments: [] });
    let finishLoad = () => {};
    f.setLoadHold(
      new Promise<void>((resolve) => {
        finishLoad = resolve;
      }),
    );
    await f.open();

    const card = page.getByRole("region", {
      name: "Cached environments",
      exact: true,
    });
    await expect(card).toHaveAttribute("aria-busy", "true");
    finishLoad();
    await expect(card).toHaveAttribute("aria-busy", "false");
    await expect(card).toContainText("No cached environments yet");

    // Verify card spacing has no leftover bottom gap outside padding.
    const spacing = await card.evaluate((el) => {
      const cardRect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const padBottom =
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderBottomWidth);
      const last = el.lastElementChild?.getBoundingClientRect();
      return {
        padBottom,
        gap: last ? Math.abs(cardRect.bottom - last.bottom - padBottom) : 999,
      };
    });
    expect(spacing.gap).toBeLessThan(1.5);

    // Load failure displays floating ErrorToast with Retry that recovers.
    f.setLoadError("coding_runner_unavailable");
    f.setLoadHold(undefined);
    await page.reload();
    await expect(card).toContainText("could not be loaded");
    const retry = page.getByRole("button", {
      name: "Retry loading cached environments",
    });
    await expect(retry).toBeVisible();
    f.setLoadError("");
    await retry.click();
    await expect(card).toContainText("No cached environments yet");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
