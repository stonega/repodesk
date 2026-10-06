import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault, workflowSchema } from "../../src/domain.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { decrypt } from "../../src/setup/credentials.ts";
import { decide, proposeWorkflow } from "../../src/workflows/service.ts";
import { requestAccess } from "../../src/workspaces/access-requests.ts";
import { enrollOwner } from "../../src/workspaces/service.ts";

let workspaceId = "";
const browserDbPath = join(tmpdir(), "repodesk-browser-3107-db.json");
async function chooseWorkspace(page: Page, id: string) {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .locator(`[role="menuitemradio"][data-workspace-id="${id}"]`)
    .click();
}
test.describe
  .serial("web administration", () => {
    test.beforeEach(async () => {
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
      const pool = database(fixture.url);
      try {
        // Independent scenarios must not share accumulated login attempts.
        await pool.query("DELETE FROM auth_limits");
      } finally {
        await pool.end();
      }
    });
    test("first visit follows setup into panel model settings and activation", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup$/);
      await expect(
        page.getByRole("heading", { name: "Make this workspace yours" }),
      ).toBeVisible();
      const network = page.getByRole("img", {
        name: "Your repositories, in the conversation",
      });
      await expect(network).toBeVisible();
      await expect(network.locator(".network-signal").first()).toHaveCSS(
        "animation-name",
        "none",
      );
      const art = page.locator(".layout-auth aside");
      const formPanel = page.locator(".auth-main");
      const desktopArt = await art.boundingBox();
      const desktopForm = await formPanel.boundingBox();
      expect(
        Math.abs((desktopArt?.width ?? 0) - (desktopForm?.width ?? 0)),
      ).toBeLessThan(2);
      await page.screenshot({
        path: "test-results/setup-entry-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await expect(art).toHaveCSS("width", "390px");
      await expect(network).toBeVisible();
      await page.screenshot({
        path: "test-results/setup-entry-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(page.locator(".auth-form input")).toHaveCount(2);
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Create administrator" }).click();
      await expect(
        page.getByRole("heading", { name: "Set up your team assistant" }),
      ).toBeVisible();
      await expect(page.locator(".layout-setup aside")).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Setup steps" }),
      ).toBeVisible();
      const setupSteps = page.getByRole("navigation", { name: "Setup steps" });
      await expect(setupSteps.getByRole("button")).toHaveCount(3);
      await expect(setupSteps).toContainText("GitHub App");
      await expect(setupSteps).not.toContainText("Enter panel");
      await expect(
        page.getByRole("heading", { name: "Connect Telegram" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Timezone")).toHaveJSProperty(
        "tagName",
        "SELECT",
      );
      await page.getByLabel("Timezone").selectOption("America/New_York");
      await page.getByLabel("Workspace name").fill("Browser team");
      await page.getByRole("button", { name: "Continue to Telegram" }).click();
      await expect(
        page.getByRole("heading", { name: "Connect Telegram" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Continue to GitHub App" })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Enter a bot token to continue.",
      );
      await page
        .getByLabel(/Bot token/)
        .fill("999:fake-token-that-is-never-sent-to-Telegram");
      await page
        .getByRole("button", { name: "Continue to GitHub App" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Connect GitHub" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Connect GitHub" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Disconnect GitHub" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: "test-results/setup-github.png",
        fullPage: true,
      });
      await page.goto("/admin");
      await expect(
        page.getByRole("link", { name: "Runs", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Workflows", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "0 runs. View details" }).click();
      await expect(
        page.getByRole("heading", { name: "Runs & delivery" }),
      ).toBeVisible();
      await expect(page.getByText("No assistant runs yet.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Request a run" }),
      ).toHaveCount(0);
      await page.getByRole("link", { name: "Workflows", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Scheduled workflows" }),
      ).toBeVisible();
      await expect(page.getByText("No scheduled workflows yet.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Add workflow" }),
      ).toHaveCount(0);
      await page.goto("/admin");
      const botCard = page.getByRole("region", { name: "Telegram bot" });
      const githubCard = page.getByRole("region", { name: "GitHub" });
      await expect(botCard).toContainText("@fixture_bot");
      await expect(botCard).toContainText("Configured");
      await expect(githubCard).toContainText("Not connected");
      await botCard.getByRole("button", { name: "Manage bot" }).click();
      const botDialog = page.getByRole("dialog", {
        name: "Manage Telegram bot",
      });
      await expect(botDialog).toBeVisible();
      await expect(botDialog).toContainText("Current bot: @fixture_bot");
      await expect(page).toHaveURL(/\/admin\/?$/);
      const replacementToken = botDialog.getByLabel("New bot token");
      await expect(replacementToken).toHaveAttribute("type", "text");
      await expect(replacementToken).toHaveValue("");
      await replacementToken.fill(
        "999:fake-token-that-is-never-sent-to-Telegram",
      );
      await botDialog.getByRole("button", { name: "Save token" }).click();
      await expect(botDialog).toHaveCount(0);
      await expect(page.getByText("Telegram bot token saved.")).toBeVisible();
      await expect(botCard).toContainText("@fixture_bot");
      await expect(page).toHaveURL(/\/admin\/?$/);
      await botCard.getByRole("button", { name: "Manage bot" }).click();
      await expect(
        page
          .getByRole("dialog", { name: "Manage Telegram bot" })
          .getByLabel("New bot token"),
      ).toHaveValue("");
      await page
        .getByRole("button", { name: "Close Manage Telegram bot" })
        .click();
      await expect(page.getByRole("link", { name: "Plugins" })).toBeVisible();
      await page.getByRole("link", { name: "Plugins" }).click();
      await expect(
        page.getByRole("heading", { name: "Installed" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Model settings" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Model settings" }).click();
      await expect(
        page.getByRole("heading", { name: "Model settings" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Activate bot", exact: true }),
      ).toBeDisabled();
      const modelCard = page.getByRole("region", {
        name: "Model configuration",
      });
      await expect(modelCard.locator(".settings-item")).toHaveCount(8);
      await expect(
        modelCard.getByText("Missing", { exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Model base URL")).toHaveCount(0);
      await modelCard
        .getByRole("button", { name: "Edit model configuration" })
        .click();
      const modelDialog = page.getByRole("dialog", {
        name: "Edit model configuration",
      });
      await expect(modelDialog).toBeVisible();
      await expect(modelDialog.getByLabel(/Model API key/)).toBeFocused();
      await page
        .getByRole("button", { name: "Save model configuration" })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Enter a model API key to save settings.",
      );
      await expect(page.getByLabel("Thinking level")).toBeHidden();
      await page.getByText("Advanced model settings").click();
      await page.getByLabel(/Model API key/).fill("fake-provider-key");
      await page
        .getByLabel("Model base URL")
        .fill("https://models.example.test/v1");
      await page.getByLabel("Model", { exact: true }).fill("team/custom-model");
      await page.getByLabel("Thinking level").selectOption("high");
      await page.getByLabel("Model context window (tokens)").fill("128000");
      await page.getByLabel("Model maximum output (tokens)").fill("128000");
      await page.getByLabel("Input price (USD / million tokens)").fill("1");
      await page.getByLabel("Output price (USD / million tokens)").fill("3");
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
      await expect(page.getByText("Model settings saved.")).toBeVisible();
      await expect(modelDialog).toHaveCount(0);
      await expect(
        modelCard.getByText("Configured", { exact: true }),
      ).toBeVisible();
      await expect(
        modelCard.getByText("team/custom-model", { exact: true }),
      ).toBeVisible();
      await expect(
        modelCard.getByText("128,000", { exact: true }),
      ).toBeVisible();
      await expect(
        modelCard.getByText("16,000", { exact: true }),
      ).toBeVisible();
      await expect(modelCard).not.toContainText("fake-provider-key");
      await page.screenshot({
        path: "test-results/model-summary-desktop.png",
        fullPage: true,
      });
      await page.reload();
      await modelCard
        .getByRole("button", { name: "Edit model configuration" })
        .click();
      await expect(page.getByLabel(/Model API key/)).toHaveValue("");
      await expect(page.getByLabel("Model base URL")).toHaveValue(
        "https://models.example.test/v1",
      );
      await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
        "team/custom-model",
      );
      await page.getByText("Advanced model settings").click();
      await expect(page.getByLabel("Thinking level")).toHaveValue("high");
      await page.screenshot({
        path: "test-results/model-editor-desktop.png",
        fullPage: true,
      });
      await page
        .getByLabel("Model", { exact: true })
        .fill("discard-this-draft");
      await modelDialog
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(modelDialog).toHaveCount(0);
      await expect(
        modelCard.getByRole("button", { name: "Edit model configuration" }),
      ).toBeFocused();
      await modelCard
        .getByRole("button", { name: "Edit model configuration" })
        .click();
      await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
        "team/custom-model",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByText("Advanced model settings").click();
      await expect(modelDialog).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await expect
        .poll(() =>
          modelDialog.evaluate(
            (dialog) => dialog.scrollWidth <= dialog.clientWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: "test-results/model-editor-mobile.png",
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(modelDialog).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      if (process.env.BROWSER_TELEGRAM_TRANSPORT === "polling") {
        await expect(page.getByText(/Polling: ready/)).toBeVisible({
          timeout: 10000,
        });
        await expect(
          page.getByRole("button", { name: "Activate bot", exact: true }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Activate bot" }).click();
        await expect(
          page.getByText(/Active. Share the access link/),
        ).toBeVisible();
        await expect(page.getByText("No one has access yet.")).toBeVisible();
        await expect(
          page.getByText("Link my Telegram account (optional)"),
        ).toBeVisible();
        await page.getByLabel("Telegram user ID").fill("202");
        await page.getByRole("button", { name: "Allow user" }).click();
        await expect(page.getByText("202 · member")).toBeVisible();
        await page.getByRole("button", { name: "Revoke" }).click();
        await expect(page.getByText("No one has access yet.")).toBeVisible();
      } else {
        await expect(
          page.getByRole("button", { name: "Register Telegram webhook" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Register Telegram webhook" })
          .click();
        await expect(
          page.getByText(/Webhook mode requires a public HTTPS address/),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Activate bot", exact: true }),
        ).toBeDisabled();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/panel-model-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
      const pool = database(fixture.url);
      const store = new Store(pool);
      workspaceId = (await store.ids())[0] ?? "";
      await store.change(workspaceId, (w) => {
        enrollOwner(w, "101");
        const owner = w.members.find((member) => member.id === "101");
        if (owner) owner.username = "maintainer";
      });
      await pool.query(
        "UPDATE admins SET telegram_id='101' WHERE username='browseradmin'",
      );
      await pool.end();
    });
    test("settings conflict, skill publication, workflow pause and audit", async ({
      page,
      context,
    }) => {
      await page.goto("/admin/overview");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Your team, in view" }),
      ).toBeVisible();
      const teamCard = page.getByRole("region", { name: "Team" });
      await expect(teamCard).toContainText("Browser team");
      await expect(teamCard).toContainText("5 minutes");
      await expect(
        teamCard.getByRole("button", { name: "Edit team configuration" }),
      ).toHaveCount(1);
      for (const label of [
        "Reply language",
        "Input byte budget",
        "Output token budget",
      ]) {
        await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
      }
      await expect(
        page.getByLabel("Model calls per run", { exact: true }),
      ).toHaveCount(0);
      await teamCard
        .getByRole("button", { name: "Edit team configuration" })
        .click();
      const callsDialog = page.getByRole("dialog", {
        name: "Edit team configuration",
      });
      await expect(callsDialog.locator("form")).toHaveCount(1);
      await expect(
        callsDialog.getByLabel("Missed-run grace (minutes)"),
      ).toHaveCount(0);
      await callsDialog
        .getByRole("spinbutton", { name: "Model calls per run" })
        .fill("21");
      await page
        .getByRole("button", { name: "Save configuration", exact: true })
        .click();
      await expect(
        callsDialog.getByRole("spinbutton", { name: "Model calls per run" }),
      ).toHaveAttribute("aria-invalid", "true");
      await callsDialog
        .getByRole("spinbutton", { name: "Model calls per run" })
        .fill("20");
      await callsDialog.getByLabel("Run budget (USD)").fill("200");
      await page.screenshot({
        path: "test-results/workspace-settings-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        callsDialog.getByRole("button", {
          name: "Save configuration",
          exact: true,
        }),
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
      await page.clock.install();
      await callsDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await expect(callsDialog).toHaveCount(0);
      const toast = page.getByRole("region", {
        name: "Notification",
        exact: true,
      });
      await expect(toast.getByRole("status")).toHaveText(
        "Team configuration saved.",
      );
      await expect(toast).toHaveCSS("position", "fixed");
      await expect(teamCard.getByText("Team configuration saved.")).toHaveCount(
        0,
      );
      const toastBounds = await toast.boundingBox();
      expect(toastBounds).not.toBeNull();
      expect(toastBounds?.x).toBeGreaterThanOrEqual(0);
      expect(
        (toastBounds?.x ?? 0) + (toastBounds?.width ?? 0),
      ).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: "test-results/configuration-toast-mobile.png",
        fullPage: true,
      });
      await toast.hover();
      await page.clock.fastForward(7000);
      await expect(toast).toBeVisible();
      await toast.getByRole("button", { name: "Dismiss notification" }).focus();
      await page.mouse.move(0, 0);
      await page.clock.fastForward(7000);
      await expect(toast).toBeVisible();
      await toast.getByRole("button", { name: "Dismiss notification" }).blur();
      await page.clock.fastForward(6000);
      await expect(toast).toHaveCount(0);
      await expect(
        teamCard
          .getByRole("listitem")
          .filter({ hasText: "Model calls per run" }),
      ).toContainText("20 calls");
      await expect(
        teamCard.getByRole("listitem").filter({ hasText: "Run budget (USD)" }),
      ).toContainText("$200");
      await expect(
        page.getByRole("button", { name: "Edit Missed-run grace (minutes)" }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page
        .getByRole("button", { name: "Edit team configuration" })
        .click();
      await page
        .getByLabel("Workspace name", { exact: true })
        .fill("Discarded");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        teamCard.getByRole("listitem").filter({ hasText: "Workspace name" }),
      ).toContainText("Browser team");
      const second = await context.newPage();
      await second.goto("/admin/overview");
      await second
        .getByRole("button", { name: "Edit team configuration" })
        .click();
      const staleDialog = second.getByRole("dialog", {
        name: "Edit team configuration",
      });
      await expect(
        staleDialog.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Browser team");
      await staleDialog
        .getByLabel("Workspace name", { exact: true })
        .fill("Stale overwrite");
      await page
        .getByRole("button", { name: "Edit team configuration" })
        .click();
      await page
        .getByLabel("Workspace name", { exact: true })
        .fill("Updated browser team");
      await page
        .getByRole("button", { name: "Save configuration", exact: true })
        .click();
      await expect(teamCard).toContainText("Settings version 3");
      await expect(toast.getByRole("status")).toHaveText(
        "Team configuration saved.",
      );
      await page.screenshot({
        path: "test-results/configuration-toast-desktop.png",
        fullPage: true,
      });
      await toast.getByRole("button", { name: "Dismiss notification" }).click();
      await expect(toast).toHaveCount(0);
      await second
        .getByRole("button", { name: "Save configuration", exact: true })
        .click();
      await expect(second.getByText(/version_conflict/)).toBeVisible();
      await expect(
        staleDialog.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Stale overwrite");
      await second
        .getByRole("button", { name: "Reload current version", exact: true })
        .click();
      await expect(staleDialog).toHaveCount(0);
      await second
        .getByRole("button", { name: "Edit team configuration" })
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
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
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
      await expect(table).toBeVisible();
      await expect(table.locator("tbody tr")).toHaveCount(0);
      mode = "records";
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(table.locator("tbody tr")).toHaveCount(100);
    });

    test("runtime logs filter, paginate, refresh and fit a mobile screen", async ({
      page,
    }) => {
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
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
      await expect(
        page.getByRole("heading", { name: "Installed" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Markets" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open Code Truth" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open Codex" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open pi-mcp-adapter" }),
      ).toBeVisible();
      await page.screenshot({
        path: "test-results/plugins-catalog-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/plugins-catalog-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole("link", { name: "Open pi-web-access" }).click();
      await expect(page).toHaveURL(/\/admin\/plugins\/market\/pi-web-access/);
      await expect(page.locator(".plugin-back-link svg")).toBeVisible();
      await expect(
        page.getByText("Not installed or compatibility checked"),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Register a reviewed local file" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Register a Pi extension" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel editing" }).click();
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
        page.getByRole("link", { name: "Open word-count" }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText("Plugins saved.");
      await page.getByRole("link", { name: "Open word-count" }).click();
      const card = page.getByRole("region", { name: "Plugin word-count" });
      await expect(
        card.getByText("File verified", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
      await expect(card).toContainText("count_words");
      await page.reload();
      const second = await context.newPage();
      await second.goto(page.url());
      await expect(
        second.getByRole("button", { name: "Edit word-count" }),
      ).toBeVisible();
      await second.getByRole("button", { name: "Edit word-count" }).click();
      await second.getByLabel("Plugin version").fill("stale-version");
      await page.getByRole("switch", { name: "Enable word-count" }).click();
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
      await expect(card.getByText("2", { exact: true })).toBeVisible();
      await page.getByRole("switch", { name: "Enable word-count" }).click();
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
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
      await expect(
        page.getByRole("link", { name: "Open word-count" }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByRole("link", { name: "Open word-count" }),
      ).toHaveCount(0);
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
      await page.getByRole("link", { name: "Open Code Truth" }).click();
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
      await card
        .getByRole("switch", { name: "Enable Code Truth", exact: true })
        .click();
      await expect(
        card.getByRole("switch", { name: "Enable Code Truth" }),
      ).toBeEnabled();
      const savedBeforeRepositories = await page.request.get(
        `/api/admin/workspaces/${workspaceId}/plugins/code-truth`,
      );
      expect(
        (await savedBeforeRepositories.json()).settings.repositories,
      ).toHaveLength(0);
      await expect(
        card.getByRole("heading", { name: "deepx-web", exact: true }),
      ).toBeVisible();
      await card
        .getByRole("button", { name: "Save Code Truth", exact: true })
        .click();
      await expect(page.locator(".toast").getByRole("status")).toContainText(
        "Code Truth saved",
      );
      await page.reload();
      await expect(
        card.getByRole("heading", { name: "deepx-web", exact: true }),
      ).toBeVisible();
      await expect(
        card.getByText("testnet → testnet-develop", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByRole("switch", { name: "Enable Code Truth", exact: true }),
      ).toBeChecked();
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
      await expect(page.locator(".toast").getByRole("status")).toHaveText(
        "Index status refreshed.",
      );
      await expect(card.getByText("Index status refreshed.")).toHaveCount(0);
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
      await card
        .getByRole("switch", { name: "Enable Code Truth", exact: true })
        .click();
      await card
        .getByRole("button", { name: "Save Code Truth", exact: true })
        .click();
      await expect(page.locator(".toast").getByRole("status")).toContainText(
        "Code Truth saved",
      );
      await page.reload();
      await expect(card.getByText("No repositories configured.")).toBeVisible();
    });
    test("creating and switching workspaces isolates plugins, Code Truth and unsaved drafts", async ({
      page,
    }) => {
      await page.goto("/admin/plugins");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const picker = page.getByRole("button", {
        name: "Workspace",
        exact: true,
      });
      await picker.focus();
      await picker.press("ArrowDown");
      const menu = page.getByRole("menu", { name: "Workspaces" });
      await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(picker).toBeFocused();
      await picker.click();
      const newWorkspace = menu.getByRole("menuitem", {
        name: "New workspace",
        exact: true,
      });
      await expect(newWorkspace).toHaveText("New");
      await newWorkspace.click();
      await expect(page).toHaveURL(/\/setup\?new=1&step=workspace/);
      await expect(
        page.getByRole("heading", { name: "Set up a new workspace" }),
      ).toBeVisible();
      await expect(page.getByLabel("Workspace draft")).toHaveCount(0);
      await page.getByLabel("Workspace name").fill("Independent team");
      await page.getByLabel("Timezone").selectOption("America/New_York");
      await page.getByRole("button", { name: "Continue to Telegram" }).click();
      await expect(
        page.getByRole("heading", { name: "Connect Telegram" }),
      ).toBeVisible();
      const secondId = new URL(page.url()).searchParams.get("workspace");
      if (!secondId) throw Error("missing created workspace ID");
      await expect(page).not.toHaveURL(/new=1/);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Connect Telegram" }),
      ).toBeVisible();
      await page
        .getByRole("navigation", { name: "Setup steps" })
        .getByRole("button", { name: /GitHub App/ })
        .click();
      await page.getByRole("button", { name: "Finish later in admin" }).click();
      await expect(page).toHaveURL(
        new RegExp(`/admin\\?workspace=${secondId}`),
      );
      await page.goto(`/admin/plugins?workspace=${secondId}`);
      await expect(picker).toContainText("Independent team");
      await picker.click();
      const second = menu.getByRole("menuitemradio", {
        name: "Independent team",
      });
      await expect(second).toHaveAttribute("data-workspace-id", secondId);
      await expect(second).toHaveAttribute("aria-checked", "true");
      await picker.click();
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
      const pool = database(fixture.url);
      try {
        const store = new Store(pool);
        const created = await store.read(secondId);
        expect(created.settings.timezone).toBe("America/New_York");
        await store.change(secondId, (w) => enrollOwner(w, "101"));
      } finally {
        await pool.end();
      }
      await chooseWorkspace(page, workspaceId);
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
      await page.getByRole("link", { name: "Open independent-plugin" }).click();
      const plugin = page.getByRole("region", {
        name: "Plugin independent-plugin",
      });
      await expect(
        plugin.getByText("1", { exact: true }).first(),
      ).toBeVisible();
      const truth = page.getByRole("region", {
        name: "Predefined Code Truth extension",
      });
      await page.goto(`/admin/plugins/code-truth?workspace=${workspaceId}`);
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
      await expect(page.locator(".toast").getByRole("status")).toContainText(
        "Code Truth saved",
      );
      await page.goto(
        `/admin/plugins/file/independent-plugin?workspace=${workspaceId}`,
      );
      await plugin
        .getByRole("button", { name: "Edit independent-plugin" })
        .click();
      await page.getByLabel("Plugin version").fill("unsaved-draft");
      // Navigation to another workspace must also discard a mounted modal draft.
      await page.goto(`/admin/plugins?workspace=${secondId}`);
      await expect(page.getByLabel("Plugin version")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Open independent-plugin" }),
      ).toHaveCount(0);
      await page.goto(`/admin/plugins/code-truth?workspace=${secondId}`);
      await expect(
        truth.getByText("No repositories configured."),
      ).toBeVisible();
      await page.goto(`/admin/plugins?workspace=${secondId}`);
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
      await page.getByRole("link", { name: "Open independent-plugin" }).click();
      await expect(
        plugin.getByText("2", { exact: true }).first(),
      ).toBeVisible();
      await chooseWorkspace(page, workspaceId);
      await expect(
        plugin.getByText("1", { exact: true }).first(),
      ).toBeVisible();
      await page.goto(`/admin/plugins/code-truth?workspace=${workspaceId}`);
      await expect(
        truth.getByRole("heading", { name: "isolated-repo", exact: true }),
      ).toBeVisible();
      await chooseWorkspace(page, secondId);
      await expect(
        truth.getByText("No repositories configured."),
      ).toBeVisible();
      await page.goto(
        `/admin/plugins/file/independent-plugin?workspace=${secondId}`,
      );
      await expect(
        plugin.getByText("2", { exact: true }).first(),
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
      await chooseWorkspace(page, workspaceId);
      await page.getByRole("link", { name: "Plugins", exact: true }).click();
      const manage = page.getByRole("dialog", { name: "Manage GitHub" });
      await expect(
        page.getByRole("region", { name: "GitHub connection" }),
      ).toHaveCount(0);
      await expect(manage).toHaveCount(0);
      await page
        .getByRole("navigation")
        .getByRole("link", { name: "Overview", exact: true })
        .click();
      const overviewUrl = page.url();
      await page
        .getByRole("region", { name: "GitHub" })
        .getByRole("button", { name: "Manage GitHub" })
        .click();
      await expect(page).toHaveURL(overviewUrl);
      await expect(manage).toBeVisible();
      await expect(
        manage.getByRole("button", { name: "Create GitHub App" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(manage).toHaveCount(0);
      await expect(page).toHaveURL(overviewUrl);
      await page
        .getByRole("region", { name: "GitHub" })
        .getByRole("button", { name: "Manage GitHub" })
        .click();
      await expect(
        manage.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toHaveCount(0);
      await manage
        .getByRole("button", { name: "Create GitHub App", exact: true })
        .click();
      await expect(
        page
          .getByRole("dialog", { name: "Create GitHub App", exact: true })
          .getByRole("combobox", { name: "App owner", exact: true }),
      ).toHaveValue("personal");
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
      await page
        .getByRole("dialog", { name: "Create GitHub App", exact: true })
        .getByRole("combobox", { name: "App owner", exact: true })
        .selectOption("personal");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/github-create-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.route(
        "https://github.com/settings/apps/new**",
        async (route) => {
          expect(route.request().method()).toBe("POST");
          const manifest = JSON.parse(
            new URLSearchParams(route.request().postData() ?? "").get(
              "manifest",
            ) ?? "{}",
          );
          expect(manifest.public).toBe(false);
          expect(manifest.default_permissions).toEqual({
            contents: "write",
            metadata: "read",
            issues: "write",
            pull_requests: "write",
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
      await expect(manage).toBeVisible();
      await expect(
        manage.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeEnabled();
      await expect(
        manage.getByText("deepx-fixture", { exact: true }),
      ).toBeVisible();
      await expect(
        manage.getByRole("link", { name: "Install or update the GitHub App" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/apps/deepx-fixture/installations/new",
      );
      await expect(
        manage.getByRole("button", { name: "Create GitHub App", exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        manage.getByRole("button", { name: "Connect GitHub", exact: true }),
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
      await chooseWorkspace(page, workspaceId);
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
      const manage = page.getByRole("dialog", { name: "Manage GitHub" });
      await page
        .getByRole("navigation")
        .getByRole("link", { name: "Overview", exact: true })
        .click();
      await page
        .getByRole("region", { name: "GitHub" })
        .getByRole("button", { name: "Manage GitHub" })
        .click();
      await manage
        .getByRole("button", { name: "Connect GitHub", exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}`));
      await expect(
        manage.getByText("Choose repositories for this workspace"),
      ).toBeVisible();
      await manage.getByLabel("GitHub installation").selectOption("501");
      await manage.getByLabel("example/workspace", { exact: true }).check();
      await manage
        .getByRole("button", { name: "Connect selected repositories" })
        .click();
      await expect(
        manage.getByText("Connected", { exact: true }),
      ).toBeVisible();
      await expect(
        manage.getByText("example/workspace", { exact: true }),
      ).toBeVisible();
      await expect(
        manage.getByRole("link", { name: "Open example/workspace on GitHub" }),
      ).toHaveAttribute("href", "https://github.com/example/workspace");
      await expect(
        manage.getByRole("link", { name: "Open example/workspace on GitHub" }),
      ).toHaveAttribute("target", "_blank");
      await expect(manage.locator(".github-repositories")).toHaveCSS(
        "display",
        "flex",
      );
      await expect(
        manage.getByText("example/second", { exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        manage.getByText("Connected", { exact: true }),
      ).toBeVisible();
      await manage.getByRole("button", { name: "Close Manage GitHub" }).click();
      await expect(manage).toHaveCount(0);
      await expect(page).not.toHaveURL(/github=authorized/);
      await page
        .getByRole("navigation")
        .getByRole("link", { name: "Overview", exact: true })
        .click();
      const githubCard = page.getByRole("region", { name: "GitHub" });
      await expect(
        githubCard.getByText("Connected", { exact: true }),
      ).toBeVisible();
      const picker = page.getByRole("button", {
        name: "Workspace",
        exact: true,
      });
      await picker.click();
      const other = await page
        .getByRole("menuitemradio", { name: "Independent team" })
        .getAttribute("data-workspace-id");
      await picker.click();
      if (!other) throw Error("missing sibling workspace");
      await chooseWorkspace(page, other);
      await expect(
        githubCard.getByText("Not connected", { exact: true }),
      ).toBeVisible();
      await chooseWorkspace(page, workspaceId);
      const coding = page.getByRole("region", { name: "Codex implementation" });
      await page.goto(`/admin/plugins/codex?workspace=${workspaceId}`);
      const configuration = coding.getByRole("region", {
        name: "Codex configuration",
      });
      const repositories = coding.getByRole("region", {
        name: "Coding repositories",
      });
      const tasks = coding.getByRole("region", { name: "Coding tasks" });
      await expect(configuration).toBeVisible();
      await expect(repositories).toBeVisible();
      await expect(tasks).toBeVisible();
      await expect(configuration.getByText("Disabled")).toBeVisible();
      await expect(
        configuration.getByText("Local containers", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".plugin-back-link svg")).toBeVisible();
      await repositories
        .getByRole("button", { name: "Add coding repository" })
        .click();
      const codingDialog = page.getByRole("dialog", {
        name: "Add coding repository",
      });
      await expect(codingDialog.getByText("@maintainer")).toBeVisible();
      await expect(codingDialog.getByText("Telegram ID 101")).toBeVisible();
      await expect(codingDialog.locator(".coding-maintainers")).toHaveCSS(
        "border-top-width",
        "0px",
      );
      await expect(codingDialog.getByLabel("Workflow filename")).toHaveCount(0);
      await codingDialog
        .getByRole("combobox", { name: "Repository", exact: true })
        .fill("example/workspace");
      await codingDialog
        .getByRole("option", { name: "example/workspace", exact: true })
        .click();
      await codingDialog
        .getByLabel("Development / base branch")
        .fill("develop");
      await expect(
        codingDialog.getByLabel("Local setup command (optional)"),
      ).toHaveCount(0);
      await expect(codingDialog.getByLabel("Local check command")).toHaveCount(
        0,
      );
      await codingDialog.screenshot({
        path: "test-results/coding-add-desktop.png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await codingDialog.screenshot({
        path: "test-results/coding-add-mobile.png",
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await codingDialog
        .getByRole("button", { name: "Save coding repository" })
        .click();
      await expect(codingDialog.getByRole("alert")).toHaveText(
        "Select at least one maintainer.",
      );
      await codingDialog.getByRole("checkbox", { name: /@maintainer/ }).check();
      await expect(codingDialog.getByLabel("Execution policy")).toHaveValue(
        "reviewed",
      );
      await codingDialog.getByLabel("Execution policy").selectOption("direct");
      await codingDialog
        .getByLabel("Publish verified implementations as draft PRs by default")
        .check();
      await codingDialog.getByLabel("Maximum execution cycles").fill("6");
      await codingDialog
        .getByLabel("Automatic check repairs per cycle")
        .fill("1");
      await codingDialog
        .getByLabel("Active execution time (seconds)")
        .fill("1800");
      await codingDialog.getByLabel("Codex token limit").fill("150000");
      await codingDialog
        .getByRole("button", { name: "Save coding repository" })
        .click();
      await expect(codingDialog).toHaveCount(0);
      await page
        .getByRole("switch", { name: "Enable Codex implementation" })
        .click();
      await expect(configuration.getByText("Enabled")).toBeVisible();
      const configDialog = page.getByRole("dialog", {
        name: "Edit Codex configuration",
      });
      await page.reload();
      await expect(configuration.getByText("Enabled")).toBeVisible();
      await expect(configuration.getByText("1", { exact: true })).toBeVisible();
      await expect(coding.getByText(/Maintainers: 101/)).toBeVisible();
      await coding
        .getByRole("button", { name: "Edit coding repository 7001" })
        .click();
      const codingEdit = page.getByRole("dialog", {
        name: "Edit coding repository",
      });
      await expect(
        codingEdit.getByLabel("Local setup command (optional)"),
      ).toHaveCount(0);
      await expect(codingEdit.getByLabel("Local check command")).toHaveCount(0);
      await expect(codingEdit.getByLabel("Execution policy")).toHaveValue(
        "direct",
      );
      await expect(
        codingEdit.getByLabel(
          "Publish verified implementations as draft PRs by default",
        ),
      ).toBeChecked();
      await expect(
        codingEdit.getByLabel("Maximum execution cycles"),
      ).toHaveValue("6");
      await expect(
        codingEdit.getByLabel("Automatic check repairs per cycle"),
      ).toHaveValue("1");
      await expect(
        codingEdit.getByLabel("Active execution time (seconds)"),
      ).toHaveValue("1800");
      await expect(codingEdit.getByLabel("Codex token limit")).toHaveValue(
        "150000",
      );
      await codingEdit.screenshot({
        path: "test-results/coding-policy-desktop.png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await codingEdit.screenshot({
        path: "test-results/coding-policy-mobile.png",
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await codingEdit
        .getByLabel("Development / base branch")
        .fill("other-branch");
      await codingEdit
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(coding.getByText(/Base: develop/)).toBeVisible();
      await coding.screenshot({ path: "test-results/coding-desktop.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await coding.screenshot({ path: "test-results/coding-mobile.png" });
      await page
        .getByRole("switch", { name: "Enable Codex implementation" })
        .click();
      await expect(configuration.getByText("Disabled")).toBeVisible();
      await expect(coding.getByLabel("Execution backend")).toHaveCount(0);
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await configDialog
        .getByRole("textbox", { name: "Provider API key" })
        .fill("fake-panel-key");
      const [keyResponse] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/plugins/coding") &&
            r.request().method() === "PUT",
        ),
        configDialog
          .getByRole("button", { name: "Save configuration" })
          .click(),
      ]);
      expect(keyResponse.status()).toBe(200);
      expect(await keyResponse.text()).not.toContain("fake-panel-key");
      await expect(configDialog).toHaveCount(0);
      await expect(
        configuration.getByText("Workspace key configured", { exact: true }),
      ).toBeVisible();
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
      const keyPool = database(fixture.url);
      try {
        const saved = await new Store(keyPool).read(workspaceId);
        const ciphertext = saved.coding?.providerApiKey;
        if (!ciphertext) throw Error("Missing encrypted provider key");
        expect(JSON.stringify(saved)).not.toContain("fake-panel-key");
        expect(
          decrypt(
            "ab".repeat(32),
            `coding-provider:${workspaceId}`,
            ciphertext,
          ),
        ).toBe("fake-panel-key");
        expect(await keyResponse.text()).not.toContain(ciphertext);
      } finally {
        await keyPool.end();
      }
      await page.reload();
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await expect(
        configDialog.getByRole("textbox", { name: "Provider API key" }),
      ).toHaveValue("");
      await configDialog
        .getByRole("textbox", { name: "Provider API key" })
        .fill("fake-replacement-key");
      await configDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await expect(configDialog).toHaveCount(0);
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await expect(
        configDialog.getByRole("textbox", { name: "Provider API key" }),
      ).toHaveValue("");
      await configDialog
        .getByRole("textbox", { name: "Provider API key" })
        .fill("discard-this-draft");
      await configDialog
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await expect(
        configDialog.getByRole("textbox", { name: "Provider API key" }),
      ).toHaveValue("");
      await configDialog.getByLabel("Remove saved key").check();
      await configDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await expect(
        configuration.getByText("No workspace key", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        configuration.getByText("No workspace key", { exact: true }),
      ).toBeVisible();
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await configDialog
        .getByLabel("Sign-in method")
        .selectOption("device_code");
      await configDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await expect(
        configuration.getByText("ChatGPT device code"),
      ).toBeVisible();
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await expect(
        configDialog.getByRole("button", { name: "Sign in with device code" }),
      ).toBeDisabled();
      await configDialog.getByRole("button", { name: "Cancel" }).click();
      await page.reload();
      await configuration
        .getByRole("button", { name: "Edit Codex configuration" })
        .click();
      await expect(configDialog.getByLabel("Sign-in method")).toHaveValue(
        "device_code",
      );
      await configDialog
        .getByLabel("Sign-in method")
        .selectOption("provider_key");
      await configDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await expect(
        configuration.getByText("Custom provider API key"),
      ).toBeVisible();

      await expect(
        page.getByRole("region", { name: "GitHub connection" }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/github-mobile.png",
        fullPage: true,
      });
    });
    test("setup welcomes the user before entering the connected workspace", async ({
      page,
    }) => {
      await page.goto("/admin");
      await page.getByLabel("Username", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser test password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Workspace" }).click();
      const other = await page
        .getByRole("menuitemradio", { name: "Independent team" })
        .getAttribute("data-workspace-id");
      if (!other) throw Error("missing sibling workspace");
      await page.route(
        "https://github.com/login/oauth/authorize**",
        async (route) => {
          const url = new URL(route.request().url());
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
      await page.goto(`/setup?step=github&workspace=${other}`);
      await expect(
        page
          .getByRole("navigation", { name: "Setup steps" })
          .getByRole("button"),
      ).toHaveCount(3);
      await page.getByRole("button", { name: "Connect GitHub" }).click();
      const celebration = page.locator(".setup-celebration");
      await expect(
        celebration.getByRole("heading", { name: "Welcome to RepoDesk" }),
      ).toBeVisible();
      const getStarted = celebration.getByRole("button", {
        name: "Get started",
      });
      await expect(getStarted).toBeFocused();
      expect(Math.round((await celebration.boundingBox())?.width ?? 0)).toBe(
        page.viewportSize()?.width,
      );
      await expect(page.locator(".setup-confetti span")).toHaveCount(32);
      await page.waitForTimeout(300);
      await page.screenshot({ path: "test-results/setup-confetti.png" });
      await page.waitForTimeout(1900);
      await expect(page).toHaveURL(/\/setup\?/);
      await getStarted.click();
      await expect(page).toHaveURL(new RegExp(`/admin\\?workspace=${other}$`));
      const githubCard = page.getByRole("region", { name: "GitHub" });
      await expect(githubCard).toContainText("Connected");
      await expect(githubCard).toContainText("13 repositories");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({
        path: "test-results/overview-connections-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      const connection = await page.request.get(
        `/api/admin/workspaces/${other}/github`,
      );
      expect((await connection.json()).connection.repositories).toHaveLength(
        13,
      );
      const overviewUrl = page.url();
      await githubCard.getByRole("button", { name: "Manage GitHub" }).click();
      await expect(page).toHaveURL(overviewUrl);
      const manage = page.getByRole("dialog", { name: "Manage GitHub" });
      await expect(manage).toBeVisible();
      await page.screenshot({ path: "test-results/github-manage-desktop.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
      await page.screenshot({ path: "test-results/github-manage-mobile.png" });
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(
        page.getByRole("region", { name: "GitHub connection" }),
      ).toHaveCount(0);
      await expect(manage.locator(".github-repository")).toHaveCount(5);
      const more = manage.getByRole("button", { name: "8 more" });
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await more.click();
      await expect(manage.locator(".github-repository")).toHaveCount(13);
      await expect(
        manage.getByRole("link", { name: "Open example/repo-13 on GitHub" }),
      ).toBeVisible();
      const less = manage.getByRole("button", { name: "Show less" });
      await expect(less).toHaveAttribute("aria-expanded", "true");
      await less.click();
      await expect(manage.locator(".github-repository")).toHaveCount(5);
      await manage.getByRole("button", { name: "Close Manage GitHub" }).click();
      await expect(manage).toHaveCount(0);
      await expect(page).toHaveURL(overviewUrl);

      // Authorization without installation must not finish setup.
      await page.route(
        `**/api/admin/workspaces/${workspaceId}/github`,
        async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          await route.fulfill({
            json: {
              configured: true,
              canRegister: false,
              installUrl:
                "https://github.com/apps/deepx-fixture/installations/new",
              revision: 0,
              pending: true,
              installations: [],
            },
          });
        },
      );
      await page.goto(
        `/setup?step=github&workspace=${workspaceId}&github=authorized`,
      );
      await expect(
        page.getByText(
          "GitHub account authorized. Install the App to grant repository access.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Connect GitHub" }),
      ).toBeEnabled();
      await page.waitForTimeout(1900);
      await expect(page.locator(".setup-celebration")).toHaveCount(0);
      await expect(page).toHaveURL(/\/setup\?/);
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
        ["plugins/code-truth", "Add repository", "Add repository"],
      ]) {
        await page.goto(`/admin/${path}`);
        const trigger = page.getByRole("button", { name: label, exact: true });
        if (
          path &&
          ["members", "skills", "plugins", "plugins/code-truth"].includes(
            path,
          ) &&
          label !== "Import skill"
        )
          await expect(trigger).toHaveText("New");
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
      await expect(memberDialog.getByRole("alert")).toContainText(
        "version_conflict",
      );
      await expect(
        page.getByLabel("Telegram user ID", { exact: true }),
      ).toHaveValue("909090");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.unroute("**/api/admin/workspaces/*/members");
      // Nested network cancellation preserves the repository draft and its focus.
      await page.goto("/admin/plugins/code-truth");
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
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
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
        await chooseWorkspace(page, workspaceId);
        await page.goto(`/admin/members?workspace=${workspaceId}`);
        const requests = page.getByRole("region", {
          name: "Access requests",
          exact: true,
        });
        await expect(
          requests.getByRole("heading", { name: "Access requests (2)" }),
        ).toBeVisible();
        const accessLink = requests.getByText(
          new RegExp(`start=access_${workspaceId}`),
        );
        await expect(accessLink).toBeVisible();
        await expect(requests.getByRole("textbox")).toHaveCount(0);
        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"]);
        const copyButton = requests.getByRole("button", {
          name: "Copy access link",
        });
        const copyIcon = await copyButton.locator("svg").innerHTML();
        await copyButton.click();
        const copiedButton = requests.getByRole("button", {
          name: "Copied access link",
        });
        await expect(copiedButton).toBeVisible();
        expect(await copiedButton.locator("svg").innerHTML()).not.toBe(
          copyIcon,
        );
        await expect(requests.getByText("Link copied.")).toHaveCount(0);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          await accessLink.textContent(),
        );
        await expect(copyButton).toBeVisible();
        expect(await copyButton.locator("svg").innerHTML()).toBe(copyIcon);
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
        await expect(page.locator(".toast").getByRole("status")).toContainText(
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
      const fixture = JSON.parse(await readFile(browserDbPath, "utf8"));
      const pool = database(fixture.url);
      const store = new Store(pool);
      try {
        await store.change(workspaceId, (w) => {
          w.members.push(
            {
              id: "810",
              role: "member",
              active: true,
              github: {
                id: 42,
                login: "linked-github-member",
                status: "connected",
                connectionRevision: 1,
                syncedAt: new Date().toISOString(),
                repositories: [
                  {
                    id: 7001,
                    full_name: "example/workspace",
                    permissions: { pull: true, push: false, admin: false },
                  },
                ],
              },
            },
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
        await expect(
          table.getByRole("columnheader", { name: "GitHub", exact: true }),
        ).toBeVisible();
        await expect(row("810")).toContainText("linked-github-member");
        await expect(row("810")).toContainText("example/workspace · Read");
        await expect(row("810")).toContainText("Synced");
        await expect(row("808")).toContainText("Not linked");
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
        await search.fill("linked-github-member");
        await expect(table.getByRole("row")).toHaveCount(2);
        await expect(row("810")).toBeVisible();
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
        await expect(policy.getByRole("alert")).toContainText(
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
