import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { DUCKDUCKGO_PRESET_ID } from "../../src/search/config.ts";
import { encrypt, passwordHash } from "../../src/setup/credentials.ts";
import { workspace } from "../fixtures.ts";
import { chooseOption } from "./dropdown-helpers.ts";

async function fixture(page: Page, legacy = false) {
  const db = JSON.parse(
    await readFile(
      process.env.BROWSER_DB_PATH ??
        join(tmpdir(), "repodesk-browser-3107-db.json"),
      "utf8",
    ),
  );
  const pool = database(db.url),
    store = new Store(pool);
  const id = randomUUID(),
    username = `search-${id.slice(0, 8)}`,
    password = "search browser password",
    modelId = randomUUID();
  const w = workspace();
  w.operatorId = id;
  w.settings.name = "Search fixtures";
  w.chatModel = {
    revision: 1,
    selection: { providerId: modelId, model: "gpt-4.1-mini" },
  };
  try {
    await pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,true)",
      [id, username, await passwordHash(password)],
    );
    await pool.query("UPDATE deployment SET claimed=true WHERE id=true");
    const d = await store.deployment();
    d.modelProviders = [
      ...(d.modelProviders ?? []),
      {
        id: modelId,
        operatorId: id,
        version: 1,
        name: "Chat API",
        baseUrl: "https://models.example.test/v1",
        credential: encrypt(
          "ab".repeat(32),
          `model-provider:${id}:${modelId}`,
          "fixture-key",
        ),
        models: ["gpt-4.1-mini"],
        fetchedAt: new Date().toISOString(),
      },
    ];
    if (legacy) {
      const legacyId = randomUUID();
      d.searchProviders = [
        ...(d.searchProviders ?? []),
        {
          id: legacyId,
          operatorId: id,
          version: 1,
          name: "Saved DuckDuckGo",
          type: "duckduckgo",
        },
      ];
      w.chatModel.searchProviderId = legacyId;
    }
    await store.saveDeployment(pool, d);
    await pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, id, JSON.stringify(w)],
    );
  } finally {
    await pool.end();
  }
  await page.goto(`/admin/model?workspace=${w.id}`);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/model?workspace=${w.id}`);
  await expect(
    page.getByRole("region", { name: "Search providers", exact: true }),
  ).toBeVisible();
  return w;
}
const screenshot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/web-search-${name}.png`,
    fullPage: true,
  });
