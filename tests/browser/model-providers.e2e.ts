import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { encrypt, hash, passwordHash } from "../../src/setup/credentials.ts";
import { workspace } from "../fixtures.ts";
import { chooseOption } from "./dropdown-helpers.ts";

function browserDbPath() {
  return (
    process.env.BROWSER_DB_PATH ??
    join(tmpdir(), "repodesk-browser-3107-db.json")
  );
}

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
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "Your team, in view", exact: true }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) <= 800)
    await page.getByRole("button", { name: "Open navigation" }).click();
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
  test(`typed provider metadata stays separate from overrides with cache-price save recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    await page.getByRole("button", { name: "New model provider" }).click();
    const providerEditor = page.getByRole("dialog", {
      name: "New model provider",
    });
    await chooseOption(
      providerEditor.getByLabel("Provider type"),
      "openrouter",
    );
    await providerEditor.getByLabel("Provider name").fill("Router metadata");
    await providerEditor
      .getByLabel("API base URL")
      .fill("https://openrouter.ai/api/v1");
    await providerEditor
      .getByLabel("API key", { exact: true })
      .fill("fixture-model-key");
    await providerEditor.getByRole("button", { name: "Save provider" }).click();
    await expect(providerEditor).toHaveCount(0);
    const catalog = await (
      await page.request.get("/api/admin/operator/model-providers")
    ).json();
    const providerId = catalog.providers.find(
      (p: { name: string }) => p.name === "Router metadata",
    ).id;
    const providers = page.getByRole("region", { name: "Model providers" });
    await expect(providers).toContainText("OpenRouter · API key configured");
    await expect(providers.locator("input")).toHaveCount(0);
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    const editor = page.getByRole("dialog", { name: "Edit chat model" });
    await chooseOption(editor.getByLabel("Model provider"), providerId);
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "deepseek/fixture",
    );
    const automatic = editor.locator(
      'dl[aria-label="Automatic model information"]',
    );
    await expect(automatic).toContainText("131,072 · API");
    await expect(automatic).toContainText("0.006 USD / million tokens");
    await editor.getByText("Advanced model settings", { exact: true }).click();
    for (const name of [
      "modelContextWindow",
      "modelMaxOutput",
      "modelInputPrice",
      "modelOutputPrice",
      "modelCacheReadPrice",
    ])
      await expect(editor.locator(`input[name="${name}"]`)).toHaveValue("");
    await editor.locator('input[name="modelCacheReadPrice"]').fill("0.009");
    await page.screenshot({
      path: test.info().outputPath("metadata-editor.png"),
      fullPage: true,
    });
    await page.route(`**/api/admin/workspaces/${w.id}/models`, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixture save failure" }),
          })
        : route.continue(),
    );
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "fixture save failure",
    );
    await expect(
      editor.locator('input[name="modelCacheReadPrice"]'),
    ).toHaveValue("0.009");
    await page.screenshot({
      path: test.info().outputPath("metadata-error.png"),
      fullPage: true,
    });
    await page.unroute(`**/api/admin/workspaces/${w.id}/models`);
    let held: Route | undefined;
    await page.route(`**/api/admin/workspaces/${w.id}/models`, (route) => {
      if (route.request().method() === "PUT") held = route;
      else return route.continue();
    });
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(
      editor.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("metadata-pending.png"),
      fullPage: true,
    });
    await expect.poll(() => !!held).toBe(true);
    await held?.continue();
    await expect(editor).toHaveCount(0);
    await page.unroute(`**/api/admin/workspaces/${w.id}/models`);
    await expect(chat).toContainText("0.009 USD / million tokens");
    await expect(
      chat.locator('dl[aria-label="Automatic model information"]'),
    ).toContainText("0.006 USD / million tokens");
    await expect(chat.locator("input")).toHaveCount(0);
    await page.reload();
    await expect(chat).toContainText("0.009 USD / million tokens");
    await page.screenshot({
      path: test.info().outputPath("metadata-summary.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("repodesk-theme", "dark");
    });
    await page.screenshot({
      path: test.info().outputPath("metadata-summary-dark.png"),
      fullPage: true,
    });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await expect(
      editor.locator('input[name="modelCacheReadPrice"]'),
    ).toHaveValue("0.009");
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "zero/fixture",
    );
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await expect(
      editor.locator('input[name="modelCacheReadPrice"]'),
    ).toHaveValue("");
    await expect(
      editor.locator('dl[aria-label="Automatic model information"]'),
    ).toContainText("0 USD / million tokens");
    await page.screenshot({
      path: test.info().outputPath("metadata-editor-dark.png"),
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(chat).toContainText("deepseek/fixture");
    await expect(chat).toContainText("0.009 USD / million tokens");
  });
  test(`New API group prices and DeepSeek tiers persist as explicit estimates at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    for (const [name, type, url] of [
      ["New API fixture", "newapi", "https://newapi.example/v1"],
      ["DeepSeek fixture", "deepseek", "https://api.deepseek.com/v1"],
    ]) {
      await page.getByRole("button", { name: "New model provider" }).click();
      const editor = page.getByRole("dialog", { name: "New model provider" });
      await chooseOption(editor.getByLabel("Provider type"), type ?? "");
      await editor.getByLabel("Provider name").fill(name ?? "");
      await editor.getByLabel("API base URL").fill(url ?? "");
      await editor
        .getByLabel("API key", { exact: true })
        .fill("fixture-model-key");
      if (name === "New API fixture")
        await editor.getByLabel("New API billing group (optional)").fill("vip");
      await page.screenshot({
        path: test.info().outputPath(`${name}-provider.png`),
        fullPage: true,
      });
      await editor.getByRole("button", { name: "Save provider" }).click();
      await expect(editor).toHaveCount(0);
    }
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    const editor = page.getByRole("dialog", { name: "Edit chat model" });
    const catalog = await (
      await page.request.get("/api/admin/operator/model-providers")
    ).json();
    await chooseOption(
      editor.getByLabel("Model provider"),
      catalog.providers.find(
        (p: { name: string }) => p.name === "New API fixture",
      ).id,
    );
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "team/custom-model",
    );
    await expect(
      editor.locator('dl[aria-label="Automatic model information"]'),
    ).toContainText("0.2 USD / million tokens");
    await chooseOption(
      editor.getByLabel("Model provider"),
      catalog.providers.find(
        (p: { name: string }) => p.name === "DeepSeek fixture",
      ).id,
    );
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "deepseek-flash",
    );
    await editor.getByText("Compare price tiers", { exact: true }).click();
    await expect(editor.locator('dl[aria-label="Peak prices"]')).toBeVisible();
    await expect(editor.locator('dl[aria-label="Peak prices"]')).toContainText(
      "0.3 USD / million tokens",
    );
    await expect(
      editor.locator('dl[aria-label="Off-peak prices"]'),
    ).toContainText("0.15 USD / million tokens");
    await expect(editor).toContainText("Dated official reference · 2026-10-14");
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await expect(editor.getByLabel("Price estimate tier")).toContainText(
      "Peak",
    );
    await chooseOption(editor.getByLabel("Price estimate tier"), "off_peak");
    await expect(
      editor.locator('dl[aria-label="Automatic model information"]'),
    ).toContainText("0.003 USD / million tokens");
    await page.screenshot({
      path: test.info().outputPath("deepseek-tier-editor.png"),
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    await page.reload();
    await expect(chat).toContainText("Off-peak");
    await expect(
      chat.locator('dl[aria-label="Automatic model information"]'),
    ).toContainText("0.15 USD / million tokens");
    await page.screenshot({
      path: test.info().outputPath("deepseek-tier-summary.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({
      path: test.info().outputPath("deepseek-tier-summary-dark.png"),
      fullPage: true,
    });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await expect(editor.getByLabel("Price estimate tier")).toContainText(
      "Off-peak",
    );
    await page.screenshot({
      path: test.info().outputPath("deepseek-tier-editor-dark.png"),
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  test(`model settings keeps its layout without activation during loading and errors at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    const path = `**/api/admin/workspaces/${w.id}/models`;
    let held: Route | undefined;
    await page.route(path, (route) => {
      held = route;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const providers = page.getByRole("region", { name: "Model providers" });
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await expect(providers.locator(".skeleton").first()).toBeVisible();
    await expect(
      chat.getByRole("heading", { name: "Bot chat model" }),
    ).toBeVisible();
    await expect(
      providers.getByRole("button", { name: "New model provider" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Activation", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("model-loading.png"),
      fullPage: true,
    });
    await held?.fulfill({ status: 503, json: { error: "unavailable" } });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(providers).toBeVisible();
    await expect(chat).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("model-load-error.png"),
      fullPage: true,
    });
    await page.unroute(path);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(providers).toContainText("No providers yet");
    await expect(providers.locator(".skeleton")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
  test(`model save activates automatically without an activation card at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    const db = JSON.parse(await readFile(browserDbPath(), "utf8"));
    const pool = database(db.url);
    try {
      const store = new Store(pool);
      // No earlier workspace may make this disposable deployment ready during
      // the pending/failed-save assertions, including in polling-mode suites.
      await pool.query(
        "UPDATE workspaces SET data=data-'chatModel' WHERE id<>$1",
        [w.id],
      );
      const d = await store.deployment();
      d.active = false;
      d.bot = { id: "999", username: "fixture_bot", visibleAll: true };
      d.credentials.bot = encrypt(
        "ab".repeat(32),
        "bot",
        "999:fixture-bot-token",
      );
      delete d.credentials.model;
      d.webhookReady = true;
      await store.saveDeployment(pool, d);
      await pool.query(
        "INSERT INTO telegram_polling(bot_id,credential_hash,ready_at) VALUES($1,$2,now()) ON CONFLICT(bot_id) DO UPDATE SET credential_hash=$2,ready_at=now(),error=NULL",
        [d.bot.id, hash(d.credentials.bot)],
      );
    } finally {
      await pool.end();
    }
    const active = async () =>
      (await (await page.request.get("/api/setup/progress")).json()).active;
    const noActivationStep = async () => {
      await expect(
        page.getByRole("region", { name: "Activation", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Activate the bot" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Activate bot", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Telegram access" }),
      ).toHaveCount(0);
    };
    await noActivationStep();
    await page.screenshot({
      path: test.info().outputPath("automatic-activation-empty.png"),
      fullPage: true,
    });
    const provider = await addProvider(page);
    expect(await active()).toBe(false);
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
    const path = `**/api/admin/workspaces/${w.id}/models`;
    let pending: Route | undefined;
    await page.route(path, (route) => {
      if (route.request().method() === "PUT") pending = route;
      else void route.continue();
    });
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect.poll(() => !!pending).toBe(true);
    await expect(
      editor.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    expect(await active()).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("automatic-activation-pending.png"),
      fullPage: true,
    });
    await pending?.fulfill({
      status: 409,
      json: { error: "model_not_available" },
    });
    await expect(editor.getByRole("alert")).toBeVisible();
    await expect(editor.getByLabel("Model", { exact: true })).toHaveAttribute(
      "value",
      "gpt-4.1-mini",
    );
    expect(await active()).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("automatic-activation-error.png"),
      fullPage: true,
    });
    await page.unroute(path);
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(active).toBe(true);
    await expect(chat).toContainText("gpt-4.1-mini");
    await expect(chat.locator("input,form")).toHaveCount(0);
    await noActivationStep();
    await page.reload();
    await expect(chat).toContainText("gpt-4.1-mini");
    await noActivationStep();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("automatic-activation-saved.png"),
      fullPage: true,
    });
  });
  test(`custom chat capacity and prices are independently optional at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    const provider = await addProvider(page);
    const chat = page.getByRole("region", { name: "Bot chat model" });
    const edit = chat.getByRole("button", { name: "Edit chat model" });
    await edit.click();
    const editor = page.getByRole("dialog", { name: "Edit chat model" });
    await chooseOption(
      editor.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "team/custom-model",
    );
    await editor.getByText("Advanced model settings", { exact: true }).click();
    for (const name of [
      "Model context window (tokens)",
      "Model maximum output (tokens)",
      "Input price (USD / million tokens)",
      "Output price (USD / million tokens)",
    ])
      await expect(editor.getByLabel(name)).toHaveValue("");
    await expect(editor).toContainText("All overrides are optional");
    await expect(editor).toContainText(
      "A blank context window lets the provider enforce its limit",
    );
    await expect(
      editor.getByLabel("Model context window (tokens)"),
    ).toHaveAttribute("placeholder", "Provider default (optional)");
    await page.screenshot({
      path: test.info().outputPath("model-optional-editor.png"),
      fullPage: true,
    });
    await editor
      .getByRole("button", { name: "Save chat model" })
      .scrollIntoViewIfNeeded();
    await expect(
      editor.getByLabel("Output price (USD / million tokens)"),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("model-optional-editor-bottom.png"),
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    await expect(chat).toContainText("team/custom-model");
    await expect(chat.locator("input,form")).toHaveCount(0);
    let saved = await (
      await page.request.get(`/api/admin/workspaces/${w.id}/models`)
    ).json();
    expect(saved.selection.modelLimits).toBeUndefined();
    expect(saved.selection.modelPricing).toBeUndefined();
    await expect(chat).toContainText("Provider default");
    await edit.click();
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await editor.getByLabel("Model context window (tokens)").fill("1000000");
    await editor.getByLabel("Input price (USD / million tokens)").fill("0");
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    saved = await (
      await page.request.get(`/api/admin/workspaces/${w.id}/models`)
    ).json();
    expect(saved.selection.modelLimits).toEqual({ contextWindow: 1000000 });
    expect(saved.selection.modelPricing).toEqual({ input: 0 });
    await edit.click();
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await editor.getByLabel("Model context window (tokens)").fill("");
    await editor.getByLabel("Input price (USD / million tokens)").fill("");
    await editor.getByRole("button", { name: "Save chat model" }).click();
    await expect(editor).toHaveCount(0);
    saved = await (
      await page.request.get(`/api/admin/workspaces/${w.id}/models`)
    ).json();
    expect(saved.selection.modelLimits).toBeUndefined();
    expect(saved.selection.modelPricing).toBeUndefined();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("model-optional-summary.png"),
      fullPage: true,
    });
  });
  test(`chat price currency persists with validation, cancellation and save recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    const provider = await addProvider(page);
    const chat = page.getByRole("region", { name: "Bot chat model" });
    const edit = chat.getByRole("button", { name: "Edit chat model" });
    const editor = page.getByRole("dialog", { name: "Edit chat model" });
    const open = async () => {
      await edit.click();
      await editor
        .getByText("Advanced model settings", { exact: true })
        .click();
    };
    await edit.click();
    await chooseOption(
      editor.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      editor.getByLabel("Model", { exact: true }),
      "team/custom-model",
    );
    await editor.getByText("Advanced model settings", { exact: true }).click();
    await expect(editor.getByLabel("Price currency")).toHaveAttribute(
      "value",
      "USD",
    );
    await editor.getByLabel("Input price (USD / million tokens)").fill("10");
    await editor.getByLabel("Output price (USD / million tokens)").fill("30");
    await chooseOption(editor.getByLabel("Price currency"), "CNY");
    await expect(
      editor.getByLabel("Input price (CNY / million tokens)"),
    ).toHaveValue("10");
    const rate = editor.getByLabel("USD exchange rate (1 CNY = USD)");
    const save = editor.getByRole("button", { name: "Save chat model" });
    await save.click();
    await expect(editor.getByRole("alert")).toContainText(
      "Enter the USD exchange rate",
    );
    await rate.fill("0");
    await save.click();
    await expect(editor.getByRole("alert")).toBeVisible();
    await rate.fill("0.14");
    await page.screenshot({
      path: test.info().outputPath("currency-editor.png"),
      fullPage: true,
    });
    await page.route(
      `**/api/admin/workspaces/${w.id}/models`,
      async (route) => {
        if (route.request().method() === "PUT")
          await route.fulfill({
            status: 503,
            json: { error: "fixture_save_failure" },
          });
        else await route.continue();
      },
    );
    await save.click();
    await expect(editor.getByRole("alert")).toContainText(
      "fixture_save_failure",
    );
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(rate).toHaveValue("0.14");
    await expect(
      editor.getByLabel("Input price (CNY / million tokens)"),
    ).toHaveValue("10");
    await page.screenshot({
      path: test.info().outputPath("currency-error.png"),
      fullPage: true,
    });
    await page.unroute(`**/api/admin/workspaces/${w.id}/models`);
    let release: (() => void) | undefined;
    await page.route(
      `**/api/admin/workspaces/${w.id}/models`,
      async (route) => {
        if (route.request().method() === "PUT")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await route.continue();
      },
    );
    await save.click();
    await expect(
      editor.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    await expect(editor.getByLabel("Price currency")).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("currency-pending.png"),
      fullPage: true,
    });
    await expect.poll(() => !!release).toBe(true);
    release?.();
    await expect(editor).toHaveCount(0);
    await page.unroute(`**/api/admin/workspaces/${w.id}/models`);
    await expect(chat).toContainText("10 CNY / million tokens");
    await expect(chat).toContainText("30 CNY / million tokens");
    await expect(chat).toContainText("1 CNY = 0.14 USD");
    await expect(chat.locator("input,form,[role=combobox]")).toHaveCount(0);
    expect(
      (
        await (
          await page.request.get(`/api/admin/workspaces/${w.id}/models`)
        ).json()
      ).selection.modelPricing,
    ).toEqual({ input: 10, output: 30, currency: "CNY", usdRate: 0.14 });
    await page.reload();
    await expect(chat).toContainText("10 CNY / million tokens");
    await page.screenshot({
      path: test.info().outputPath("currency-summary.png"),
      fullPage: true,
    });
    await page.evaluate(() => localStorage.setItem("repodesk.theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(chat).toContainText("10 CNY / million tokens");
    await page.screenshot({
      path: test.info().outputPath("currency-summary-dark.png"),
      fullPage: true,
    });
    await open();
    await expect(rate).toHaveValue("0.14");
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("currency-editor-dark.png"),
      fullPage: true,
    });
    await chooseOption(editor.getByLabel("Price currency"), "TWD");
    await expect(
      editor.getByLabel("USD exchange rate (1 TWD = USD)"),
    ).toHaveValue("");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(chat).toContainText("10 CNY / million tokens");
    await open();
    await expect(editor.getByLabel("Price currency")).toHaveAttribute(
      "value",
      "CNY",
    );
    await chooseOption(editor.getByLabel("Price currency"), "USD");
    await expect(editor.getByLabel(/USD exchange rate/)).toHaveCount(0);
    await expect(
      editor.getByLabel("Input price (USD / million tokens)"),
    ).toHaveValue("10");
    await save.click();
    await expect(editor).toHaveCount(0);
    await expect(chat).toContainText("10 USD / million tokens");
    await expect(chat).not.toContainText("USD exchange rate");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
  test(`setup saves non-USD chat prices at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { w } = await fixture(page);
    const provider = await addProvider(page);
    await page.goto(`/setup?workspace=${w.id}&step=model`);
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await chooseOption(
      chat.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      chat.getByLabel("Model", { exact: true }),
      "team/custom-model",
    );
    await chat.getByText("Advanced model settings", { exact: true }).click();
    await chooseOption(chat.getByLabel("Price currency"), "TWD");
    await chat.getByLabel("USD exchange rate (1 TWD = USD)").fill("0.03");
    await chat.getByLabel("Input price (TWD / million tokens)").fill("20");
    await chat.getByLabel("Output price (TWD / million tokens)").fill("60");
    const next = page.getByRole("button", { name: "Continue to Telegram" });
    await next.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("setup-currency.png"),
      fullPage: true,
    });
    await next.click();
    await expect(page).toHaveURL(/step=telegram/);
    expect(
      (
        await (
          await page.request.get(`/api/admin/workspaces/${w.id}/models`)
        ).json()
      ).selection.modelPricing,
    ).toEqual({ input: 20, output: 60, currency: "TWD", usdRate: 0.03 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
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
    await page
      .getByRole("button", { name: "Edit Review Bot configuration" })
      .click();
    const review = page.getByRole("dialog", {
      name: "Edit Review Bot configuration",
    });
    await review.getByLabel("Use the Codex model").uncheck();
    await chooseOption(
      review.getByLabel("Model provider", { exact: true }),
      provider,
    );
    await chooseOption(
      review.getByLabel("Model", { exact: true }),
      "gpt-4.1-mini",
    );
    await review.getByRole("button", { name: "Save configuration" }).click();
    await expect(review).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Review Bot configuration" }),
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
