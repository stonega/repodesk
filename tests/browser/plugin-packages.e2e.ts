import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test } from "@playwright/test";
import type {
  PackageCatalog,
  PackagePreview,
  PublicPackageInstallation,
} from "../../src/plugins/package-config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const base = `/api/admin/workspaces/${workspaceId}/plugin-packages`;
const manifest = JSON.parse(
  readFileSync("examples/plugins/word-count/repodesk.plugin.json", "utf8"),
);
function entry(): PublicPackageInstallation {
  return {
    manifest: {
      ...manifest,
      settingsSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", maxLength: 40, default: "Words" },
        },
        additionalProperties: false,
      },
      capabilities: ["http.read"],
      connections: [
        {
          id: "service",
          name: "Reports",
          scope: "workspace",
          auth: { type: "bearer" },
          requests: [
            {
              origin: "https://reports.example",
              paths: ["/summary"],
              queryKeys: [],
            },
          ],
        },
      ],
    },
    source: {
      repositoryId: 777,
      ownerId: 42,
      repository: "example/repodesk-word-count",
      ref: "v0.1.0",
      commit: "a".repeat(40),
      private: false,
    },
    digest: "b".repeat(64),
    manifestHash: "c".repeat(64),
    bundleHash: "d".repeat(64),
    generation: 1,
    enabled: false,
    settings: { prefix: "Words" },
    grants: [],
    history: [],
    connections: [],
  };
}
async function fixture(page: Page, installed = false) {
  const state = {
    catalog: {
      revision: 0,
      configured: true,
      runnerConfigured: true,
      entries: installed ? [entry()] : [],
      members: [{ id: "101", name: "Alice" }],
      chats: [{ id: "-100100", name: "Team" }],
    } as PackageCatalog,
    writes: 0,
    stale: false,
    held: undefined as Route | undefined,
    hold: false,
    holdRead: false,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === base && method === "GET") {
      if (state.holdRead) {
        state.held = route;
        return;
      }
      return route.fulfill({ json: state.catalog });
    }
    if (path === `${base}/previews`) {
      const body = route.request().postDataJSON();
      const incoming = entry();
      if (body.intent === "rollback") {
        incoming.digest = "e".repeat(64);
        incoming.manifest.version = "0.0.9";
      }
      const preview: PackagePreview = {
        ...incoming,
        id: "test-preview",
        actor: "operator",
        revision: state.catalog.revision,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        requestId: body.requestId,
        requestHash: "fixture",
        intent: body.intent,
      };
      return route.fulfill({ json: preview });
    }
    if (path.startsWith(base) && method !== "GET") {
      state.writes++;
      if (state.hold) {
        state.held = route;
        return;
      }
      if (state.stale)
        return route.fulfill({
          status: 409,
          json: { error: "version_conflict" },
        });
      const body = route.request().postDataJSON();
      if (path === base) state.catalog.entries = [entry()];
      else if (path.endsWith("/connections")) {
        const current = state.catalog.entries[0];
        if (current)
          current.connections = [
            {
              id: "service",
              revision: 1,
              members: body.members,
              privateOnly: body.privateOnly,
              chats: body.chats,
              configured: true,
            },
          ];
      } else if (method === "PATCH")
        Object.assign(state.catalog.entries[0] ?? {}, body);
      else if (method === "DELETE") state.catalog.entries = [];
      state.catalog.revision++;
      return route.fulfill({ json: state.catalog });
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: {
                id: "operator",
                username: "fixture",
                operator: true,
                telegramId: "101",
              },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Plugins fixture" }]
            : path.endsWith("/plugins")
              ? {
                  revision: state.catalog.revision,
                  entries: [],
                  packageCatalog: state.catalog,
                }
              : { settings: { enabled: false } };
    await route.fulfill({ json });
  });
  return state;
}
for (const width of [1280, 390]) {
  test(`GitHub install requires source review and remains disabled at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.addInitScript(() =>
        localStorage.setItem("repodesk.theme", "dark"),
      );
    const state = await fixture(page);
    await page.goto(`/admin/plugins?workspace=${workspaceId}`);
    await page.getByRole("button", { name: "Add plugin", exact: true }).click();
    await page
      .getByRole("button", { name: "GitHub repository", exact: true })
      .click();
    const modal = page.getByRole("dialog", { name: "Install from GitHub" });
    await modal
      .getByLabel("GitHub repository", { exact: true })
      .fill(manifest.repository);
    await modal
      .getByRole("button", { name: "Preview plugin", exact: true })
      .click();
    await expect(
      modal.getByRole("link", { name: /Review the exact executable/ }),
    ).toHaveAttribute("href", /a{40}\/dist\/plugin.mjs/);
    await expect(
      modal.getByRole("button", { name: "Install plugin", exact: true }),
    ).toBeDisabled();
    await modal.getByRole("checkbox", { name: /I reviewed/ }).check();
    await page.screenshot({
      path: test.info().outputPath(`source-review-${width}.png`),
      fullPage: true,
    });
    await modal
      .getByRole("button", { name: "Install plugin", exact: true })
      .click();
    await expect(modal).toHaveCount(0);
    expect(state.catalog.entries[0]?.enabled).toBe(false);
    await page
      .getByRole("link", { name: "Open Word count", exact: true })
      .click();
    const card = page.getByRole("region", { name: "Package configuration" });
    await expect(card).toContainText("Words");
    await expect(card.locator("input,select,textarea")).toHaveCount(0);
    await expect(
      page.getByRole("switch", { name: /Word count/ }),
    ).not.toBeChecked();
    await card
      .getByRole("button", { name: "Edit Word count", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "Edit Word count" });
    await editor.getByLabel("prefix", { exact: true }).fill("Counted");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("Words");
    await card
      .getByRole("button", { name: "Edit Word count", exact: true })
      .click();
    state.stale = true;
    await editor.getByLabel("prefix", { exact: true }).fill("Counted");
    await editor
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      "Saved plugins changed",
    );
    state.stale = false;
    await editor
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(card).toContainText("Counted");
    await page.getByRole("switch", { name: /Word count/ }).click();
    await expect(
      page.getByRole("switch", { name: /Word count/ }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Check for updates" }).click();
    const update = page.getByRole("dialog", { name: "Review plugin update" });
    await update
      .getByRole("button", { name: "Preview plugin", exact: true })
      .click();
    await expect(update.getByRole("status")).toContainText("already installed");
    await expect(
      update.getByRole("button", { name: "Apply reviewed version" }),
    ).toBeDisabled();
    await update.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath(`saved-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.locator("body").evaluate((body) => body.scrollWidth),
    ).toBe(width);
  });
}
test("connection summaries hide secrets and pending saves block duplicate dismissal", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await page.goto(`/admin/plugins/packages/777?workspace=${workspaceId}`);
  await page.getByRole("button", { name: "Edit Reports connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Reports" });
  await dialog
    .getByLabel("API token", { exact: true })
    .fill("synthetic-secret");
  await dialog.getByRole("checkbox", { name: "Alice", exact: true }).check();
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog).toHaveCount(0);
  const connection = page.getByRole("region", { name: "Connection Reports" });
  await expect(connection).toContainText("Alice");
  await expect(connection).toContainText("Private only");
  await expect(connection).not.toContainText("synthetic-secret");
  await page
    .getByRole("button", { name: "Edit Word count", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit Word count" });
  state.hold = true;
  const before = state.writes;
  await editor.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => !!state.held).toBe(true);
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  expect(state.writes).toBe(before + 1);
  await state.held?.fulfill({
    status: 409,
    json: { error: "version_conflict" },
  });
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit Word count", exact: true }),
  ).toBeFocused();
});

