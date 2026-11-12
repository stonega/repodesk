import { expect, type Page, test } from "@playwright/test";
import type {
  CodeTruthPage,
  CodeTruthSettings,
} from "../../src/code-truth/config.ts";

const workspaceId = "41f439e6-eed2-4dcf-b6e6-85d5cf336c21";
const url = `/admin/plugins/code-truth?workspace=${workspaceId}`;
const initial: CodeTruthSettings = {
  enabled: true,
  repositories: [
    {
      id: "legacy-source",
      repositoryUrl: "https://github.com/example/application.git",
      description: "Application source and shared components.",
      workspaces: [workspaceId],
    },
  ],
};

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(page: Page, empty = false) {
  const state = {
    saved: structuredClone(empty ? { ...initial, repositories: [] } : initial),
    revision: 3,
    saves: [] as CodeTruthSettings[],
    loadGate: undefined as Promise<void> | undefined,
    saveGate: undefined as Promise<void> | undefined,
    failSave: false,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/plugins/code-truth")) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        state.saves.push(structuredClone(body.settings));
        await state.saveGate;
        if (state.failSave) {
          await route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
          return;
        }
        expect(body.revision).toBe(state.revision);
        state.saved = body.settings;
        state.revision++;
      } else {
        await state.loadGate;
      }
      const json: CodeTruthPage = {
        settings: state.saved,
        revision: state.revision,
        serviceConfigured: true,
        workspaces: [{ id: workspaceId, name: "Code Truth" }],
      };
      await route.fulfill({ json });
      return;
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "fixture",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Code Truth" }]
            : {};
    await route.fulfill({ json });
  });
  return state;
}

