import { expect, type Page, test } from "@playwright/test";
import type { RuntimeView } from "../../src/coding/runtime-config.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const runtimeEndpoint = "/api/admin/operator/coding-runtime";
async function fixture(page: Page) {
  const view: RuntimeView = {
    revision: 4,
    selection: null,
    engine: "docker",
    environmentDefault: "docker",
    retainedTasks: 0,
  };
  const writes: unknown[] = [];
  let failure = "";
  let hold: Promise<void> | undefined;
  let loading: Promise<void> | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === runtimeEndpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await hold;
        if (failure) {
          await route.fulfill({ status: 409, json: { error: failure } });
          return;
        }
        Object.assign(view, {
          ...body,
          revision: view.revision + 1,
          engine: body.selection ?? "docker",
        });
      } else await loading;
      await route.fulfill({ json: view });
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
              ? [{ id: workspace, name: "Runtime fixture" }]
              : path.endsWith("/plugins/coding")
                ? {
                    revision: 1,
                    settings: {
                      enabled: true,
                      backend: "podman",
                      authMode: "provider_key",
                    },
                    repositories: [],
                    tasks: [],
                    legacyActionsConfiguration: false,
                    providerApiKeyConfigured: false,
                  }
                : {},
    });
  });
  return {
    view,
    writes,
    fail: (code: string) => {
      failure = code;
    },
    hold: (p: Promise<void> | undefined) => {
      hold = p;
    },
    loading: (p: Promise<void>) => {
      loading = p;
    },
    open: () => page.goto(`/admin/plugins/codex?workspace=${workspace}`),
  };
}
async function choose(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: "Edit Codex runtime" });
  await dialog.getByRole("combobox", { name: "Execution environment" }).click();
  await expect(
    page.getByRole("option", { name: /^(microsandbox|Podman)$/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(3);
  if (name === "OpenSandbox")
    await page.screenshot({ path: test.info().outputPath("options.png") });
  await page.getByRole("option", { name, exact: true }).click();
  return dialog;
}
for (const width of [1280, 390]) {
  test(`runtime saved summary, modal save, cancel and environment reset at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const card = page.getByRole("region", {
      name: "Codex runtime",
      exact: true,
    });
    await expect(card).toContainText("Docker");
    await expect(card).toContainText("Environment variable");
    await expect(card.getByRole("combobox")).toHaveCount(0);
    const editBox = await card
      .getByRole("button", { name: "Edit Codex runtime" })
      .boundingBox();
    const titleBox = await card
      .getByRole("heading", { name: "Runtime", exact: true })
      .boundingBox();
    expect(
      editBox &&
        titleBox &&
        editBox.y < titleBox.y + 44 &&
        editBox.x > titleBox.x + 100,
    ).toBe(true);
    await card.screenshot({ path: test.info().outputPath("saved.png") });
    await card.getByRole("button", { name: "Edit Codex runtime" }).click();
    let dialog = await choose(page, "OpenSandbox");
    await dialog.screenshot({ path: test.info().outputPath("editor.png") });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toEqual([{ revision: 4, selection: "opensandbox" }]);
    await expect(card).toContainText("OpenSandbox");
    await expect(card).toContainText("Admin panel");
    await card.getByRole("button", { name: "Edit Codex runtime" }).click();
    dialog = await choose(page, "Docker");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toHaveLength(1);
    await expect(card).toContainText("OpenSandbox");
    await expect(
      card.getByRole("button", { name: "Edit Codex runtime" }),
    ).toBeFocused();
    await card.getByRole("button", { name: "Edit Codex runtime" }).click();
    dialog = await choose(page, "Follow environment variable (Docker)");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.writes[1]).toEqual({ revision: 5, selection: null });
    await expect(card).toContainText("Environment variable");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`runtime loading, locked pending save and retained-task error at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    let loaded = () => {};
    f.loading(
      new Promise<void>((resolve) => {
        loaded = resolve;
      }),
    );
    await f.open();
    const card = page.getByRole("region", {
      name: "Codex runtime",
      exact: true,
    });
    await expect(card).toHaveAttribute("aria-busy", "true");
    await expect(card).not.toContainText("Ready to switch");
    await card.screenshot({ path: test.info().outputPath("loading.png") });
    loaded();
    await card.getByRole("button", { name: "Edit Codex runtime" }).click();
    const dialog = await choose(page, "OpenSandbox");
    let release = () => {};
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.fail("coding_runtime_in_use");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close Edit Codex runtime" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(f.writes).toHaveLength(1);
    await dialog.screenshot({ path: test.info().outputPath("pending.png") });
    release();
    await expect(dialog.getByRole("alert")).toContainText(
      "retained checkpoints",
    );
    await expect(
      dialog.getByRole("combobox", { name: "Execution environment" }),
    ).toContainText("OpenSandbox");
    await expect(card).toContainText("Docker");
    await dialog.screenshot({ path: test.info().outputPath("error.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
}

for (const width of [1280, 390]) {
  test(`runtime follows dark theme at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const card = page.getByRole("region", {
      name: "Codex runtime",
      exact: true,
    });
    await expect(card).toContainText("Docker");
    await card.screenshot({ path: test.info().outputPath("saved-dark.png") });
    await card.getByRole("button", { name: "Edit Codex runtime" }).click();
    const dialog = await choose(page, "OpenSandbox");
    await dialog.screenshot({
      path: test.info().outputPath("editor-dark.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toEqual([]);
  });
  test(`unavailable runner has no invented settings and recovers on focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const unavailable = async (route: import("@playwright/test").Route) =>
      route.fulfill({
        status: 503,
        json: { error: "coding_runtime_control_unavailable" },
      });
    await page.route(`**${runtimeEndpoint}`, unavailable);
    await f.open();
    const card = page.getByRole("region", {
      name: "Codex runtime",
      exact: true,
    });
    await expect(card).not.toContainText("Ready to switch");
    await expect(card).not.toContainText("Docker");
    await expect(
      card.getByRole("button", { name: "Edit Codex runtime" }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText(
      "updated, connected Codex runner",
    );
    await card.screenshot({ path: test.info().outputPath("unavailable.png") });
    await page.unroute(`**${runtimeEndpoint}`, unavailable);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card).toContainText("Docker");
    await expect(
      card.getByRole("button", { name: "Edit Codex runtime" }),
    ).toBeEnabled();
  });
}
