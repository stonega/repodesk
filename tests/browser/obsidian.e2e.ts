import { expect, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { vaultLimits } from "../../src/obsidian/config.ts";
import { mutateVault, queryVault } from "../../src/obsidian/service.ts";
import {
  obsidianEnabled,
  obsidianGeneration,
  vaultFor,
} from "../../src/obsidian/vault.ts";
import { workspace as makeWorkspace } from "../fixtures.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function fixture(page: Page) {
  const w = makeWorkspace();
  w.id = workspace;
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
  };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.includes("/plugins/obsidian")) {
      if (route.request().method() !== "GET") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await controls.pending;
        if (controls.failure) {
          await route.fulfill({
            status: 409,
            json: { error: controls.failure },
          });
          return;
        }
        if (path.endsWith("/files")) {
          mutateVault(w, "101", body);
          await route.fulfill({ json: { revision: vaultFor(w).revision } });
          return;
        }
        w.plugins = {
          revision: (w.plugins?.revision ?? 0) + 1,
          entries: [],
          obsidian: {
            enabled: body.enabled,
            generation: obsidianGeneration(w) + 1,
          },
        };
      } else {
        await controls.loading;
        if (controls.loadError) {
          await route.fulfill({
            status: 503,
            json: { error: controls.loadError },
          });
          return;
        }
      }
      if (path.endsWith("/file")) {
        await route.fulfill({
          json: {
            ...vaultFor(w).files.find(
              (f) => f.path === url.searchParams.get("path"),
            ),
            vaultRevision: vaultFor(w).revision,
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          revision: w.plugins?.revision ?? 0,
          settings: {
            enabled: obsidianEnabled(w),
            generation: obsidianGeneration(w),
          },
          ...queryVault(w, {
            query: url.searchParams.get("query") ?? "",
            trash: url.searchParams.get("trash") === "true",
            offset: Number(url.searchParams.get("offset") ?? 0),
          }),
          limits: vaultLimits,
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
              ? [{ id: workspace, name: "Notes organization" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 0,
                    source: "empty",
                    entries: [],
                    workspaces: [{ id: workspace, name: "Notes organization" }],
                    audit: [],
                  }
                : { providers: [] },
    });
  });
  return {
    w,
    controls,
    writes,
    open: () => page.goto(`/admin/plugins/obsidian?workspace=${workspace}`),
  };
}
for (const width of [1280, 390]) {
  test(`Obsidian saved summaries, editors, import/trash and themes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await f.open();
    const notes = page.getByRole("region", {
      name: "Organization notes",
      exact: true,
    });
    const vault = page.getByRole("region", {
      name: "Organization vault",
      exact: true,
    });
    await expect(
      page.getByRole("switch", { name: "Enable Obsidian" }),
    ).toBeChecked();
    await expect(vault).toContainText("Enabled by default");
    await expect(vault).toContainText(
      "All active members can read and manage notes through interactive bot requests.",
    );
    await expect(vault.locator("input,textarea,select")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Content", exact: true }),
    ).toHaveCount(0);
    const newButton = page.getByRole("button", {
      name: "New note",
      exact: true,
    });
    await expectTopRightAction(notes, newButton);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`summary-${theme}.png`),
        fullPage: true,
      });
      await newButton.click();
      const dialog = page.getByRole("dialog", {
        name: "New note",
        exact: true,
      });
      await dialog.getByLabel("Vault path").fill(`Projects/Launch-${theme}.md`);
      await dialog
        .getByRole("textbox", { name: "Content", exact: true })
        .fill(
          `---\ntags: [project/launch]\nstatus: open\n---\n# Launch ${theme}\n- [ ] Ship\n[[Home]]`,
        );
      await page.screenshot({
        path: test.info().outputPath(`editor-${theme}.png`),
        fullPage: true,
      });
      await dialog
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await expect(notes).toContainText(`Launch ${theme}`);
      await expect(newButton).toBeFocused();
      const card = notes
        .locator("article")
        .filter({ hasText: `Projects/Launch-${theme}.md` });
      await expect(card.locator("input,textarea,select")).toHaveCount(0);
      await expectTopRightAction(card, card.locator(".obsidian-actions"));
    }
    await page
      .getByRole("button", { name: "Launch light", exact: true })
      .click();
    const reader = page.getByRole("dialog", {
      name: "Projects/Launch-light.md",
      exact: true,
    });
    await expect(reader).toContainText("[[Home]]");
    await expect(reader.locator("textarea,input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await page
      .getByRole("button", {
        name: "Trash Projects/Launch-light.md",
        exact: true,
      })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Move note to Trash",
    });
    await confirmation
      .getByRole("button", { name: "Move to Trash", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Launch light", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await expect(notes).toContainText("Launch light");
    await page.screenshot({
      path: test.info().outputPath("trash.png"),
      fullPage: true,
    });
    await notes.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(notes).toContainText("Trash is empty");
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page
      .getByRole("button", { name: "Import vault", exact: true })
      .click();
    const importer = page.getByRole("dialog", {
      name: "Import vault",
      exact: true,
    });
    await importer.getByLabel("Vault ZIP").setInputFiles({
      name: "notes.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync({
          "Decisions/Launch.md": strToU8("# Launch decision\nApproved"),
          "image.png": new Uint8Array([1]),
        }),
      ),
    });
    await expect(importer).toContainText("1 files ready to import");
    await expect(importer).toContainText("1 unsupported files skipped");
    await page.screenshot({
      path: test.info().outputPath("import.png"),
      fullPage: true,
    });
    await importer
      .getByRole("button", { name: "Import files", exact: true })
      .click();
    await expect(importer).toBeHidden();
    await expect(notes).toContainText("Launch decision");
    await page
      .getByRole("searchbox", { name: "Search notes" })
      .fill("No such note");
    await expect(notes).toContainText("No notes match this search");
    await page.screenshot({
      path: test.info().outputPath("empty.png"),
      fullPage: true,
    });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.getByRole("switch", { name: "Enable Obsidian" }).click();
    await expect(
      page.getByRole("switch", { name: "Enable Obsidian" }),
    ).not.toBeChecked();
    await expect(vault).toContainText("Bot tools are disabled");
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Enable Obsidian" }),
    ).not.toBeChecked();
    expect(f.writes.some((body) => body.action === "import")).toBe(true);
  });
  test(`Obsidian loading, retry, preserved drafts and pending locks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let loaded = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    await f.open();
    await expect(
      page.getByRole("heading", { name: "Organization vault", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Enable Obsidian" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New note", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.controls.loadError = "unavailable";
    loaded();
    await expect(
      page.getByRole("button", { name: "Reload organization notes" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("load-error.png"),
      fullPage: true,
    });
    f.controls.loadError = "";
    await page
      .getByRole("button", { name: "Reload organization notes" })
      .click();
    await page
      .getByRole("button", { name: "Edit Home.md", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Edit note", exact: true });
    await dialog
      .getByRole("textbox", { name: "Content", exact: true })
      .fill("# Preserved draft");
    f.controls.failure = "version_conflict";
    await dialog
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("draft is preserved");
    await expect(
      dialog.getByRole("textbox", { name: "Content", exact: true }),
    ).toHaveValue("# Preserved draft");
    await page.screenshot({
      path: test.info().outputPath("save-error.png"),
      fullPage: true,
    });
    f.controls.failure = "";
    let saved = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      saved = resolve;
    });
    await dialog
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving…", exact: true }),
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
    saved();
    await expect(dialog).toBeHidden();
    expect(f.writes.filter((body) => body.action === "save")).toHaveLength(2);
    await expect(
      page.getByRole("region", { name: "Organization notes", exact: true }),
    ).toContainText("Preserved draft");
  });
}
