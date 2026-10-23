import { expect, type Page, test } from "@playwright/test";
import type { TranscriptionPage } from "../../src/transcription/config.ts";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function fixture(page: Page) {
  const data: TranscriptionPage = {
    revision: 0,
    settings: { enabled: false, generation: 0 },
    model: "Qwen/Qwen3-ASR-0.6B",
    status: { state: "not_downloaded" },
    limits: { maxBytes: 5242880, maxSeconds: 120 },
  };
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    loadError: false,
    saveError: false,
  };
  const writes: { enabled: boolean; revision: number }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/plugins/transcription")) {
      if (route.request().method() === "GET") {
        await controls.loading;
        if (controls.loadError)
          return route.fulfill({ status: 503, json: { error: "unavailable" } });
      } else {
        const body = route.request().postDataJSON();
        writes.push(body);
        await controls.pending;
        if (controls.saveError)
          return route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
        if (!path.endsWith("/retry")) {
          data.revision++;
          data.settings = {
            enabled: body.enabled,
            generation: data.settings.generation + 1,
          };
        }
        if (body.enabled) data.status = { state: "downloading" };
      }
      return route.fulfill({ json: data });
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
              ? [{ id: workspace, name: "Audio workspace" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 0,
                    source: "empty",
                    entries: [],
                    workspaces: [{ id: workspace, name: "Audio workspace" }],
                    audit: [],
                  }
                : { providers: [] },
    });
  });
  return {
    data,
    controls,
    writes,
    open: () =>
      page.goto(`/admin/plugins/transcription?workspace=${workspace}`),
  };
}
for (const width of [1280, 390]) {
  test(`Qwen3-ASR enable/download/disable and layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    await page.goto(`/admin/plugins?workspace=${workspace}`);
    await page.getByRole("link").filter({ hasText: "Qwen3-ASR" }).click();
    const toggle = page.getByRole("switch", { name: "Enable Qwen3-ASR" });
    await expect(toggle).not.toBeChecked();
    const model = page.getByRole("region", { name: "Transcription model" });
    const configuration = page.getByRole("region", {
      name: "Voice transcription",
      exact: true,
    });
    await expect(configuration.locator("input,select,textarea")).toHaveCount(0);
    await expect(model.getByRole("status")).toHaveText("Not downloaded");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`disabled-${theme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    let release = () => {};
    f.controls.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await toggle.click();
    await expect(toggle).toBeDisabled();
    expect(f.writes).toHaveLength(1);
    await page.screenshot({
      path: test.info().outputPath("pending.png"),
      fullPage: true,
    });
    release();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(model.getByRole("status")).toHaveText("Downloading model…");
    await page.screenshot({
      path: test.info().outputPath("downloading.png"),
      fullPage: true,
    });
    f.data.status = { state: "ready" };
    await expect(model.getByRole("status")).toHaveText("Ready", {
      timeout: 7000,
    });
    await page.screenshot({
      path: test.info().outputPath("ready.png"),
      fullPage: true,
    });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    f.data.status = { state: "ready" };
    await expect(model.getByRole("status")).toHaveText("Ready", {
      timeout: 7000,
    });
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await expect(model.getByRole("status")).toHaveText("Ready");
    const spacing = await model.evaluate((el) => {
      const style = getComputedStyle(el);
      const first = el.firstElementChild as HTMLElement;
      const last = el.lastElementChild as HTMLElement;
      return {
        top: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
        bottom:
          el.getBoundingClientRect().bottom -
          last.getBoundingClientRect().bottom,
        paddingTop: parseFloat(style.paddingTop),
        paddingBottom: parseFloat(style.paddingBottom),
      };
    });
    expect(Math.abs(spacing.top - spacing.paddingTop)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(spacing.bottom - spacing.paddingBottom),
    ).toBeLessThanOrEqual(2);
  });
  test(`Qwen3-ASR loading, failure and retry recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await fixture(page);
    let release = () => {};
    f.controls.loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.open();
    await expect(
      page.getByRole("heading", { name: "Qwen3-ASR", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Model download" }),
    ).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("loading.png"),
      fullPage: true,
    });
    f.controls.loadError = true;
    release();
    await expect(page.getByRole("alert")).toContainText("Could not load");
    f.controls.loadError = false;
    await page
      .getByRole("button", { name: "Reload voice transcription settings" })
      .click();
    const toggle = page.getByRole("switch", { name: "Enable Qwen3-ASR" });
    await expect(toggle).toBeEnabled();
    f.controls.saveError = true;
    await toggle.click();
    await expect(page.getByRole("alert")).toContainText("another session");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    f.controls.saveError = false;
    f.data.settings.enabled = true;
    f.data.status = { state: "error", error: "download_failed" };
    await page
      .getByRole("button", { name: "Reload voice transcription settings" })
      .click();
    const model = page.getByRole("region", { name: "Transcription model" });
    await expect(model.getByRole("status")).toHaveText("Download failed");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`error-${theme}.png`),
        fullPage: true,
      });
    }
    const retry = page.getByRole("button", { name: "Retry download" });
    await expectTopRightAction(model, retry);
    if (width === 390) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const last = await model.locator("p").last().boundingBox();
      const launcher = await page.locator(".self-check-launcher").boundingBox();
      if (!last || !launcher) throw Error("Missing content bounds");
      expect(last.y + last.height).toBeLessThan(launcher.y);
    }
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(model.getByRole("status")).toHaveText("Downloading model…");
    expect(f.writes.at(-1)?.enabled).toBe(true);
    f.data.status = { state: "unavailable" };
    await page.reload();
    await expect(model.getByRole("status")).toHaveText("Runtime unavailable");
    await expect(retry).toBeEnabled();
  });
}
