import { expect, type Page, test } from "@playwright/test";
import type { CodingPage, CodingSettings } from "../../src/coding/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;

async function fixture(page: Page) {
  const data: CodingPage = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
      repositories: [
        { repositoryId: 1, baseBranch: "develop", maintainers: ["101"] },
      ],
    },
    repositories: [
      { id: 1, full_name: "stonega/configured" },
      { id: 2, full_name: "stonega/deepx-web" },
      { id: 3, full_name: "team/deepx-node" },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: index + 4,
        full_name: `team/repository-${index}`,
      })),
    ],
    members: [{ id: "101", active: true, username: "maintainer" }],
    tasks: [],
    providerApiKeyConfigured: true,
    legacyActionsConfiguration: false,
  };
  const saved: CodingSettings[] = [];
  const attemptedRevisions: number[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint && route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      attemptedRevisions.push(body.revision);
      if (body.revision !== data.revision) {
        await route.fulfill({
          status: 409,
          json: { error: "version_conflict" },
        });
        return;
      }
      saved.push(body.settings);
      data.settings = body.settings;
      data.revision += 1;
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Repository search fixture" }]
            : path === endpoint
              ? data
              : {};
    await route.fulfill({ json });
  });
  await page.goto(`/admin/plugins/codex?workspace=${workspaceId}`);
  await page.getByRole("button", { name: "Add coding repository" }).click();
  return {
    data,
    attemptedRevisions,
    saved,
    dialog: page.getByRole("dialog", { name: "Add coding repository" }),
  };
}

for (const width of [1280, 390]) {
  test(`repository search filters and saves a result at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { saved, dialog } = await fixture(page);
    const search = dialog.getByRole("combobox", {
      name: "Repository",
      exact: true,
    });
    await expect(search).toBeFocused();
    await expect(
      dialog.getByRole("option", { name: "stonega/configured" }),
    ).toHaveCount(0);
    await search.fill("  DEEPX  ");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      2,
    );
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(search).toHaveValue("team/deepx-node");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(saved).toHaveLength(0);
    await search.click();
    await search.fill("STONEGA/");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await dialog.getByRole("option", { name: "stonega/deepx-web" }).click();
    await expect(search).toBeFocused();
    await search.fill("no-such-repository");
    await expect(dialog.getByRole("status")).toHaveText(
      "No repositories match your search.",
    );
    await search.press("Enter");
    expect(saved).toHaveLength(0);
    await search.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(search).toHaveValue("stonega/deepx-web");
    await search.press("ArrowDown");
    await search.press("End");
    const lastOption = dialog.getByRole("listbox").getByRole("option").last();
    await expect(lastOption).toHaveAttribute("data-active", "true");
    await expect(lastOption).toBeInViewport();
    await search.fill("deepx");
    await dialog.screenshot({
      path: test.info().outputPath("repository-search.png"),
    });
    await search.press("Tab");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await expect(search).toHaveValue("stonega/deepx-web");
    await dialog.getByRole("checkbox", { name: /@maintainer/ }).check();
    await dialog
      .getByRole("button", { name: "Save coding repository" })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(saved[0]?.repositories.at(-1)?.repositoryId).toBe(2);
    expect(saved[0]?.repositories.at(-1)?.maintainers).toEqual(["101"]);
    await page
      .getByRole("button", { name: "Edit coding repository 2" })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit coding repository" });
    const editSearch = edit.getByRole("combobox", {
      name: "Repository",
      exact: true,
    });
    await expect(
      edit.getByRole("option", { name: "stonega/deepx-web" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      edit.getByRole("option", { name: "stonega/configured" }),
    ).toHaveCount(0);
    await editSearch.fill("missing");
    await editSearch.press("Escape");
    await expect(editSearch).toHaveValue("stonega/deepx-web");
    await editSearch.press("Escape");
    await expect(edit).toHaveCount(0);
    expect(saved).toHaveLength(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("typing text requires an actual repository selection", async ({
  page,
}) => {
  const { saved, dialog } = await fixture(page);
  const search = dialog.getByRole("combobox", {
    name: "Repository",
    exact: true,
  });
  await search.fill("stonega/deepx-web");
  await dialog.getByRole("checkbox", { name: /@maintainer/ }).check();
  await dialog.getByRole("button", { name: "Save coding repository" }).click();
  await expect(dialog).toBeVisible();
  expect(saved).toHaveLength(0);
  expect(
    await search.evaluate(
      (element: HTMLInputElement) => element.validity.valid,
    ),
  ).toBe(false);
});

test("repository metadata refresh preserves selection and unsaved branch and maintainer edits", async ({
  page,
}) => {
  const { data, saved, dialog, attemptedRevisions } = await fixture(page);
  const search = dialog.getByRole("combobox", {
    name: "Repository",
    exact: true,
  });
  await search.fill("deepx-web");
  await dialog.getByRole("option", { name: "stonega/deepx-web" }).click();
  await dialog
    .getByLabel("Development / base branch", { exact: true })
    .fill("draft-branch");
  await dialog.getByRole("checkbox", { name: /@maintainer/ }).check();
  data.repositories = data.repositories.map((repo) => ({
    ...repo,
    full_name:
      repo.id === 1
        ? "stonega/renamed-configured"
        : repo.id === 2
          ? "stonega/renamed-web"
          : repo.full_name,
  }));
  data.revision = 2;
  data.settings.repositories = data.settings.repositories.map((repo) => ({
    ...repo,
    baseBranch: "remote-change",
  }));
  await expect(
    page.getByText("stonega/renamed-configured", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(search).toHaveValue("stonega/renamed-web");
  await expect(
    dialog.getByLabel("Development / base branch", { exact: true }),
  ).toHaveValue("draft-branch");
  await expect(
    dialog.getByRole("checkbox", { name: /@maintainer/ }),
  ).toBeChecked();
  await expect(dialog).toBeVisible();
  expect(saved).toHaveLength(0);
  await dialog.getByRole("button", { name: "Save coding repository" }).click();
  await expect(dialog).toContainText("Settings changed in another session");
  expect(attemptedRevisions).toEqual([1]);
  expect(saved).toHaveLength(0);
});
