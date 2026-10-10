import { expect, type Page, test } from "@playwright/test";
import type { ReviewPage } from "../../src/review-bot/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/review-bot`;
async function fixture(page: Page, delay = false) {
  const data: ReviewPage = {
    revision: 1,
    settings: { enabled: false, repositories: [] },
    botHandle: "repodesk[bot]",
    webhookUrl: "https://repodesk.example/github/webhook/operator",
    webhookConfigured: true,
    repositories: [
      {
        id: 7001,
        full_name: "example/workspace",
        maintainers: [{ id: "101", name: "Alice" }],
      },
      {
        id: 7002,
        full_name: "example/second",
        maintainers: [{ id: "101", name: "Alice" }],
      },
    ],
    tasks: [],
  };
  const writes: unknown[] = [];
  const failures = { save: "" };
  const pending = { save: Promise.resolve() };
  let release: () => void = () => {};
  const wait = delay
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await pending.save;
        const error =
          failures.save ||
          (body.revision !== data.revision ? "version_conflict" : "");
        if (error) {
          await route.fulfill({ status: 409, json: { error } });
          return;
        }
        data.settings = body.settings;
        data.revision++;
      } else await wait;
      await route.fulfill({ json: data });
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
              ? [{ id: workspaceId, name: "Review fixture" }]
              : {},
    });
  });
  await page.goto(`/admin/plugins/review-bot?workspace=${workspaceId}`);
  return { data, writes, release, failures, pending };
}
for (const width of [1280, 390])
  test(`Review Bot selects repositories and saves independent policies at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await expect(
      page.getByRole("heading", { name: "Review Bot", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("@repodesk[bot]", { exact: true }),
    ).toBeVisible();
    const repositories = page.getByRole("region", {
      name: "Repositories",
      exact: true,
    });
    await expect(repositories.locator("form, input, select")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Add Review Bot repository",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Repository", exact: true }),
    ).toHaveValue("example/workspace");
    await expect(
      editor.getByRole("combobox", { name: "Repository", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("checkbox", {
        name: "Allow explicitly requested fixes to the same PR",
      })
      .check();
    await page.screenshot({
      path: `/tmp/repodesk-review-bot-editor-${width}.png`,
    });
    await editor
      .getByRole("button", { name: "Save repository", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toEqual({
      revision: 1,
      settings: {
        enabled: false,
        repositories: [
          {
            repositoryId: 7001,
            reviewer: "101",
            autoReview: true,
            acceptRequests: true,
            allowFixes: true,
          },
        ],
      },
    });
    const summary = repositories.getByRole("article", {
      name: "example/workspace",
      exact: true,
    });
    await expect(summary.getByText("Alice", { exact: true })).toBeVisible();
    await expect(summary.getByText("Allowed", { exact: true })).toBeVisible();
    await expect(repositories.locator("form, input, select")).toHaveCount(0);
    await summary
      .getByRole("button", { name: "Edit example/workspace", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", {
      name: "Edit Review Bot repository",
      exact: true,
    });
    await expect(
      editDialog.getByRole("combobox", { name: "Repository", exact: true }),
    ).toHaveValue("example/workspace");
    await expect(
      editDialog.getByRole("combobox", { name: "Repository", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await editDialog
      .getByRole("checkbox", {
        name: "Allow explicitly requested fixes to the same PR",
      })
      .uncheck();
    await editDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(editDialog).toHaveCount(0);
    expect(f.writes).toHaveLength(1);
    await expect(summary.getByText("Allowed", { exact: true })).toBeVisible();
    await summary
      .getByRole("button", { name: "Edit example/workspace", exact: true })
      .click();
    await expect(
      editDialog.getByRole("checkbox", {
        name: "Allow explicitly requested fixes to the same PR",
      }),
    ).toBeChecked();
    await editDialog
      .getByRole("checkbox", {
        name: "Automatically review open PRs and new commits",
      })
      .uncheck();
    await editDialog
      .getByRole("button", { name: "Save repository", exact: true })
      .click();
    await expect(editDialog).toHaveCount(0);
    expect(f.data.settings.repositories[0]?.autoReview).toBe(false);
    await page.getByRole("switch", { name: "Enable Review Bot" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Review Bot" }),
    ).toBeChecked();
    await expect.poll(() => f.writes.length).toBe(3);
    expect(f.data.settings.enabled).toBe(true);
    await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .click();
    await page.screenshot({
      path: `/tmp/repodesk-review-bot-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
test("Review Bot keeps its structure visible while configuration loads", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await expect(
    page.getByRole("heading", { name: "Review Bot", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "GitHub webhook configuration" }),
  ).toBeVisible();
  f.release();
  await expect(
    page.getByRole("switch", { name: "Enable Review Bot" }),
  ).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`Review Bot cancels creation and preserves other repositories during removal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const add = page.getByRole("button", {
      name: "Add repository",
      exact: true,
    });
    const editor = page.getByRole("dialog", {
      name: "Add Review Bot repository",
      exact: true,
    });
    await add.click();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(add).toBeFocused();
    expect(f.writes).toHaveLength(0);
    for (const name of ["example/workspace", "example/second"]) {
      await add.click();
      await expect(
        editor.getByRole("combobox", { name: "Repository", exact: true }),
      ).toHaveValue(name);
      await editor
        .getByRole("button", { name: "Save repository", exact: true })
        .click();
      await expect(editor).toHaveCount(0);
    }
    await expect(add).toBeDisabled();
    await page
      .getByRole("button", { name: "Edit example/second", exact: true })
      .click();
    const edit = page.getByRole("dialog", {
      name: "Edit Review Bot repository",
      exact: true,
    });
    await edit
      .getByRole("combobox", { name: "Repository", exact: true })
      .click();
    await expect(
      edit.getByRole("option", { name: "example/workspace", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Remove example/workspace", exact: true })
      .click();
    const removal = page.getByRole("dialog", {
      name: "Remove Review Bot repository",
      exact: true,
    });
    await removal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(2);
    await page
      .getByRole("button", { name: "Remove example/workspace", exact: true })
      .click();
    await removal
      .getByRole("button", { name: "Remove repository", exact: true })
      .click();
    await expect(removal).toHaveCount(0);
    expect(
      f.data.settings.repositories.map((target) => target.repositoryId),
    ).toEqual([7002]);
    await expect(
      page.getByRole("article", { name: "example/second", exact: true }),
    ).toBeVisible();
    await expect(add).toBeEnabled();
  });

  test(`Review Bot retains failed drafts and locks the editor while saving at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Add Review Bot repository",
      exact: true,
    });
    const fixes = editor.getByRole("checkbox", {
      name: "Allow explicitly requested fixes to the same PR",
    });
    await fixes.check();
    f.failures.save = "coding_direct_execution_disabled";
    await editor
      .getByRole("button", { name: "Save repository", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toHaveText(
      "Enable Direct execution for this repository in Codex before accepting fixes.",
    );
    await expect(fixes).toBeChecked();
    await expect(page.locator(".toast-error")).toHaveCount(0);
    expect(f.data.settings.repositories).toHaveLength(0);
    f.failures.save = "";
    let release = () => {};
    f.pending.save = new Promise<void>((resolve) => {
      release = resolve;
    });
    await editor
      .getByRole("button", { name: "Save repository", exact: true })
      .click();
    await expect(editor).toHaveAttribute("aria-busy", "true");
    await expect(fixes).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", {
        name: "Close Add Review Bot repository",
        exact: true,
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect.poll(() => f.writes.length).toBe(2);
    release();
    await expect(editor).toHaveCount(0);
    expect(f.writes).toHaveLength(2);
    expect(f.data.settings.repositories[0]?.allowFixes).toBe(true);
  });
}