test("reviewed rollback requires consent, disables the version and removal returns to the catalog", async ({
  page,
}) => {
  const state = await fixture(page, true);
  const installed = state.catalog.entries[0];
  if (!installed) throw new Error("missing fixture");
  installed.enabled = true;
  installed.history = [
    {
      ...entry(),
      manifest: { ...entry().manifest, version: "0.0.9" },
      digest: "e".repeat(64),
    },
  ];
  await page.goto(`/admin/plugins/packages/777?workspace=${workspaceId}`);
  await page.getByRole("button", { name: "Review rollback to 0.0.9" }).click();
  const dialog = page.getByRole("dialog", { name: "Review plugin rollback" });
  await dialog
    .getByRole("button", { name: "Preview plugin", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed version" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
  await dialog.getByRole("button", { name: "Apply reviewed version" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: /Word count/ }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Remove plugin", exact: true })
    .click();
  const remove = page.getByRole("dialog", { name: "Remove plugin" });
  await remove
    .getByRole("button", { name: "Remove plugin", exact: true })
    .click();
  await expect(page).toHaveURL(/admin\/plugins\?workspace=/);
  await expect(
    page.getByRole("link", { name: "Open Word count", exact: true }),
  ).toHaveCount(0);
});

test("package details preserve known layout while loading and after a failed read", async ({
  page,
}) => {
  const state = await fixture(page, true);
  state.holdRead = true;
  await page.goto(`/admin/plugins/packages/777?workspace=${workspaceId}`);
  await expect.poll(() => !!state.held).toBe(true);
  await expect(
    page.getByRole("region", { name: "Package configuration" }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("region", { name: "Package versions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check for updates" }),
  ).toBeDisabled();
  await state.held?.fulfill({
    status: 503,
    json: { error: "fixture_unavailable" },
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Package versions" }),
  ).toBeVisible();
  state.holdRead = false;
  await page
    .getByRole("button", { name: "Retry loading plugin package" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Word count", exact: true }),
  ).toBeVisible();
});
