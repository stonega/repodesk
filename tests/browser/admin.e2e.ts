import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault, workflowSchema } from "../../src/domain.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { decide, proposeWorkflow } from "../../src/workflows/service.ts";
import { requestAccess } from "../../src/workspaces/access-requests.ts";
import { enrollOwner, newWorkspace } from "../../src/workspaces/service.ts";

let workspaceId = "";
test.describe
  .serial("web administration", () => {
    test("first visit claims setup, resumes draft and redacts credentials", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup$/);
      await page.getByLabel("Bootstrap token").fill("browser-claim-token");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByLabel("Confirm password").fill("browser test password");
      await page.getByRole("button", { name: "Create administrator" }).click();
      await expect(
        page.getByRole("heading", { name: "Set up your team assistant" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Add workspace", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Create workspace" }),
      ).toBeVisible();
      await page.getByLabel("Workspace name").fill("Browser team");
      await page.getByRole("button", { name: "Save workspace" }).click();
      await expect(page.getByText(/Browser team ·/)).toBeVisible();
      await expect(
        page.getByText("4 · Model configuration", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Model configuration", exact: true }),
      ).toBeVisible();
      await page.getByLabel(/Model API key/).fill("fake-provider-key");
      await page
        .getByLabel("Model base URL")
        .fill("https://models.example.test/v1");
      await page.getByLabel("Model", { exact: true }).fill("team/custom-model");
      await page.getByLabel("Thinking level").selectOption("high");
      await page.getByLabel("Model context window (tokens)").fill("128000");
      await page.getByLabel("Model maximum output (tokens)").fill("16000");
      await page.getByLabel("Input price (USD / million tokens)").fill("1");
      await page.getByLabel("Output price (USD / million tokens)").fill("3");
      await page.getByLabel("Model maximum output (tokens)").fill("128000");
      await page
        .getByRole("button", { name: "Save model configuration" })
        .click();
      await expect(
        page.getByText(
          "Maximum output must be smaller than the context window to leave room for input.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByLabel("Model maximum output (tokens)").fill("16000");
      await page
        .getByRole("button", { name: "Save model configuration" })
        .click();
      await expect(
        page.getByText("Model configuration saved. API key input cleared."),
      ).toBeVisible();
      await expect(
        page.getByText("4 · Model saved", { exact: true }),
      ).toBeVisible();
      const review = page.getByLabel("Saved model configuration");
      await expect(review).toContainText("https://models.example.test/v1");
      await expect(review).toContainText("team/custom-model");
      await expect(review).toContainText("high");
      await expect(review).not.toContainText("fake-provider-key");
      await expect(page.getByLabel(/Bot token/)).toHaveValue("");
      await page
        .getByLabel(/Bot token/)
        .fill("999:fake-token-that-is-never-sent-to-Telegram");
      await page.getByRole("button", { name: "Save Telegram token" }).click();
      await expect(
        page.getByText("Telegram token saved. Secret input cleared."),
      ).toBeVisible();
      await expect(page.getByLabel(/Bot token/)).toHaveValue("");
      if (process.env.BROWSER_TELEGRAM_TRANSPORT === "polling") {
        await expect(page.getByText(/Local polling is enabled/)).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Register verification webhook" }),
        ).toHaveCount(0);
        await expect(page.getByText(/Polling: ready/)).toBeVisible({
          timeout: 10000,
        });
        await expect(
          page.getByRole("button", {
            name: "Generate owner verification link",
          }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Activate bot", exact: true }),
        ).toBeDisabled();
      } else {
        await expect(
          page.getByRole("button", { name: "Register verification webhook" }),
        ).toBeVisible();
      }
      await page.reload();
      await expect(page.getByText(/Browser team ·/)).toBeVisible();
      await expect(page.getByLabel(/Model API key/)).toHaveValue("");
      await expect(page.getByLabel("Model base URL")).toHaveValue(
        "https://models.example.test/v1",
      );
      await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
        "team/custom-model",
      );
      await expect(page.getByLabel("Thinking level")).toHaveValue("high");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/setup-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page
        .getByRole("region", { name: "Model configuration", exact: true })
        .screenshot({ path: "test-results/setup-model.png" });
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      const store = new Store(pool);
      workspaceId = (await store.ids())[0] ?? "";
      await store.change(workspaceId, (w) => enrollOwner(w, "101"));
      await pool.query(
        "UPDATE admins SET telegram_id='101' WHERE username='browseradmin'",
      );
      await pool.end();
    });
    test("settings conflict, skill publication, workflow pause and audit", async ({
      page,
      context,
    }) => {
      await page.goto("/admin/settings");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Workspace settings" }),
      ).toBeVisible();
      for (const label of [
        "Reply language",
        "Input byte budget",
        "Output token budget",
      ]) {
        await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
      }
      await page.getByLabel("Model calls per run", { exact: true }).fill("21");
      await page
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await expect(
        page.getByLabel("Model calls per run", { exact: true }),
      ).toHaveAttribute("aria-invalid", "true");
      await page.getByLabel("Model calls per run", { exact: true }).fill("20");
      await page.getByLabel("Run budget (USD)", { exact: true }).fill("200");
      await page.screenshot({
        path: "test-results/workspace-settings-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("button", { name: "Save settings", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "test-results/workspace-settings-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      const second = await context.newPage();
      await second.goto("/admin/settings");
      await expect(
        second.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Browser team");
      await page
        .getByLabel("Workspace name", { exact: true })
        .fill("Updated browser team");
      await page
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await expect(page.locator(".page-title .pill")).toHaveText("Version 2");
      await second
        .getByLabel("Workspace name", { exact: true })
        .fill("Stale overwrite");
      await second
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await expect(second.getByText(/version_conflict/)).toBeVisible();
      await expect(
        second.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Stale overwrite");
      await second
        .getByRole("button", { name: "Reload current version", exact: true })
        .click();
      await expect(
        second.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Updated browser team");
      await expect(
        second.getByRole("button", {
          name: "Reload current version",
          exact: true,
        }),
      ).toHaveCount(0);
      await second.close();
      await page.getByRole("link", { name: "Skills", exact: true }).click();
      await page
        .getByRole("button", { name: "Add skill", exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: "Create skill",
        exact: true,
      });
      await editor
        .getByLabel("Skill slug", { exact: true })
        .fill("browser-skill");
      await editor
        .getByLabel("Skill name", { exact: true })
        .fill("Browser skill");
      await editor
        .getByLabel("Description", { exact: true })
        .fill("Recap convention");
      await editor
        .getByLabel("Instructions", { exact: true })
        .fill("Cite all supplied sources with [source:ID].");
      await editor.getByLabel("Read instructions", { exact: true }).uncheck();
      await editor.getByLabel("Load skill", { exact: true }).uncheck();
      await editor
        .getByLabel("Output sections", { exact: true })
        .fill("Decisions");
      await editor.getByLabel("Maximum words", { exact: true }).fill("100");
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      const card = page.locator("section").filter({
        has: page.getByRole("heading", {
          name: "Browser skill",
          exact: true,
        }),
      });
      await expect(card).toBeVisible();
      await card
        .getByRole("button", { name: "Publish draft", exact: true })
        .click();
      await expect(card.getByText(/1 published version/)).toBeVisible();
      await card.getByRole("button", { name: "enable", exact: true }).click();
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
      await card
        .getByRole("button", { name: "Publish draft", exact: true })
        .click();
      await expect(
        card.getByText("2 published versions", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByLabel("Rollback source version"),
      ).not.toBeVisible();
      await card
        .getByText("Restore a published version", { exact: true })
        .click();
      await card.getByLabel("Rollback source version").selectOption("2");
      const recap = page.locator(".skill-card").filter({
        has: page.getByRole("heading", { name: "Team recap", exact: true }),
      });
      await recap
        .getByText("Restore a published version", { exact: true })
        .click();
      await expect(recap.getByLabel("Rollback source version")).toHaveValue(
        "1",
      );
      await card
        .getByRole("button", { name: "Publish rollback as new version" })
        .click();
      await expect(
        card.getByText("3 published versions", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: "test-results/skills-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(390);
      await card.screenshot({ path: "test-results/skill-card-mobile.png" });
      await page.setViewportSize({ width: 1280, height: 800 });
      await card.getByRole("button", { name: "Test draft policy" }).click();
      await expect(
        page.getByText(/Deterministic policy test passed/),
      ).toBeVisible();
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      const store = new Store(pool);
      await store.change(workspaceId, (w) => {
        const p = proposeWorkflow(
          w,
          "101",
          workflowSchema.parse({
            name: "Browser weekly recap",
            task: "Recap",
            chatId: "101",
            recurrence: {
              frequency: "weekly",
              weekday: 5,
              hour: 17,
              minute: 0,
              timezone: "Asia/Taipei",
            },
            budgetUsd: 0.1,
            skillId: w.skills[0]?.id,
          }),
        );
        decide(w, "101", p.approval.id, true);
      });
      await pool.end();
      await page.getByRole("link", { name: "Workflows", exact: true }).click();
      const workflow = page.locator("section").filter({
        has: page.getByRole("heading", {
          name: "Browser weekly recap",
          exact: true,
        }),
      });
      await workflow
        .getByRole("button", { name: "pause", exact: true })
        .click();
      await expect(workflow.getByText("paused", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Audit", exact: true }).click();
      await expect(
        page.getByRole("cell", { name: "workflow.pause", exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("heading", { name: "Audit history" }),
      ).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/admin-mobile.png",
        fullPage: true,
      });
    });
    test("usage table paginates, handles empty/error states and fits mobile", async ({
      page,
    }) => {
      const items = Array.from({ length: 103 }, (_, i) => ({
        id: `attempt-${i}`,
        runId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        model: "deepseek-flash",
        at: "2026-09-20T08:53:03.355Z",
        reserved: 0.3903252,
        actual: i === 2 ? 0 : i === 1 ? 0.0020266 : undefined,
        status: i === 0 ? "unknown" : i < 3 ? "settled" : "reserved",
      }));
      let mode = "records";
      await page.route("**/api/admin/workspaces/*/usage?*", async (route) => {
        if (mode === "error")
          return route.fulfill({
            status: 503,
            json: { error: "Usage temporarily unavailable" },
          });
        const offset = Number(
          new URL(route.request().url()).searchParams.get("offset"),
        );
        await route.fulfill({
          json: {
            budget: 100,
            totalUsd: 0.9263,
            offset,
            total: mode === "empty" ? 0 : items.length,
            items: mode === "empty" ? [] : items.slice(offset, offset + 100),
          },
        });
      });
      await page.goto("/admin/usage");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("link", { name: "Usage", exact: true }).click();
      const table = page.getByRole("table", { name: "Usage history" });
      await expect(table.locator("tbody tr")).toHaveCount(100);
      await expect(
        page.getByText("1–100 of 103 records", { exact: true }),
      ).toBeVisible();
      await expect(
        table.getByText("Unresolved", { exact: true }),
      ).toBeVisible();
      await expect(table.locator("tbody tr").nth(1)).toContainText("$0.0020");
      await expect(table.locator("tbody tr").nth(2)).toContainText("$0.0000");
      await expect(
        page.getByRole("button", { name: "Previous page" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Next page" }).click();
      await expect(page).toHaveURL(/offset=100/);
      await expect(table.locator("tbody tr")).toHaveCount(3);
      await expect(
        page.getByText("101–103 of 103 records", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Next page" }),
      ).toBeDisabled();
      await page.reload();
      await expect(table.locator("tbody tr")).toHaveCount(3);
      await page.getByRole("button", { name: "Previous page" }).click();
      await expect(table.locator("tbody tr")).toHaveCount(100);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: "test-results/usage-desktop.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page
        .getByRole("heading", { name: "Usage & budget" })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/usage-mobile.png" });
      mode = "empty";
      await page.reload();
      await expect(table.getByText("No usage recorded yet.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Next page" }),
      ).toBeDisabled();
      mode = "error";
      await page.reload();
      await expect(page.getByRole("alert")).toContainText(
        "Usage temporarily unavailable",
      );
      await expect(table).toHaveCount(0);
      mode = "records";
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(table.locator("tbody tr")).toHaveCount(100);
    });

    test("runtime logs filter, paginate, refresh and fit a mobile screen", async ({
      page,
    }) => {
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      const log = new RuntimeLogger(pool, "worker", () => {});
      for (let i = 0; i < 55; i++) log.write("worker_started");
      log.write("telegram_polling_failed", {
        error: new Fault("telegram_polling_conflict"),
        retryDelayMs: 5000,
      });
      await log.flush();
      try {
        await page.goto("/admin/logs");
        await page.getByLabel("Username", { exact: true }).fill("browseradmin");
        await page
          .getByLabel("Password", { exact: true })
          .fill("browser test password");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page
          .getByRole("link", { name: "Runtime logs", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Runtime logs" }),
        ).toBeVisible();
        await expect(
          page.getByText("telegram_polling_failed", { exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Older logs", exact: true })
          .click();
        await expect(page.getByText(/Viewing older entries/)).toBeVisible();
        await page
          .getByRole("button", { name: "Latest logs", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Log level", exact: true })
          .selectOption("warn");
        await page
          .getByRole("combobox", { name: "Service", exact: true })
          .selectOption("worker");
        await expect(page.locator("tbody tr")).toHaveCount(1);
        await page
          .getByLabel("Search event, error code or run ID")
          .fill("no_matching_event");
        await page
          .getByRole("button", { name: "Search logs", exact: true })
          .click();
        await expect(
          page.getByText(/No logs match these filters/),
        ).toBeVisible();
        await page
          .getByLabel("Search event, error code or run ID")
          .fill("polling");
        await page
          .getByRole("button", { name: "Search logs", exact: true })
          .click();
        await expect(
          page.getByText("telegram_polling_failed", { exact: true }),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
        await page.screenshot({
          path: "test-results/runtime-logs-mobile.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({
          path: "test-results/runtime-logs-desktop.png",
          fullPage: true,
        });
        await page.getByLabel("Auto-refresh every 5 seconds").uncheck();
        log.write("telegram_polling_failed", {
          error: new Fault("telegram_rate_limited"),
        });
        await log.flush();
        await page
          .getByRole("button", { name: "Refresh logs", exact: true })
          .click();
        await expect(
          page.getByText("Code: telegram_rate_limited", { exact: true }),
        ).toBeVisible();
      } finally {
        await log.close();
        await pool.end();
      }
    });
    test("plugins register, edit, persist, reject stale saves and fit mobile", async ({
      page,
      context,
    }) => {
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Plugins", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Add your first Pi extension")).toBeVisible();
      await page
        .getByRole("button", { name: "Add plugin", exact: true })
        .click();
      await page.getByLabel("Plugin ID", { exact: true }).fill("word-count");
      await page
        .getByLabel("Installed file path")
        .fill(resolve("examples/pi-extension.ts"));
      await page.getByLabel("Tool names").fill("count_words");
      await page.getByLabel("Enable this plugin").check();
      await page
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      await expect(
        page.getByText("File verified", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText("Plugins saved.");
      await page.reload();
      const card = page.getByRole("article", { name: "Plugin word-count" });
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
      await expect(card).toContainText("count_words");
      const second = await context.newPage();
      await second.goto("/admin/plugins");
      await expect(
        second.getByRole("button", { name: "Edit word-count" }),
      ).toBeVisible();
      await second.getByRole("button", { name: "Edit word-count" }).click();
      await second.getByLabel("Plugin version").fill("stale-version");
      await card.getByRole("button", { name: "Disable word-count" }).click();
      await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
      await second
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      await expect(second.getByRole("alert")).toContainText(
        "Another operator session changed these plugins",
      );
      await expect(second.getByLabel("Plugin version")).toHaveValue(
        "stale-version",
      );
      await second.close();
      await card.getByRole("button", { name: "Edit word-count" }).click();
      await page.getByLabel("Plugin version").fill("2");
      await page
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      await expect(card).toContainText("Version 2");
      await card.getByRole("button", { name: "Edit word-count" }).click();
      await page.getByLabel("Enable this plugin").check();
      await page
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: "test-results/plugins-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await card.getByRole("button", { name: "Edit word-count" }).click();
      await expect(page.getByLabel("Installed file path")).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/plugins-mobile.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "Cancel editing" }).click();
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Remove word-count" }).click();
      await expect(page.getByText("Add your first Pi extension")).toBeVisible();
      await page.reload();
      await expect(page.getByText("Add your first Pi extension")).toBeVisible();
    });
    test("predefined Code Truth configures workspace repositories and branches", async ({
      page,
    }) => {
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      const card = page.getByRole("region", {
        name: "Predefined Code Truth extension",
      });
      await expect(card.getByText("No repositories configured.")).toBeVisible();
      await card
        .getByRole("button", { name: "Add repository", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("Repository ID", { exact: true })
        .fill("deepx-web");
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("GitHub repository URL")
        .fill("https://github.com/deepxfinance/web.git");
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("Branch 1", { exact: true })
        .fill("devnet-develop");
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByRole("button", { name: "Add network", exact: true })
        .click();
      const networkDialog = page.getByRole("dialog", {
        name: "Add network",
        exact: true,
      });
      await networkDialog.getByLabel("Network name").fill("testnet");
      await networkDialog.getByLabel("Branch name").fill("testnet-develop");
      await networkDialog
        .getByRole("button", { name: "Add network", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByRole("button", { name: "Apply repository" })
        .click();
      await card.getByLabel("Enable Code Truth", { exact: true }).check();
      await card
        .getByRole("button", { name: "Save Code Truth", exact: true })
        .click();
      await expect(card.getByRole("status")).toContainText("Code Truth saved");
      await page.reload();
      await expect(
        card.getByRole("heading", { name: "deepx-web", exact: true }),
      ).toBeVisible();
      await expect(
        card.getByText("testnet → testnet-develop", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByLabel("Enable Code Truth", { exact: true }),
      ).toBeChecked();
      await card
        .getByText("Repository indexing status", { exact: true })
        .click();
      await card
        .getByRole("button", { name: "Sync & check indexes", exact: true })
        .click();
      await expect(card.getByRole("alert")).toContainText(
        "local Code Truth service is unavailable",
      );
      await page.route(
        "**/api/admin/workspaces/*/plugins/code-truth/status",
        async (route) => {
          await route.fulfill({
            json: {
              syncing: false,
              targets: [
                {
                  target: "deepx-web",
                  networks: [
                    {
                      network: "devnet",
                      branch: "devnet-develop",
                      status: "ready",
                      commit: "a".repeat(40),
                      indexedAt: "2026-09-20T00:00:00.000Z",
                    },
                  ],
                },
              ],
            },
          });
        },
      );
      await card
        .getByRole("button", { name: "Sync & check indexes", exact: true })
        .click();
      await expect(
        card.getByText(/devnet → devnet-develop · ready/),
      ).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: "test-results/code-truth-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/code-truth-mobile.png",
        fullPage: true,
      });
      await card
        .getByRole("button", { name: "Remove repository 1", exact: true })
        .click();
      await card.getByLabel("Enable Code Truth", { exact: true }).uncheck();
      await card
        .getByRole("button", { name: "Save Code Truth", exact: true })
        .click();
      await expect(card.getByRole("status")).toContainText("Code Truth saved");
      await page.reload();
      await expect(card.getByText("No repositories configured.")).toBeVisible();
    });
    test("switching workspaces isolates plugins, Code Truth and unsaved drafts", async ({
      page,
    }) => {
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      let secondId = "";
      try {
        const original = await new Store(pool).read(workspaceId);
        const second = newWorkspace(original.operatorId, {
          ...original.settings,
          name: "Independent team",
        });
        enrollOwner(second, "101");
        secondId = second.id;
        await pool.query(
          "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
          [second.id, second.operatorId, JSON.stringify(second)],
        );
      } finally {
        await pool.end();
      }
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const picker = page.getByRole("combobox", {
        name: "Workspace",
        exact: true,
      });
      await picker.selectOption(workspaceId);
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      await page
        .getByRole("button", { name: "Add plugin", exact: true })
        .click();
      await page
        .getByLabel("Plugin ID", { exact: true })
        .fill("independent-plugin");
      await page
        .getByLabel("Installed file path")
        .fill(resolve("examples/pi-extension.ts"));
      await page.getByLabel("Tool names").fill("count_words");
      await page
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      const plugin = page.getByRole("article", {
        name: "Plugin independent-plugin",
      });
      await expect(plugin).toContainText("Version 1");
      const truth = page.getByRole("region", {
        name: "Predefined Code Truth extension",
      });
      await page.goto(`/admin/plugins?workspace=${workspaceId}`);
      await truth
        .getByRole("button", { name: "Add repository", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("Repository ID", { exact: true })
        .fill("isolated-repo");
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("GitHub repository URL")
        .fill("https://github.com/example/isolated");
      await page
        .getByRole("dialog", { name: "Add repository", exact: true })
        .getByLabel("Branch 1", { exact: true })
        .fill("main");
      await page.getByRole("button", { name: "Apply repository" }).click();
      await truth
        .getByRole("button", { name: "Save Code Truth", exact: true })
        .click();
      await expect(truth.getByRole("status")).toContainText("Code Truth saved");
      await plugin
        .getByRole("button", { name: "Edit independent-plugin" })
        .click();
      await page.getByLabel("Plugin version").fill("unsaved-draft");
      // Navigation to another workspace must also discard a mounted modal draft.
      await page.goto(`/admin/plugins?workspace=${secondId}`);
      await expect(page.getByLabel("Plugin version")).toHaveCount(0);
      await expect(page.getByText("Add your first Pi extension")).toBeVisible();
      await expect(
        truth.getByText("No repositories configured."),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Add plugin", exact: true })
        .click();
      await page
        .getByLabel("Plugin ID", { exact: true })
        .fill("independent-plugin");
      await page
        .getByLabel("Installed file path")
        .fill(resolve("examples/pi-extension.ts"));
      await page.getByLabel("Plugin version").fill("2");
      await page.getByLabel("Tool names").fill("count_words");
      await page
        .getByRole("button", { name: "Save plugin", exact: true })
        .click();
      await expect(plugin).toContainText("Version 2");
      await picker.selectOption(workspaceId);
      await expect(plugin).toContainText("Version 1");
      await expect(
        truth.getByRole("heading", { name: "isolated-repo", exact: true }),
      ).toBeVisible();
      await picker.selectOption(secondId);
      await expect(plugin).toContainText("Version 2");
      await expect(
        truth.getByText("No repositories configured."),
      ).toBeVisible();
    });
    test("GitHub App creation posts a manifest, restores the workspace and enables connection", async ({
      page,
    }) => {
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Workspace", exact: true })
        .selectOption(workspaceId);
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      const card = page.getByRole("region", { name: "GitHub connection" });
      await expect(
        card.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeDisabled();
      await card
        .getByRole("button", { name: "Create GitHub App", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Create GitHub App", exact: true })
        .getByRole("combobox", { name: "App owner", exact: true })
        .selectOption("personal");
      await expect(
        page
          .getByRole("dialog", { name: "Create GitHub App", exact: true })
          .getByLabel("GitHub organization", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("dialog", { name: "Create GitHub App", exact: true })
        .getByRole("combobox", { name: "App owner", exact: true })
        .selectOption("organization");
      await page
        .getByRole("dialog", { name: "Create GitHub App", exact: true })
        .getByLabel("GitHub organization", { exact: true })
        .fill("example");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/github-create-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.route(
        "https://github.com/organizations/example/settings/apps/new**",
        async (route) => {
          expect(route.request().method()).toBe("POST");
          const manifest = JSON.parse(
            new URLSearchParams(route.request().postData() ?? "").get(
              "manifest",
            ) ?? "{}",
          );
          expect(manifest.public).toBe(false);
          expect(manifest.default_permissions).toEqual({
            contents: "read",
            metadata: "read",
            issues: "write",
          });
          expect(manifest.hook_attributes).toEqual({
            url: "https://example.com/github/webhook",
            active: false,
          });
          expect(manifest.default_events).toEqual([]);
          expect(new URL(manifest.callback_urls[0]).origin).toBe(
            new URL(page.url()).origin,
          );
          const callback = new URL(manifest.redirect_url);
          callback.searchParams.set(
            "state",
            new URL(route.request().url()).searchParams.get("state") ?? "",
          );
          callback.searchParams.set("code", "fixture-manifest-code");
          await route.fulfill({
            status: 303,
            headers: { location: callback.href },
          });
        },
      );
      await page
        .getByRole("dialog", { name: "Create GitHub App", exact: true })
        .getByRole("button", { name: "Continue to GitHub", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`workspace=${workspaceId}&github=app-created`),
      );
      await expect(
        card.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeEnabled();
      await expect(
        card.getByText("deepx-fixture", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByRole("link", { name: "Install or update the GitHub App" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/apps/deepx-fixture/installations/new",
      );
      await expect(
        card.getByRole("button", { name: "Create GitHub App", exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        card.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeEnabled();
      await expect(page.locator("body")).not.toContainText(
        "fixture-client-secret",
      );
    });
    test("GitHub App authorization connects selected repositories to the returning workspace", async ({
      page,
    }) => {
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Workspace", exact: true })
        .selectOption(workspaceId);
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      await page.route(
        "https://github.com/login/oauth/authorize**",
        async (route) => {
          const url = new URL(route.request().url());
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
          callback.searchParams.set(
            "state",
            url.searchParams.get("state") ?? "",
          );
          callback.searchParams.set("code", "fixture-code");
          await route.fulfill({
            status: 302,
            headers: { location: callback.href },
          });
        },
      );
      const card = page.getByRole("region", { name: "GitHub connection" });
      await card
        .getByRole("button", { name: "Connect GitHub", exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}`));
      await expect(
        card.getByText("Choose repositories for this workspace"),
      ).toBeVisible();
      await card.getByLabel("GitHub installation").selectOption("501");
      await card.getByLabel("example/workspace", { exact: true }).check();
      await card
        .getByRole("button", { name: "Connect selected repositories" })
        .click();
      await expect(card.getByText("Connected", { exact: true })).toBeVisible();
      await expect(
        card.getByText("example/workspace", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByText("example/second", { exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(card.getByText("Connected", { exact: true })).toBeVisible();
      const other = await page
        .getByRole("combobox", { name: "Workspace", exact: true })
        .locator("option")
        .evaluateAll(
          (options, id) =>
            options
              .map((o) => (o as HTMLOptionElement).value)
              .find((v) => v !== id),
          workspaceId,
        );
      if (!other) throw Error("missing sibling workspace");
      await page
        .getByRole("combobox", { name: "Workspace", exact: true })
        .selectOption(other);
      await expect(
        card.getByText("Not connected", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("combobox", { name: "Workspace", exact: true })
        .selectOption(workspaceId);
      const coding = page.getByRole("region", { name: "Codex implementation" });
      await page.goto(`/admin/plugins?workspace=${workspaceId}`);
      await coding
        .getByRole("button", { name: "Add coding repository" })
        .click();
      const codingDialog = page.getByRole("dialog", {
        name: "Add coding repository",
      });
      await codingDialog
        .getByRole("combobox", { name: "Repository", exact: true })
        .selectOption("7001");
      await codingDialog
        .getByLabel("Development / base branch")
        .fill("develop");
      await codingDialog
        .getByRole("button", { name: "Save coding repository" })
        .click();
      await expect(codingDialog.getByRole("alert")).toHaveText(
        "Select at least one maintainer.",
      );
      await codingDialog.getByLabel("101", { exact: true }).check();
      await codingDialog
        .getByRole("button", { name: "Save coding repository" })
        .click();
      await expect(codingDialog).toHaveCount(0);
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/plugins/coding") &&
            r.request().method() === "PUT" &&
            r.status() === 200,
        ),
        coding.getByLabel("Enable Codex implementation").check(),
      ]);
      await page.reload();
      await expect(
        coding.getByLabel("Enable Codex implementation"),
      ).toBeChecked();
      await expect(coding.getByText(/Maintainers: 101/)).toBeVisible();
      await coding
        .getByRole("button", { name: "Edit coding repository 7001" })
        .click();
      const codingEdit = page.getByRole("dialog", {
        name: "Edit coding repository",
      });
      await codingEdit
        .getByLabel("Development / base branch")
        .fill("other-branch");
      await codingEdit
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(coding.getByText(/Base: develop/)).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await coding.screenshot({ path: "test-results/coding-mobile.png" });
      page.once("dialog", (dialog) => dialog.accept());
      await card
        .getByRole("button", { name: "Disconnect GitHub", exact: true })
        .click();
      await expect(
        card.getByText("Private repository access is disconnected.", {
          exact: false,
        }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/github-mobile.png",
        fullPage: true,
      });
    });
    test("creation dialogs isolate drafts, trap focus and keep failed saves open", async ({
      page,
    }) => {
      await page.goto("/admin/members");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Overview", exact: true }),
      ).toBeVisible();
      for (const [path, label, title] of [
        ["members", "Add member", "Add member"],
        ["workflows", "Add workflow", "Propose a schedule"],
        ["skills", "Add skill", "Create skill"],
        ["skills", "Import skill", "Import SKILL.md"],
        ["instructions", "Add instruction", "Propose an instruction"],
        ["runs", "Request a run", "Request a run"],
        ["operations", "Create panel account", "Create panel account"],
        ["plugins", "Add plugin", "Register a Pi extension"],
        ["plugins", "Add repository", "Add repository"],
      ]) {
        await page.goto(`/admin/${path}`);
        const trigger = page.getByRole("button", { name: label, exact: true });
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: title, exact: true });
        await expect(dialog).toBeVisible();
        await expect(page.locator("dialog:modal")).toHaveCount(1);
        await dialog
          .getByRole("button", { name: /^(Cancel|Cancel editing)$/ })
          .focus();
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("button", { name: `Close ${title}`, exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      // Dismissing a draft must not update membership or retain the entered ID.
      await page.goto("/admin/members");
      await page
        .getByRole("button", { name: "Add member", exact: true })
        .click();
      await page.getByLabel("Telegram user ID", { exact: true }).fill("909090");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", { name: "Add member", exact: true })
        .click();
      await expect(
        page.getByLabel("Telegram user ID", { exact: true }),
      ).toHaveValue("");
      let release!: () => void;
      const response = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/admin/workspaces/*/members", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await response;
        await route.fulfill({
          status: 409,
          json: { error: "version_conflict" },
        });
      });
      await page.getByLabel("Telegram user ID", { exact: true }).fill("909090");
      await page
        .getByRole("button", { name: "Save membership", exact: true })
        .click();
      const memberDialog = page.getByRole("dialog", {
        name: "Add member",
        exact: true,
      });
      await expect(
        memberDialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(memberDialog).toBeVisible();
      release();
      await expect(memberDialog.getByRole("status")).toContainText(
        "version_conflict",
      );
      await expect(
        page.getByLabel("Telegram user ID", { exact: true }),
      ).toHaveValue("909090");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.unroute("**/api/admin/workspaces/*/members");
      // Nested network cancellation preserves the repository draft and its focus.
      await page.goto("/admin/plugins");
      await page
        .getByRole("button", { name: "Add repository", exact: true })
        .click();
      const repo = page.getByRole("dialog", {
        name: "Add repository",
        exact: true,
      });
      await repo.getByLabel("Repository ID").fill("modal-draft");
      await repo
        .getByLabel("GitHub repository URL")
        .fill("https://github.com/example/draft");
      await repo.getByLabel("Branch 1", { exact: true }).fill("main");
      await repo
        .getByRole("button", { name: "Add network", exact: true })
        .click();
      const network = page.getByRole("dialog", {
        name: "Add network",
        exact: true,
      });
      await network.getByLabel("Network name").fill("devnet");
      await network.getByLabel("Branch name").fill("duplicate");
      await network
        .getByRole("button", { name: "Add network", exact: true })
        .click();
      await expect(network.getByRole("alert")).toHaveText(
        "This network already exists.",
      );
      await page.keyboard.press("Escape");
      await expect(network).toHaveCount(0);
      await expect(repo.getByLabel("Repository ID")).toHaveValue("modal-draft");
      await expect(
        repo.getByRole("button", { name: "Add network", exact: true }),
      ).toBeFocused();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await expect(repo).toBeVisible();
      await page.screenshot({
        path: "test-results/add-repository-modal-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: "test-results/add-repository-modal-desktop.png",
        fullPage: true,
      });
      await repo.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "modal-draft", exact: true }),
      ).toHaveCount(0);
    });
    test("access requests approve members, reject requests and fit mobile", async ({
      page,
    }) => {
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      const store = new Store(pool);
      try {
        await store.change(workspaceId, (w) => {
          requestAccess(w, {
            actor: "808",
            chatId: "808",
            name: "Access applicant",
            username: "applicant",
          });
          requestAccess(w, {
            actor: "809",
            chatId: "809",
            name: "Rejected applicant",
          });
        });
        await page.goto("/admin/members");
        await page.getByLabel("Username", { exact: true }).fill("browseradmin");
        await page
          .getByLabel("Password", { exact: true })
          .fill("browser test password");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page
          .getByRole("link", { name: "Members & access", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Workspace", exact: true })
          .selectOption(workspaceId);
        const requests = page.getByRole("region", {
          name: "Access requests",
          exact: true,
        });
        await expect(
          requests.getByRole("heading", { name: "Access requests (2)" }),
        ).toBeVisible();
        await expect(requests.getByLabel("Request access link")).toHaveValue(
          new RegExp(`start=access_${workspaceId}`),
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
        await page.screenshot({
          path: "test-results/access-requests-mobile.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({
          path: "test-results/access-requests-desktop.png",
          fullPage: true,
        });
        const applicant = requests.getByRole("article").filter({
          has: page.getByRole("heading", {
            name: "Access applicant",
            exact: true,
          }),
        });
        // A concurrent policy edit must leave the request pending and explain reload.
        await store.change(workspaceId, (w) => {
          w.policy.version++;
        });
        await applicant
          .getByRole("button", { name: "Approve access", exact: true })
          .click();
        await expect(requests.getByRole("alert")).toContainText(
          "Reload the current version",
        );
        await requests
          .getByRole("button", { name: "Reload access requests" })
          .click();
        await expect(requests.getByRole("alert")).toHaveCount(0);
        await applicant
          .getByRole("button", { name: "Approve access", exact: true })
          .click();
        await expect(requests.getByRole("status")).toContainText(
          "Access approved for Access applicant.",
        );
        await expect(
          page.getByRole("row").filter({ hasText: "ID: 808" }),
        ).toBeVisible();
        await requests
          .getByRole("button", { name: "Reject request", exact: true })
          .click();
        await expect(
          requests.getByText("No pending access requests."),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByText("No pending access requests."),
        ).toBeVisible();
        const current = await store.read(workspaceId);
        expect(current.policy.allowed).toContain("808");
        expect(current.members.find((m) => m.id === "809")).toBeUndefined();
        expect(
          current.accessRequests?.find((r) => r.actor === "809")?.status,
        ).toBe("rejected");
      } finally {
        await pool.end();
      }
    });
    test("members and access share one page with Telegram profiles and effective access", async ({
      page,
    }) => {
      const fixture = JSON.parse(
        await readFile("test-results/browser-db.json", "utf8"),
      );
      const pool = database(fixture.url);
      const store = new Store(pool);
      try {
        await store.change(workspaceId, (w) => {
          w.members.push(
            { id: "810", role: "member", active: true },
            {
              id: "811",
              role: "member",
              active: false,
              name: "Inactive person",
              username: "inactive_person",
            },
          );
          w.policy.allowed.push("811", "812");
          w.policy.version++;
        });
        await page.goto("/admin/members");
        await page.getByLabel("Username", { exact: true }).fill("browseradmin");
        await page
          .getByLabel("Password", { exact: true })
          .fill("browser test password");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(
          page.getByRole("link", { name: "Members & access", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Allowed users", exact: true }),
        ).toHaveCount(0);
        await page.goto(`/admin/access-policy?workspace=${workspaceId}`);
        await expect(page).toHaveURL(
          new RegExp(`/admin/members\\?workspace=${workspaceId}`),
        );
        await expect(
          page.getByRole("heading", { name: "Members & access", exact: true }),
        ).toBeVisible();
        const table = page.getByRole("region", { name: "Member access table" });
        const row = (id: string) =>
          table.getByRole("row").filter({ hasText: `ID: ${id}` });
        await expect(row("808")).toContainText("@applicant");
        await expect(row("808")).toContainText("Access applicant");
        await expect(row("810")).toContainText("Whitelist required");
        await expect(row("811")).toContainText("Inactive");
        await expect(row("812")).toContainText("Not enrolled");
        const search = page.getByLabel(
          "Search members by name, username or ID",
        );
        await search.fill("@applicant");
        expect(new URL(page.url()).searchParams.get("workspace")).toBe(
          workspaceId,
        );
        await expect(table.getByRole("row")).toHaveCount(2);
        await expect(row("808")).toBeVisible();
        await search.fill("810");
        await expect(row("810")).toContainText("Telegram user");
        await search.fill("");
        const policy = page.getByRole("region", {
          name: "Access policy",
          exact: true,
        });
        await policy.getByLabel("Access mode").selectOption("members");
        await policy
          .getByRole("button", { name: "Preview affected work" })
          .click();
        await policy
          .getByRole("button", { name: "Apply reviewed policy" })
          .click();
        await expect(
          row("810").getByText("Allowed", { exact: true }),
        ).toBeVisible();
        await expect(row("811")).toContainText("Inactive");
        await expect(row("812")).toContainText("Not enrolled");
        await page.getByRole("button", { name: "Edit member 808" }).click();
        const dialog = page.getByRole("dialog", { name: "Edit member" });
        await expect(
          dialog.getByLabel("Telegram user ID", { exact: true }),
        ).toHaveAttribute("readonly", "");
        await dialog.getByLabel("Role", { exact: true }).selectOption("admin");
        await dialog.getByRole("button", { name: "Save membership" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(row("808")).toContainText("admin");
        await expect(row("808")).toContainText("@applicant");
        await policy.getByLabel("Access mode").selectOption("whitelist");
        await policy.getByText(/^Manage whitelist IDs/).click();
        const ids = policy.getByLabel(
          "Telegram user IDs (one per line or comma separated)",
        );
        await ids.fill("101\n811\n812");
        await policy
          .getByRole("button", { name: "Preview affected work" })
          .click();
        await policy
          .getByRole("button", { name: "Apply reviewed policy" })
          .click();
        await expect(row("808")).toContainText("Whitelist required");
        await ids.fill("");
        await policy
          .getByRole("button", { name: "Preview affected work" })
          .click();
        await policy
          .getByRole("button", { name: "Apply reviewed policy" })
          .click();
        await expect(policy.getByRole("status")).toContainText(
          "last_admin_lockout",
        );
        await page.reload();
        await policy.getByText(/^Manage whitelist IDs/).click();
        await expect(ids).toHaveValue("101\n811\n812");
        await policy.getByText(/^Manage whitelist IDs/).click();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({
          path: "test-results/members-access-desktop.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
        await page.screenshot({
          path: "test-results/members-access-mobile.png",
          fullPage: true,
        });
      } finally {
        await store.change(workspaceId, (w) => {
          w.policy.mode = "whitelist";
          if (!w.policy.allowed.includes("808")) w.policy.allowed.push("808");
          w.policy.version++;
        });
        await pool.end();
      }
    });
    test("structured forms preserve versions, drafts, and safe approval previews", async ({
      page,
    }) => {
      await page.goto("/admin/workflows");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Overview", exact: true }),
      ).toBeVisible();
      await page.goto(`/admin/workflows?workspace=${workspaceId}`);
      const card = page.locator("section").filter({
        has: page.getByRole("heading", {
          name: "Browser weekly recap",
          exact: true,
        }),
      });
      await card
        .getByRole("button", { name: "Edit proposal", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Edit Browser weekly recap",
      });
      await expect(
        dialog.getByLabel("Workflow name", { exact: true }),
      ).toHaveValue("Browser weekly recap");
      await dialog
        .getByLabel("Workflow name", { exact: true })
        .fill("Revised recap");
      await dialog.getByLabel("Repeat", { exact: true }).selectOption("daily");
      await expect(
        dialog.getByLabel("Day of week", { exact: true }),
      ).toHaveCount(0);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const payloads: Record<string, unknown>[] = [];
      await page.route(
        "**/api/admin/workspaces/*/workflows/*",
        async (route) => {
          if (route.request().method() !== "PUT") return route.continue();
          payloads.push(route.request().postDataJSON());
          await gate;
          await route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
        },
      );
      await dialog
        .getByRole("button", { name: "Preview approval proposal" })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      release();
      await expect(dialog.getByRole("alert")).toContainText("version_conflict");
      await expect(
        dialog.getByLabel("Workflow name", { exact: true }),
      ).toHaveValue("Revised recap");
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.version).toEqual(expect.any(Number));
      expect(payloads[0]?.spec).toMatchObject({
        name: "Revised recap",
        recurrence: { frequency: "daily", hour: 17, minute: 0 },
      });
      expect(
        (payloads[0]?.spec as { recurrence: object } | undefined)?.recurrence,
      ).not.toHaveProperty("weekday");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.unroute("**/api/admin/workspaces/*/workflows/*");
      await page.goto(`/admin/instructions?workspace=${workspaceId}`);
      await page
        .getByRole("button", { name: "Add instruction", exact: true })
        .click();
      const instruction = page.getByRole("dialog", {
        name: "Propose an instruction",
      });
      await instruction
        .getByLabel("Instruction", { exact: true })
        .fill("Keep decisions separate from suggestions.");
      await instruction
        .getByLabel("Applies to", { exact: true })
        .selectOption("personal");
      await instruction
        .getByRole("button", { name: "Create approval proposal" })
        .click();
      await expect(instruction).toHaveCount(0);
      await expect(
        page.getByText("Keep decisions separate from suggestions.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("main pre")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Approve exact proposal" }).first(),
      ).toBeVisible();
      await page.screenshot({
        path: "test-results/readable-approvals-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/readable-approvals-mobile.png",
        fullPage: true,
      });
    });
    test("all admin data screens and operator forms avoid raw JSON", async ({
      page,
    }) => {
      await page.goto("/admin/operations");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Overview", exact: true }),
      ).toBeVisible();
      for (const path of [
        "overview",
        "settings",
        "access-policy",
        "members",
        "chats",
        "workflows",
        "skills",
        "instructions",
        "runs",
        "usage",
        "audit",
        "deletion",
        "operations",
        "plugins",
      ]) {
        await page.goto(`/admin/${path}?workspace=${workspaceId}`);
        await expect(page.locator("main h1")).toBeVisible();
        await expect(page.locator("main pre")).toHaveCount(0);
        await expect(page.getByLabel("Configuration (JSON)")).toHaveCount(0);
      }
      await page.goto("/admin/operations");
      await page
        .getByRole("button", { name: "Create panel account", exact: true })
        .click();
      const account = page.getByRole("dialog", {
        name: "Create panel account",
      });
      await expect(
        account.getByLabel("Password", { exact: true }),
      ).toHaveAttribute("type", "password");
      await account
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page.screenshot({
        path: "test-results/readable-operations-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/readable-operations-mobile.png",
        fullPage: true,
      });
    });
    test("routine pages have no refresh controls", async ({ page }) => {
      await page.goto("/admin/overview");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Overview", exact: true }),
      ).toBeVisible();
      for (const [path, heading] of [
        ["overview", "Your team, in view"],
        ["settings", "Workspace settings"],
        ["members", "Members & access"],
        ["workflows", "Scheduled workflows"],
        ["runs", "Runs & delivery"],
        ["usage", "Usage & budget"],
        ["audit", "Audit history"],
        ["plugins", "Plugins"],
        ["operations", "Operations"],
      ]) {
        await page.goto(`/admin/${path}`);
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /refresh|reload/i }),
        ).toHaveCount(0);
      }
      await page.goto("/admin/logs");
      await expect(
        page.getByLabel("Auto-refresh every 5 seconds"),
      ).toBeChecked();
      await expect(
        page.getByRole("button", { name: "Refresh logs", exact: true }),
      ).toHaveCount(0);
      await page.getByLabel("Auto-refresh every 5 seconds").uncheck();
      await expect(
        page.getByRole("button", { name: "Refresh logs", exact: true }),
      ).toBeVisible();
    });
    test("expired cookie redirects the interface to sign-in", async ({
      page,
    }) => {
      await page.goto("/admin/runs");
      await expect(
        page.getByRole("heading", { name: "Welcome back" }),
      ).toBeVisible();
    });
  });
