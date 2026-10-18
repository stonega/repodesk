import { expect, type Page, test } from "@playwright/test";
import type { CodingPage } from "../../src/coding/config.ts";
import { emptyCoding } from "../../src/coding/config.ts";
import { emptyReview, type ReviewPage } from "../../src/review-bot/config.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
type Plugin = "codex" | "review-bot";
async function fixture(
  page: Page,
  plugin: Plugin,
  loading = false,
  loadError = "",
) {
  const coding: CodingPage = {
    revision: 1,
    settings: { ...emptyCoding, enabled: true },
    repositories: [{ id: 7001, full_name: "example/workspace" }],
    tasks: [],
    providerApiKeyConfigured: true,
    legacyActionsConfiguration: false,
  };
  const review: ReviewPage = {
    revision: 1,
    settings: { ...emptyReview, enabled: true },
    tasks: [],
    botHandle: "repodesk[bot]",
    webhookConfigured: true,
    webhookUrl: "https://example.com/github/webhook/operator",
  };
  const data = plugin === "codex" ? coding : review;
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/${plugin === "codex" ? "coding" : plugin}`;
  const writes: { revision: number; settings: Record<string, unknown> }[] = [];
  let releaseLoad = () => {};
  const loaded = loading
    ? new Promise<void>((resolve) => {
        releaseLoad = resolve;
      })
    : Promise.resolve();
  const controls = { error: "", loadError, pending: Promise.resolve() };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON();
        writes.push(input);
        await controls.pending;
        const error =
          controls.error ||
          (input.revision !== data.revision ? "version_conflict" : "");
        if (error) {
          await route.fulfill({ status: 409, json: { error } });
          return;
        }
        data.settings = input.settings;
        data.revision++;
      } else {
        if (controls.loadError) {
          await route.fulfill({
            status: 503,
            json: { error: controls.loadError },
          });
          return;
        }
        await loaded;
      }
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
              ? [{ id: workspaceId, name: "GitHub permissions" }]
              : { providers: [] },
    });
  });
  await page.goto(`/admin/plugins/${plugin}?workspace=${workspaceId}`);
  return { coding, review, data, writes, controls, releaseLoad };
}
function editorName(plugin: Plugin) {
  return plugin === "codex"
    ? "Edit Codex configuration"
    : "Edit Review Bot configuration";
}
function regionName(plugin: Plugin) {
  return plugin === "codex"
    ? "Codex configuration"
    : "Review Bot configuration";
}
async function openEditor(page: Page, plugin: Plugin) {
  await page
    .getByRole("button", { name: editorName(plugin), exact: true })
    .click();
  return page.getByRole("dialog", { name: editorName(plugin), exact: true });
}
for (const plugin of ["codex", "review-bot"] as const) {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${plugin} uses GitHub permissions and a plugin-wide modal at ${width}px ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(
          (value) => localStorage.setItem("repodesk.theme", value),
          theme,
        );
        const f = await fixture(page, plugin);
        const summary = page.getByRole("region", {
          name: regionName(plugin),
          exact: true,
        });
        await expect(summary).toBeVisible();
        await expect(summary.locator("form,input,select")).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Repositories", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: /(?:Add|Edit|Remove).*repository/i,
          }),
        ).toHaveCount(0);
        await expect(
          summary.getByText(/managed in GitHub|Manage access in GitHub/),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath("summary.png"),
          fullPage: true,
        });
        let dialog = await openEditor(page, plugin);
        await expect(
          dialog.getByRole("combobox", { name: "Repository", exact: true }),
        ).toHaveCount(0);
        await expect(
          dialog.getByText("Maintainers", { exact: true }),
        ).toHaveCount(0);
        await expect(dialog.getByText(/Codex Direct execution/)).toHaveCount(0);
        if (plugin === "codex") {
          await expect(
            summary.getByText("Publish by default", { exact: true }),
          ).toHaveCount(0);
          await expect(
            dialog.getByLabel(/Publish verified implementations/),
          ).toHaveCount(0);
          await chooseOption(
            dialog.getByLabel("Sign-in method"),
            "device_code",
          );
        } else
          await dialog
            .getByLabel("Allow explicitly requested fixes to the same PR")
            .check();
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(f.writes).toHaveLength(0);
        dialog = await openEditor(page, plugin);
        if (plugin === "codex") {
          await expect(dialog.getByLabel("Execution policy")).toHaveCount(0);
          await expect(dialog.getByText(/Reviewed|Direct/)).toHaveCount(0);
          await expect(
            dialog.getByLabel(/Publish verified implementations/),
          ).toHaveCount(0);
          await expect(dialog.getByLabel("Sign-in method")).toHaveAttribute(
            "value",
            "provider_key",
          );
          await chooseOption(
            dialog.getByLabel("Sign-in method"),
            "device_code",
          );
        } else {
          await expect(
            dialog.getByLabel(
              "Allow explicitly requested fixes to the same PR",
            ),
          ).not.toBeChecked();
          await dialog
            .getByLabel("Allow explicitly requested fixes to the same PR")
            .check();
        }
        const rows = dialog
          .locator("label")
          .filter({ has: page.getByRole("checkbox") });
        const bounds = await rows.evaluateAll((elements) =>
          elements.map((element) => ({
            top: element.getBoundingClientRect().top,
            bottom: element.getBoundingClientRect().bottom,
          })),
        );
        for (let i = 1; i < bounds.length; i++)
          expect(bounds[i]?.top).toBeGreaterThanOrEqual(
            bounds[i - 1]?.bottom ?? 0,
          );
        await page.screenshot({
          path: test.info().outputPath("editor.png"),
          fullPage: true,
        });
        await dialog
          .getByRole("button", { name: "Save configuration", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0]?.settings).not.toHaveProperty("repositories");
        expect(f.writes[0]?.settings).not.toHaveProperty("maintainers");
        if (plugin === "codex") {
          expect(f.coding.settings.authMode).toBe("device_code");
          expect(f.writes[0]?.settings).not.toHaveProperty("development");
          await expect(
            summary.getByText("Publish by default", { exact: true }),
          ).toHaveCount(0);
          await expect(
            summary.getByText("ChatGPT device code", { exact: true }),
          ).toBeVisible();
        } else expect(f.review.settings.allowFixes).toBe(true);
        await expect(summary.locator("form,input,select")).toHaveCount(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
    }
    test(`${plugin} preserves layout while loading at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await fixture(page, plugin, true);
      const summary = page.getByRole("region", {
        name: regionName(plugin),
        exact: true,
      });
      await expect(summary).toBeVisible();
      await expect(summary.locator(".skeleton").first()).toBeVisible();
      const valueHeights = await summary
        .locator("dd")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().height),
        );
      expect(Math.max(...valueHeights)).toBeLessThanOrEqual(32);
      await expect(
        page.getByRole("button", { name: editorName(plugin), exact: true }),
      ).toBeDisabled();
      await page.screenshot({
        path: test.info().outputPath("loading.png"),
        fullPage: true,
      });
      f.releaseLoad();
      await expect(
        page.getByRole("button", { name: editorName(plugin), exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByText(
          /No tasks yet|Reviews and tagged requests will appear here/,
        ),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("empty.png"),
        fullPage: true,
      });
    });
    test(`${plugin} locks pending saves and retains failed drafts at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await fixture(page, plugin);
      const dialog = await openEditor(page, plugin);
      if (plugin === "codex")
        await chooseOption(dialog.getByLabel("Sign-in method"), "device_code");
      else await dialog.getByLabel("Accept tagged requests").uncheck();
      let releaseSave = () => {};
      f.controls.pending = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      f.controls.error = "fixture_save_failed";
      await dialog
        .getByRole("button", { name: "Save configuration", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: /Save configuration|Saving/ }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("pending.png"),
        fullPage: true,
      });
      releaseSave();
      await expect(dialog.getByRole("alert")).toContainText(
        "fixture_save_failed",
      );
      await expect(dialog.getByRole("alert")).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "Save configuration", exact: true }),
      ).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeInViewport();
      if (plugin === "codex")
        await expect(dialog.getByLabel("Sign-in method")).toHaveAttribute(
          "value",
          "device_code",
        );
      else
        await expect(
          dialog.getByLabel("Accept tagged requests"),
        ).not.toBeChecked();
      await page.screenshot({
        path: test.info().outputPath("error.png"),
        fullPage: true,
      });
      f.controls.error = "";
      await dialog
        .getByRole("button", { name: "Save configuration", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      expect(f.writes).toHaveLength(2);
    });
  }
}

for (const plugin of ["codex", "review-bot"] as const)
  test(`${plugin} keeps the captured editor revision and recovers from a polling conflict`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.clock.install();
    const f = await fixture(page, plugin);
    const dialog = await openEditor(page, plugin);
    f.data.revision++;
    await page.clock.runFor(11000);
    await dialog
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(/settings changed/i);
    expect(f.writes[0]?.revision).toBe(1);
    await dialog
      .getByRole("button", {
        name:
          plugin === "codex"
            ? "Reload coding settings"
            : "Reload saved settings",
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    const reloaded = await openEditor(page, plugin);
    await reloaded
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(reloaded).toHaveCount(0);
    expect(f.writes[1]?.revision).toBe(2);
  });

for (const width of [1280, 390])
  test(`Review Bot page errors retain the configuration layout and recover at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, "review-bot", false, "fixture_load_failed");
    await expect(
      page.getByRole("region", {
        name: "Review Bot configuration",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: editorName("review-bot"), exact: true }),
    ).toBeDisabled();
    const error = page
      .getByRole("alert")
      .filter({ hasText: "fixture_load_failed" });
    await expect(error).toBeVisible();
    await expect(page.getByText("Disabled", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("page-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    await page
      .getByRole("button", {
        name: "Retry loading saved settings",
        exact: true,
      })
      .click();
    await expect(error).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: editorName("review-bot"), exact: true }),
    ).toBeEnabled();
    expect(f.writes).toHaveLength(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("page-recovered.png"),
      fullPage: true,
    });
  });