for (const width of [1280, 390]) {
  test(`saved DuckDuckGo selections can move to the preset at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, true);
    const section = page.getByRole("region", {
      name: "Search providers",
      exact: true,
    });
    const chat = page.getByRole("region", { name: "Bot chat model" });
    await expect(chat).toContainText("Saved DuckDuckGo");
    await section
      .getByRole("button", { name: "Edit search provider Saved DuckDuckGo" })
      .click();
    const editor = page.getByRole("dialog", { name: "Edit search provider" });
    await expect(editor.getByLabel("Search provider type")).toHaveAttribute(
      "value",
      "duckduckgo",
    );
    await expect(editor.getByLabel("API key", { exact: true })).toHaveCount(0);
    await editor.getByLabel("Provider name").fill("Previous free search");
    await screenshot(page, `legacy-editor-${width}`);
    await editor.getByRole("button", { name: "Save search provider" }).click();
    await expect(editor).toHaveCount(0);
    await expect(chat).toContainText("Previous free search");
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    const model = page.getByRole("dialog", { name: "Edit chat model" });
    await chooseOption(
      model.getByLabel("Search provider", { exact: true }),
      DUCKDUCKGO_PRESET_ID,
    );
    await model.getByRole("button", { name: "Save chat model" }).click();
    await expect(model).toHaveCount(0);
    await section
      .getByRole("button", {
        name: "Remove search provider Previous free search",
      })
      .click();
    const remove = page.getByRole("dialog", { name: "Remove search provider" });
    await remove
      .getByRole("button", { name: "Remove provider", exact: true })
      .click();
    await expect(remove).toHaveCount(0);
    await expect(section.getByRole("listitem")).toHaveCount(1);
    await expect(chat).toContainText("DuckDuckGo (free)");
    await page.reload();
    await expect(chat).toContainText("DuckDuckGo (free)");
  });
  test(`search providers use modal editors and persist chat choice at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const w = await fixture(page);
    const section = page.getByRole("region", {
        name: "Search providers",
        exact: true,
      }),
      chat = page.getByRole("region", { name: "Bot chat model" });
    await expect(section).toContainText("DuckDuckGo (free)");
    const preset = section
      .getByRole("listitem")
      .filter({ hasText: "DuckDuckGo (free)" });
    await expect(preset).toContainText("Preset · No API key required");
    await expect(preset.locator("button,input,select")).toHaveCount(0);
    await expect(section.getByRole("listitem")).toHaveCount(1);
    await expect(section.locator("input,select")).toHaveCount(0);
    await expect(chat).toContainText("Disabled");
    for (const title of ["Model providers", "Search providers"]) {
      const region = page.getByRole("region", { name: title, exact: true });
      const layout = await region.evaluate((element) => {
        const heading = element.querySelector("h2")?.getBoundingClientRect();
        const button = element
          .querySelector(".card-heading > button")
          ?.getBoundingClientRect();
        const box = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        const last = element.lastElementChild?.getBoundingClientRect();
        return {
          headingY: heading?.y ?? 0,
          buttonY: button?.y ?? 0,
          right: box.right - Number.parseFloat(style.paddingRight) - 1,
          buttonRight: button?.right ?? 0,
          bottom: box.bottom - Number.parseFloat(style.paddingBottom) - 1,
          lastBottom: last?.bottom ?? 0,
        };
      });
      expect(Math.abs(layout.headingY - layout.buttonY)).toBeLessThan(1);
      expect(Math.abs(layout.buttonRight - layout.right)).toBeLessThan(1);
      expect(Math.abs(layout.lastBottom - layout.bottom)).toBeLessThan(1);
    }
    await screenshot(page, `empty-${width}`);
    const model = page.getByRole("dialog", { name: "Edit chat model" });
    let providerSaves = 0;
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().endsWith("/api/admin/operator/search-providers")
      )
        providerSaves++;
    });
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await chooseOption(
      model.getByLabel("Search provider", { exact: true }),
      DUCKDUCKGO_PRESET_ID,
    );
    await model.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(chat).toContainText("Disabled");
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await chooseOption(
      model.getByLabel("Search provider", { exact: true }),
      DUCKDUCKGO_PRESET_ID,
    );
    await model.getByRole("button", { name: "Save chat model" }).click();
    await expect(model).toHaveCount(0);
    await page.reload();
    await expect(chat).toContainText("DuckDuckGo (free)");
    await expect(chat.locator("input,select")).toHaveCount(0);
    expect(providerSaves).toBe(0);
    const savedModel = await (
      await page.request.get(`/api/admin/workspaces/${w.id}/models`)
    ).json();
    expect(savedModel.searchProviderId).toBe(DUCKDUCKGO_PRESET_ID);
    await screenshot(page, `preset-selected-${width}`);
    await section.getByRole("button", { name: "New search provider" }).click();
    const editor = page.getByRole("dialog", { name: "New search provider" });
    await expect(editor.getByLabel("API key", { exact: true })).toHaveAttribute(
      "required",
      "",
    );
    await editor.getByLabel("Search provider type").click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(
      page.getByRole("option", { name: "DuckDuckGo (free)" }),
    ).toHaveCount(0);
    await page.getByRole("option", { name: "Exa", exact: true }).click();
    await editor.getByLabel("Provider name").fill("Cancelled search");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(section.getByRole("listitem")).toHaveCount(1);
    await section.getByRole("button", { name: "New search provider" }).click();
    await editor.getByLabel("Provider name").fill("Paid web");
    await chooseOption(editor.getByLabel("Search provider type"), "deepseek");
    await expect(editor.getByLabel("API key", { exact: true })).toHaveAttribute(
      "required",
      "",
    );
    await chooseOption(editor.getByLabel("Search provider type"), "exa");
    await editor
      .getByLabel("API key", { exact: true })
      .fill("fixture-search-secret");
    await screenshot(page, `new-${width}`);
    await editor.getByRole("button", { name: "Save search provider" }).click();
    await expect(editor).toHaveCount(0);
    const catalog = await (
      await page.request.get("/api/admin/operator/search-providers")
    ).json();
    const paid = catalog.providers.find(
      (p: { name: string }) => p.name === "Paid web",
    );
    expect(JSON.stringify(catalog)).not.toContain("fixture-search-secret");
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await chooseOption(
      model.getByLabel("Search provider", { exact: true }),
      paid.id,
    );
    await screenshot(page, `model-${width}`);
    await model.getByRole("button", { name: "Save chat model" }).click();
    await expect(model).toHaveCount(0);
    await expect(chat).toContainText("Paid web");
    await page.reload();
    await expect(chat).toContainText("Paid web");
    await expect(chat.locator("input,select")).toHaveCount(0);
    await screenshot(page, `selected-${width}`);
    await section
      .getByRole("button", { name: "Edit search provider Paid web" })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit search provider" });
    await expect(edit.getByLabel("API key", { exact: true })).toHaveValue("");
    await edit.getByLabel("Provider name").fill("Exa web");
    await edit.getByRole("button", { name: "Save search provider" }).click();
    await expect(edit).toHaveCount(0);
    await expect(chat).toContainText("Exa web");
    await section
      .getByRole("button", { name: "Remove search provider Exa web" })
      .click();
    const remove = page.getByRole("dialog", { name: "Remove search provider" });
    await remove
      .getByRole("button", { name: "Remove provider", exact: true })
      .click();
    await expect(remove.getByRole("alert")).toContainText("disable search");
    await screenshot(page, `in-use-${width}`);
    await remove.getByRole("button", { name: "Cancel", exact: true }).click();
    await chat.getByRole("button", { name: "Edit chat model" }).click();
    await chooseOption(
      model.getByLabel("Search provider", { exact: true }),
      "",
    );
    await model.getByRole("button", { name: "Save chat model" }).click();
    await expect(model).toHaveCount(0);
    await section
      .getByRole("button", { name: "Remove search provider Exa web" })
      .click();
    await remove
      .getByRole("button", { name: "Remove provider", exact: true })
      .click();
    await expect(remove).toHaveCount(0);
    await expect(section).not.toContainText("Exa web");
    await expect(chat).toContainText("Disabled");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await screenshot(page, `saved-dark-${width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`search save failure retains drafts and pending blocks dismissal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.getByRole("button", { name: "New search provider" }).click();
    const editor = page.getByRole("dialog", { name: "New search provider" });
    await editor.getByLabel("Provider name").fill("Retained search");
    await editor
      .getByLabel("API key", { exact: true })
      .fill("fixture-search-secret");
    let fail = true;
    let release: () => void = () => {};
    await page.route(
      "**/api/admin/operator/search-providers",
      async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        if (fail) {
          fail = false;
          return route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.continue();
      },
    );
    await editor.getByRole("button", { name: "Save search provider" }).click();
    await expect(editor.getByRole("alert")).toContainText("Reload");
    await expect(editor.getByLabel("Provider name")).toHaveValue(
      "Retained search",
    );
    await screenshot(page, `error-${width}`);
    await editor.getByRole("button", { name: "Save search provider" }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await screenshot(page, `pending-${width}`);
    release();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Search providers", exact: true }),
    ).toContainText("Retained search");
  });
  test(`search loading and request errors retain section layout and retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    let release: () => void = () => {};
    let waiting = true;
    await page.route(
      "**/api/admin/operator/search-providers",
      async (route) => {
        if (waiting) {
          waiting = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return route.fulfill({
            status: 503,
            json: { error: "Search settings unavailable" },
          });
        }
        await route.continue();
      },
    );
    await page.reload();
    const section = page.getByRole("region", {
      name: "Search providers",
      exact: true,
    });
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("button", { name: "New search provider" }),
    ).toBeDisabled();
    await expect(
      section.getByRole("listitem").filter({ hasText: "DuckDuckGo (free)" }),
    ).toContainText("Preset");
    await expect(
      section
        .getByRole("listitem")
        .filter({ hasText: "DuckDuckGo (free)" })
        .locator("button,input,select"),
    ).toHaveCount(0);
    const spacing = await section
      .locator(".skeleton-rows")
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const first = element
          .querySelector(".skeleton")
          ?.getBoundingClientRect();
        const last = element
          .querySelector(".skeleton-row:last-child .skeleton:last-child")
          ?.getBoundingClientRect();
        return {
          top: (first?.top ?? 0) - box.top,
          bottom: box.bottom - (last?.bottom ?? 0),
        };
      });
    expect(spacing.top).toBe(0);
    expect(spacing.bottom).toBe(0);
    await screenshot(page, `loading-${width}`);
    release();
    await expect(page.getByRole("alert")).toContainText(
      "Search settings unavailable",
    );
    await screenshot(page, `load-error-${width}`);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      section.getByRole("button", { name: "New search provider" }),
    ).toBeEnabled();
  });
}
