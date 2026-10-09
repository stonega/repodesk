import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { passwordHash } from "../../src/setup/credentials.ts";
import { workspace } from "../fixtures.ts";
import { chooseOption } from "./dropdown-helpers.ts";

async function fixture(page: Page) {
  const db = JSON.parse(
    await readFile(
      process.env.BROWSER_DB_PATH ??
        join(tmpdir(), "repodesk-browser-3107-db.json"),
      "utf8",
    ),
  );
  const pool = database(db.url);
  const operatorId = randomUUID(),
    username = `models-${randomUUID().slice(0, 8)}`;
  const password = "model provider browser password";
  const w = workspace(),
    sibling = workspace();
  w.operatorId = sibling.operatorId = operatorId;
  w.settings.name = "Model fixtures";
  sibling.settings.name = "Sibling model fixtures";
  try {
    await pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,true)",
      [operatorId, username, await passwordHash(password)],
    );
    // A fresh shard must show sign-in without relying on earlier setup tests.
    await pool.query("UPDATE deployment SET claimed=true WHERE id=true");
    for (const item of [w, sibling])
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [item.id, operatorId, JSON.stringify(item)],
      );
  } finally {
    await pool.end();
  }
  await page.goto(`/admin/model?workspace=${w.id}`);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Workspace", exact: true }),
  ).toBeVisible();
  await page.goto(`/admin/model?workspace=${w.id}`);
  await expect(
    page.getByRole("region", { name: "Model providers" }),
  ).toBeVisible();
  return { w, sibling };
}
async function addProvider(page: Page) {
  await page.getByRole("button", { name: "New model provider" }).click();
  const dialog = page.getByRole("dialog", { name: "New model provider" });
  await dialog.getByLabel("Provider name").fill("Shared API");
  await dialog
    .getByLabel("API base URL")
    .fill("https://models.example.test/v1");
  await dialog.getByLabel("API key", { exact: true }).fill("fixture-model-key");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await expect(dialog).toHaveCount(0);
  const catalog = await (
    await page.request.get("/api/admin/operator/model-providers")
  ).json();
  return catalog.providers[0].id as string;
}
for (const width of [1280, 390]) {
  test(`provider and chat display/editor remain separate, with failed and pending saves at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    const providers = page.getByRole("region", { name: "Model providers" });
    await expect(providers).toContainText("No providers yet");
    await addProvider(page);
    await expect(providers.locator("input,select")).toHaveCount(0);
    await expect(providers).toContainText("Shared API");
    await providers.getByRole("button", { name: "Edit Shared API" }).click();
    const editor = page.getByRole("dialog", { name: "Edit model provider" });
    await expect(editor.getByLabel("API key", { exact: true })).toHaveValue("");
    await editor.getByLabel("Provider name").fill("Discarded provider draft");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(providers).toContainText("Shared API");
    await providers.getByRole("button", { name: "Edit Shared API" }).click();
    await editor.getByLabel("API key", { exact: true }).fill("fixture-bad-key");
    await editor.getByRole("button", { name: "Save provider" }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "rejected the API key",
    );
    await expect(editor.getByLabel("API key", { exact: true })).toHaveValue(
      "fixture-bad-key",
    );
    await editor.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/provider-error-${width}.png`,
    });
    await editor
      .getByLabel("API key", { exact: true })
      .fill("fixture-model-key");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/admin/operator/model-providers", async (route) => {
      if (route.request().method() === "PUT") await gate;
      await route.continue();
    });
    await editor.getByRole("button", { name: "Save provider" }).click();
    await expect(
      editor.getByRole("button", { name: "Fetching models…" }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await editor.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/provider-pending-${width}.png`,
    });
    release?.();
    await expect(editor).toHaveCount(0);
    await page.unroute("**/api/admin/operator/model-providers");
    await providers.getByRole("button", { name: "Edit Shared API" }).click();
    await expect(editor.getByLabel("API key", { exact: true })).toHaveValue("");
    await editor.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/provider-editor-${width}.png`,
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/provider-summary-${width}.png`,
      fullPage: true,
    });
  });
  test(`chat, Codex and Code Review choose independent models from the same provider at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w, sibling } = await fixture(page);
    const provider = await addProvider(page);
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    const editor = page.getByRole("dialog", { name: "Edit chat model" });
    await chooseOption(
      editor.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "gpt-4.1-mini",
    );
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    await expect(chat).toContainText("gpt-4.1-mini");
    await expect(chat.locator("input,select")).toHaveCount(0);
    await page.goto(`/admin/model?workspace=${sibling.id}`);
    await expect(
      page.getByRole("region", { name: "Model providers" }),
    ).toContainText("Shared API");
    await expect(
      page.getByRole("region", { name: "Bot chat model" }),
    ).not.toContainText("gpt-4.1-mini");
    await page.goto(`/admin/plugins/codex?workspace=${w.id}`);
    await page
      .getByRole("button", { name: "Edit Codex configuration" })
      .click();
    const coding = page.getByRole("dialog", {
      name: "Edit Codex configuration",
    });
    await chooseOption(
      coding.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(coding.getByLabel("Model", { exact: true }), "gpt-4.1");
    await expect(coding.getByLabel("API key", { exact: true })).toHaveCount(0);
    await coding.getByRole("button", { name: "Save configuration" }).click();
    await expect(coding).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Codex configuration" }),
    ).toContainText("gpt-4.1");
    await page.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/model-codex-${width}.png`,
      fullPage: true,
    });
    await page.goto(`/admin/plugins/review-bot?workspace=${w.id}`);
    await page.getByRole("button", { name: "Edit review model" }).click();
    const review = page.getByRole("dialog", { name: "Edit review model" });
    await review.getByLabel("Use the Codex model").uncheck();
    await chooseOption(
      review.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      review.getByLabel("Model", { exact: true }),
      "gpt-4.1-mini",
    );
    await review.getByRole("button", { name: "Save review model" }).click();
    await expect(review).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Review model" }),
    ).toContainText("gpt-4.1-mini");
    await page.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/model-review-${width}.png`,
      fullPage: true,
    });
    const saved = await (
      await page.request.get(`/api/admin/workspaces/${w.id}/plugins/coding`)
    ).json();
    expect(saved.settings.model).toMatchObject({
      providerId: provider,
      model: "gpt-4.1",
    });
  });
  test(`GitHub App creation offers the actual downloadable icon and waits for the upload handoff at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    let connections = 0;
    await page.route(`**/api/admin/workspaces/${w.id}/github`, (route) =>
      route.fulfill({
        json: {
          configured: true,
          appSlug: "fixture-app",
          appSettingsUrl:
            "https://github.com/organizations/example/settings/apps/fixture-app",
          revision: 0,
          pending: false,
          installations: [],
        },
      }),
    );
    await page.route(
      `**/api/admin/workspaces/${w.id}/github/connect`,
      async (route) => {
        connections++;
        await route.fulfill({
          json: { url: "https://github.com/fixture-oauth" },
        });
      },
    );
    await page.route("https://github.com/fixture-oauth", (route) =>
      route.fulfill({ body: "Offline authorization fixture" }),
    );
    await page.goto(`/setup?workspace=${w.id}&step=github&github=app-created`);
    await expect(
      page.getByRole("img", { name: "RepoDesk GitHub App icon" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open GitHub App settings" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/organizations/example/settings/apps/fixture-app",
    );
    await expect(
      page.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeDisabled();
    expect(connections).toBe(0);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download icon" }).click();
    expect((await download).suggestedFilename()).toBe(
      "repodesk-github-app.png",
    );
    await page.screenshot({
      path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/github-app-icon-${width}.png`,
      fullPage: true,
    });
    await page.getByLabel("I uploaded the RepoDesk icon in GitHub").click();
    await expect(page).toHaveURL("https://github.com/fixture-oauth");
    expect(connections).toBe(1);
  });
}