async function screenshot(page: Page, width: number, state: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `/tmp/repodesk-code-truth-${width}-${state}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const width of [1280, 390]) {
  test(`Code Truth uses URL and description, preserves IDs and recovers saves at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (theme) => localStorage.setItem("repodesk.theme", theme),
      width === 390 ? "dark" : "light",
    );
    const state = await fixture(page);
    await page.goto(url);
    const card = page.getByRole("article", {
      name: "Repository 1",
      exact: true,
    });
    await expect(
      card.getByRole("heading", { name: "example/application", exact: true }),
    ).toBeVisible();
    await expect(card).toContainText(
      "Application source and shared components.",
    );
    await expect(card.locator("input, select, textarea")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save Code Truth", exact: true }),
    ).toHaveCount(0);
    const repositories = page.getByRole("region", {
      name: "Code Truth repositories",
      exact: true,
    });
    const heading = await repositories
      .getByRole("heading", { name: "Repositories", exact: true })
      .boundingBox();
    const action = await repositories
      .getByRole("button", { name: "Add repository", exact: true })
      .boundingBox();
    if (!heading || !action)
      throw Error("Missing repository heading or action");
    expect(Math.abs(heading.y - action.y)).toBeLessThan(2);
    expect(action.x).toBeGreaterThan(heading.x + heading.width);
    await screenshot(page, width, "summary");
    await card
      .getByRole("button", { name: "Edit repository 1", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit repository example/application",
      exact: true,
    });
    await expect(editor.getByLabel("GitHub repository URL")).toBeFocused();
    await expect(editor.locator("input")).toHaveCount(1);
    await expect(editor.getByLabel("Repository ID")).toHaveCount(0);
    await expect(
      editor.getByRole("group", { name: "Networks and branches" }),
    ).toHaveCount(0);
    await expect(editor.getByLabel("Description")).toHaveValue(
      initial.repositories[0]?.description ?? "",
    );
    await editor.getByLabel("Description").fill("Discard this edit");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).not.toContainText("Discard this edit");
    expect(state.saves).toHaveLength(0);
    await expect(
      card.getByRole("button", { name: "Edit repository 1", exact: true }),
    ).toBeFocused();
    await card
      .getByRole("button", { name: "Edit repository 1", exact: true })
      .click();
    await editor
      .getByLabel("Description")
      .fill("Backend APIs and background jobs.\nUse for service behavior.");
    await screenshot(page, width, "editor");
    const pending = gate();
    state.saveGate = pending.promise;
    state.failSave = true;
    const confirm = editor.getByRole("button", {
      name: "Confirm",
      exact: true,
    });
    await confirm.click();
    await expect(editor).toHaveAttribute("aria-busy", "true");
    await expect(
      editor.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(editor.getByLabel("GitHub repository URL")).toBeDisabled();
    await expect(editor.getByLabel("Description")).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", {
        name: "Close Edit repository example/application",
        exact: true,
      }),
    ).toBeDisabled();
    await editor.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    expect(state.saves).toHaveLength(1);
    expect(state.saved.repositories[0]?.description).toBe(
      initial.repositories[0]?.description,
    );
    await screenshot(page, width, "pending");
    pending.release();
    await expect(editor.getByRole("alert")).toContainText(
      "Plugin settings changed in another session",
    );
    await expect(confirm).toBeEnabled();
    await expect(editor.getByLabel("Description")).toHaveValue(
      "Backend APIs and background jobs.\nUse for service behavior.",
    );
    await expect(page.locator(".toast").getByRole("alert")).toHaveCount(0);
    await screenshot(page, width, "error");
    state.failSave = false;
    await confirm.click();
    await expect(editor).toHaveCount(0);
    await expect(card).toContainText("Backend APIs and background jobs.");
    await expect(page.locator(".toast").getByRole("status")).toContainText(
      "Code Truth saved",
    );
    expect(state.saved.repositories[0]?.id).toBe("legacy-source");
    expect(state.saved.repositories[0]).not.toHaveProperty("networks");
    await page.reload();
    await expect(card).toContainText("Use for service behavior.");
    await card
      .getByRole("button", { name: "Edit repository 1", exact: true })
      .click();
    await editor.getByLabel("Description").fill("");
    await editor.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".toast").getByRole("status")).toContainText(
      "Code Truth saved",
    );
    await expect(
      card.locator(".code-truth-repository-details > p"),
    ).toHaveCount(1);
    const spacing = await card.evaluate((element) => {
      const details = element.querySelector(".code-truth-repository-details");
      if (!details?.firstElementChild || !details.lastElementChild)
        throw Error("Missing saved details");
      return {
        first: getComputedStyle(details.firstElementChild).marginTop,
        last: getComputedStyle(details.lastElementChild).marginBottom,
      };
    });
    expect(spacing).toEqual({ first: "0px", last: "0px" });
    const bottom = await repositories.evaluate((element) => {
      const list = element.querySelector(".repository-list");
      if (!list) throw Error("Missing repository list");
      return (
        element.getBoundingClientRect().bottom -
        list.getBoundingClientRect().bottom
      );
    });
    expect(bottom).toBeLessThan(30);
    await screenshot(page, width, "without-description");
  });

  test(`Code Truth loading, empty state and creation need no internal IDs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page, true);
    const loading = gate();
    state.loadGate = loading.promise;
    await page.goto(url);
    await expect(
      page.getByRole("region", {
        name: "Code Truth repositories",
        exact: true,
      }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("No repositories configured.")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add repository", exact: true }),
    ).toBeDisabled();
    await screenshot(page, width, "loading");
    loading.release();
    await expect(page.getByText("No repositories configured.")).toBeVisible();
    await screenshot(page, width, "empty");
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Add repository",
      exact: true,
    });
    await expect(editor.locator("input")).toHaveCount(1);
    await editor
      .getByLabel("GitHub repository URL")
      .fill("https://example.com/not-github");
    await editor.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "HTTPS GitHub repository URL",
    );
    expect(state.saves).toHaveLength(0);
    await editor
      .getByLabel("GitHub repository URL")
      .fill("https://github.com/example/new-project.git");
    await editor.getByLabel("Description").fill("General project context.");
    await editor.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(state.saves).toHaveLength(1);
    await expect(page.locator(".toast").getByRole("status")).toContainText(
      "Code Truth saved",
    );
    expect(state.saved.repositories[0]?.id).toMatch(/^repo-[0-9a-f-]{36}$/);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "example/new-project", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    await editor
      .getByLabel("GitHub repository URL")
      .fill("https://github.com/EXAMPLE/new-project");
    await editor.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(editor.getByRole("alert")).toHaveText(
      "This repository is already configured.",
    );
    await screenshot(page, width, "duplicate");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    expect(state.saved.repositories).toHaveLength(1);
    expect(state.saves).toHaveLength(1);
  });

  test(`Code Truth removal and enablement save immediately at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page);
    await page.goto(url);
    const card = page.getByRole("article", {
      name: "Repository 1",
      exact: true,
    });
    const toggle = page.getByRole("switch", {
      name: "Enable Code Truth",
      exact: true,
    });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(state.saved.repositories).toEqual(initial.repositories);
    await page.reload();
    await expect(toggle).not.toBeChecked();
    const pending = gate();
    state.saveGate = pending.promise;
    state.failSave = true;
    const remove = card.getByRole("button", {
      name: "Remove repository 1",
      exact: true,
    });
    await remove.click();
    await expect(remove).toBeDisabled();
    await expect(toggle).toBeDisabled();
    await expect(card).toBeVisible();
    pending.release();
    await expect(page.getByRole("alert")).toContainText(
      "Plugin settings changed",
    );
    await expect(remove).toBeEnabled();
    expect(state.saved.repositories).toEqual(initial.repositories);
    await screenshot(page, width, "remove-error");
    state.failSave = false;
    await remove.click();
    await expect(page.getByText("No repositories configured.")).toBeVisible();
    expect(state.saved.repositories).toHaveLength(0);
    await page.reload();
    await expect(page.getByText("No repositories configured.")).toBeVisible();
    await screenshot(page, width, "removed");
  });
}