test("Review Bot preserves the editor revision across polling and requires conflict recovery", async ({
  page,
}) => {
  await page.clock.install();
  const f = await fixture(page);
  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save repository", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit example/workspace", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Edit Review Bot repository",
    exact: true,
  });
  await editor
    .getByRole("checkbox", {
      name: "Automatically review open PRs and new commits",
    })
    .uncheck();
  f.data.settings.enabled = true;
  f.data.settings.repositories = f.data.settings.repositories.map((target) => ({
    ...target,
    acceptRequests: false,
  }));
  f.data.revision++;
  await page.clock.fastForward(10001);
  await expect(
    page.getByRole("switch", { name: "Enable Review Bot" }),
  ).toBeChecked();
  await editor
    .getByRole("button", { name: "Save repository", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toHaveText(
    "These settings changed. Reload the saved settings and try again.",
  );
  await expect(
    editor.getByRole("checkbox", {
      name: "Automatically review open PRs and new commits",
    }),
  ).not.toBeChecked();
  expect(f.writes[1]).toMatchObject({
    revision: 2,
    settings: { enabled: false },
  });
  expect(f.data.settings.repositories[0]?.autoReview).toBe(true);
  await editor
    .getByRole("button", { name: "Reload saved settings", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit example/workspace", exact: true })
    .click();
  await expect(
    editor.getByRole("checkbox", { name: "Accept tagged requests" }),
  ).not.toBeChecked();
  await expect(
    editor.getByRole("checkbox", {
      name: "Automatically review open PRs and new commits",
    }),
  ).toBeChecked();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("switch", { name: "Enable Review Bot" }).click();
  await expect(
    page.getByRole("switch", { name: "Enable Review Bot" }),
  ).not.toBeChecked();
  expect(f.writes[2]).toMatchObject({
    revision: 3,
    settings: { repositories: [{ acceptRequests: false }] },
  });
});

for (const width of [1280, 390])
  test(`Review Bot errors use recoverable toasts without shifting the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const f = await fixture(page);
    const toggle = page.getByRole("switch", { name: "Enable Review Bot" });
    await expect(toggle).toBeEnabled();
    const webhook = page.getByRole("heading", {
      name: "GitHub webhook",
      exact: true,
    });
    const position = await webhook.boundingBox();
    f.failures.save = "review_webhook_required";
    await toggle.click();
    const toast = page.getByRole("region", {
      name: "Notification",
      exact: true,
    });
    await expect(toast.getByRole("alert")).toHaveText(
      "Configure the GitHub webhook first.",
    );
    await expect(toast).toHaveCSS("position", "fixed");
    await expect(toast).toHaveClass(/toast-error/);
    await expect(toggle).not.toBeChecked();
    await expect(page.locator(".notice[role='alert']")).toHaveCount(0);
    expect(await webhook.boundingBox()).toEqual(position);
    const bounds = await toast.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.clock.fastForward(7000);
    await expect(toast).toBeVisible();
    await page.screenshot({
      path: `/tmp/repodesk-error-toast-${width}.png`,
      fullPage: true,
    });
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    await toggle.click();
    await expect(toast.getByRole("alert")).toHaveText(
      "Configure the GitHub webhook first.",
    );
    await toast
      .getByRole("button", { name: "Retry loading saved settings" })
      .click();
    await expect(toast).toHaveCount(0);
    f.failures.save = "";
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(toast.getByRole("status")).toHaveText(
      "Review Bot settings saved.",
    );
    await page.clock.fastForward(6001);
    await expect(toast).toHaveCount(0);
  });
