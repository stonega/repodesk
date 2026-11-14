import { expect, type Page, type Route, test } from "@playwright/test";
import type { GroupRepository } from "../../src/domain.ts";

const workspaceId = "b6e6d846-06b0-46ee-ac0c-47b617d17dcc";
async function fixture(page: Page) {
  const state = {
    revision: 0,
    binding: undefined as GroupRepository | undefined,
    available: true,
    empty: false,
    loadPending: false,
    loadFailed: false,
    savePending: false,
    saveFailed: false,
    pending: [] as Route[],
    writes: [] as { revision: number; repositoryId: number | null }[],
  };
  const repositories = [
    { id: 1, full_name: "example/product" },
    { id: 2, full_name: "example/website" },
  ];
  const model = () => ({
    revision: state.revision,
    binding: state.binding,
    available: state.available,
    repositories: state.empty ? [] : repositories,
  });
  const save = (input: { revision: number; repositoryId: number | null }) => {
    state.revision++;
    state.binding =
      input.repositoryId === null
        ? undefined
        : {
            revision: state.revision,
            repositoryId: input.repositoryId,
            full_name:
              repositories.find((r) => r.id === input.repositoryId)
                ?.full_name ?? "example/missing",
            botId: "999",
            installationId: 7,
            connectionRevision: 1,
            repositoryRevision: 0,
            savedBy: "101",
            savedAt: new Date().toISOString(),
          };
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/repository")) {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON();
        state.writes.push(input);
        if (state.savePending) {
          state.pending.push(route);
          return;
        }
        if (state.saveFailed) {
          await route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
          return;
        }
        save(input);
        await route.fulfill({ json: { ok: true } });
      } else if (state.loadPending) state.pending.push(route);
      else if (state.loadFailed)
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
      else await route.fulfill({ json: model() });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "Admin", operator: true },
                csrf: "fixture-csrf",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: "Feedback team" }]
              : path.endsWith("/chats")
                ? {
                    items: [
                      {
                        id: "-100100",
                        title: "Product feedback",
                        active: true,
                        collection: true,
                        visibleAll: true,
                        repository: state.binding,
                        repositoryRevision: state.revision,
                      },
                    ],
                  }
                : path.endsWith("/members")
                  ? { items: [], total: 0, version: 1 }
                  : path.endsWith("/access-requests")
                    ? { items: [], version: 1 }
                    : {},
    });
  });
  return { ...state, state, model, save };
}
const editor = (page: Page) =>
  page.getByRole("dialog", { name: "Edit group", exact: true });
async function open(page: Page) {
  await page.goto(`/admin/members?workspace=${workspaceId}`);
  await page.getByRole("button", { name: "Edit Product feedback" }).click();
  return editor(page);
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`group repository summary, modal selection, pending/error and removal at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("repodesk.theme", theme),
        theme,
      );
      const { state, save } = await fixture(page);
      const dialog = await open(page);
      const form = dialog.getByRole("form", { name: "Group repository" });
      const picker = form.getByRole("combobox", {
        name: "Repository",
        exact: true,
      });
      await expect(picker).toContainText("No group repository");
      await form.getByLabel("Search repositories").fill("product");
      await picker.click();
      await page
        .getByRole("option", { name: "example/product", exact: true })
        .click();
      await expect(picker).toContainText("example/product");
      await expect(dialog).toContainText("verified GitHub write access");
      state.saveFailed = true;
      await form
        .getByRole("button", { name: "Save repository", exact: true })
        .click();
      await expect(form.getByRole("alert")).toContainText("binding changed");
      await expect(picker).toContainText("example/product");
      await dialog
        .getByRole("heading", { name: "Edit group", exact: true })
        .scrollIntoViewIfNeeded();
      await dialog.screenshot({
        path: test.info().outputPath("binding-error-top.png"),
      });
      await form
        .getByRole("button", { name: "Save repository", exact: true })
        .scrollIntoViewIfNeeded();
      await dialog.screenshot({
        path: test.info().outputPath("binding-error.png"),
      });
      state.saveFailed = false;
      state.savePending = true;
      await form
        .getByRole("button", { name: "Save repository", exact: true })
        .click();
      await expect.poll(() => state.pending.length).toBe(1);
      await expect(
        form.getByRole("button", { name: "Saving…" }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Unlink group" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await dialog.screenshot({
        path: test.info().outputPath("binding-pending.png"),
      });
      expect(state.writes).toHaveLength(2);
      const pending = state.pending.shift();
      save(state.writes[1] ?? { revision: 0, repositoryId: 1 });
      await pending?.fulfill({ json: { ok: true } });
      state.savePending = false;
      await expect(dialog).toHaveCount(0);
      const groups = page.getByRole("region", { name: "Groups", exact: true });
      await expect(groups).toContainText("Repository: example/product");
      await expect(groups.locator("input, select, textarea")).toHaveCount(0);
      await expect(
        groups.getByRole("button", { name: "Edit Product feedback" }),
      ).toBeFocused();
      await groups
        .getByRole("region", { name: "Group access table" })
        .evaluate((element) => {
          element.scrollLeft = 0;
        });
      await groups.screenshot({
        path: test.info().outputPath("binding-saved.png"),
      });
      await groups
        .getByRole("button", { name: "Edit Product feedback" })
        .click();
      await expect(picker).toContainText("example/product");
      await picker.click();
      await page
        .getByRole("option", { name: "No group repository", exact: true })
        .click();
      await form
        .getByRole("button", { name: "Save repository", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(groups).not.toContainText("Repository:");
      expect(state.writes.at(-1)).toEqual({ revision: 1, repositoryId: null });
      await groups
        .getByRole("button", { name: "Edit Product feedback" })
        .click();
      await expect(picker).toContainText("No group repository");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
  test(`group repository loading, failed load, empty and unavailable binding at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { state, model, save } = await fixture(page);
    state.loadPending = true;
    const dialog = await open(page);
    const form = dialog.getByRole("form", { name: "Group repository" });
    await expect(form.getByLabel("Saved group repository")).toBeVisible();
    await expect(form.getByRole("combobox")).toBeDisabled();
    await dialog.screenshot({
      path: test.info().outputPath("binding-loading.png"),
    });
    await expect(
      form.getByRole("button", { name: "Save repository", exact: true }),
    ).toBeDisabled();
    await expect.poll(() => state.pending.length).toBe(1);
    await state.pending
      .shift()
      ?.fulfill({ status: 503, json: { error: "unavailable" } });
    await expect(form.getByRole("alert")).toContainText("Could not load");
    state.loadPending = false;
    state.empty = true;
    await form.getByRole("button", { name: "Reload saved repository" }).click();
    await expect(form).toContainText("No active public repositories");
    await dialog.screenshot({
      path: test.info().outputPath("binding-empty.png"),
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    save({ revision: 0, repositoryId: 9 });
    state.available = false;
    state.loadPending = true;
    await page.getByRole("button", { name: "Edit Product feedback" }).click();
    await expect.poll(() => state.pending.length).toBe(1);
    await state.pending.shift()?.fulfill({ json: model() });
    await expect(form).toContainText("saved binding is unavailable");
    await dialog.screenshot({
      path: test.info().outputPath("binding-unavailable.png"),
    });
    await expect(
      form.getByRole("button", { name: "Save repository", exact: true }),
    ).toBeDisabled();
    await form.getByRole("combobox").click();
    await page
      .getByRole("option", { name: "No group repository", exact: true })
      .click();
    await expect(
      form.getByRole("button", { name: "Save repository", exact: true }),
    ).toBeEnabled();
  });
}
