import { expect, type Route, test } from "@playwright/test";
import type { NowledgePage } from "../../src/nowledge-mem/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/nowledge-mem`;
for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`Nowledge Mem summary, modal, discovery and recovery ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      let saved: NowledgePage = {
        revision: 1,
        settings: {
          enabled: false,
          apiUrl: "",
          memberId: "",
          spaceId: "",
          spaceName: "",
        },
        credentialConfigured: false,
        members: [{ id: "101", name: "Alice" }],
      };
      let load: Route | undefined,
        pending: Route | undefined,
        failLoad = true,
        writes = 0;
      const pendingRoute = (): Route => {
        if (!pending) throw Error("No pending fixture request");
        return pending;
      };
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === endpoint) {
          if (route.request().method() === "GET") {
            load = route;
            return;
          }
          writes++;
          pending = route;
          return;
        }
        if (path === `${endpoint}/spaces`) {
          const body = route.request().postDataJSON();
          expect(body.apiKey).toBe("nmem_test_secret");
          await route.fulfill({
            json: [{ id: "private-space", name: "Personal knowledge" }],
          });
          return;
        }
        await route.fulfill({
          json:
            path === "/api/setup/status"
              ? { initialized: true }
              : path === "/api/admin/auth/session"
                ? {
                    admin: {
                      id: "operator",
                      username: "fixture",
                      operator: true,
                    },
                    csrf: "test",
                  }
                : path === "/api/admin/workspaces"
                  ? [{ id: workspaceId, name: "Memory fixture" }]
                  : { settings: { enabled: false } },
        });
      });
      await page.goto(`/admin/plugins/nowledge-mem?workspace=${workspaceId}`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect.poll(() => !!load).toBe(true);
      const config = page.getByRole("region", {
        name: "Nowledge Mem configuration",
      });
      await expect(
        page.getByRole("heading", { name: "Nowledge Mem", exact: true }),
      ).toBeVisible();
      await expect(
        config.getByRole("heading", { name: "Connection", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Edit Nowledge Mem", exact: true }),
      ).toBeDisabled();
      await page.screenshot({
        path: test.info().outputPath("loading.png"),
        fullPage: true,
      });
      if (failLoad) {
        await load?.fulfill({ status: 503, json: { error: "unavailable" } });
        load = undefined;
        failLoad = false;
        await expect(page.getByRole("alert")).toContainText("Could not load");
        await page.screenshot({
          path: test.info().outputPath("load-error.png"),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Reload settings" }).click();
        await expect.poll(() => !!load).toBe(true);
      }
      await load?.fulfill({ json: saved });
      load = undefined;
      const toggle = page.getByRole("switch", { name: "Enable Nowledge Mem" });
      await expect(toggle).toBeDisabled();
      await expect(config.locator("input, select, textarea")).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: test.info().outputPath("empty.png"),
        fullPage: true,
      });
      const edit = page.getByRole("button", {
        name: "Edit Nowledge Mem",
        exact: true,
      });
      await edit.click();
      const dialog = page.getByRole("dialog", {
        name: "Edit Nowledge Mem",
        exact: true,
      });
      await dialog.getByLabel("Server URL").fill("https://mem.example.com");
      await dialog
        .getByRole("combobox", { name: "Member", exact: true })
        .click();
      await dialog.getByRole("option", { name: "Alice", exact: true }).click();
      await dialog
        .getByLabel("API key", { exact: true })
        .fill("nmem_test_secret");
      await dialog
        .getByRole("button", { name: "Find Spaces", exact: true })
        .click();
      await expect(
        dialog.getByRole("combobox", { name: "Space", exact: true }),
      ).toContainText("Personal knowledge");
      await page.screenshot({
        path: test.info().outputPath("editor.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => !!pending).toBe(true);
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("pending.png"),
        fullPage: true,
      });
      await pendingRoute().fulfill({
        status: 409,
        json: { error: "version_conflict" },
      });
      pending = undefined;
      await expect(dialog.getByRole("alert")).toContainText("another session");
      await expect(dialog.getByLabel("Server URL")).toHaveValue(
        "https://mem.example.com",
      );
      await page.screenshot({
        path: test.info().outputPath("save-error.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => !!pending).toBe(true);
      const body = pendingRoute().request().postDataJSON();
      expect(body.apiKey).toBe("nmem_test_secret");
      saved = {
        ...saved,
        revision: 2,
        settings: body.settings,
        credentialConfigured: true,
      };
      await pendingRoute().fulfill({ json: saved });
      pending = undefined;
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
      await expect(config).toContainText("Personal knowledge");
      await expect(config).toContainText("Saved securely");
      await expect(page.locator("body")).not.toContainText("nmem_test_secret");
      await expect(config.locator("input, select, textarea")).toHaveCount(0);
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect.poll(() => !!pending).toBe(true);
      expect(pendingRoute().request().postDataJSON()).toEqual({
        revision: 2,
        settings: { ...saved.settings, enabled: true },
      });
      saved = {
        ...saved,
        revision: 3,
        settings: { ...saved.settings, enabled: true },
      };
      await pendingRoute().fulfill({ json: saved });
      pending = undefined;
      await expect(toggle).toBeChecked();
      await page.screenshot({
        path: test.info().outputPath("saved.png"),
        fullPage: true,
      });
      await edit.click();
      await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue(
        "",
      );
      await dialog
        .getByLabel("Server URL")
        .fill("https://discarded.example.com");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(config).toContainText("https://mem.example.com");
      await expect(edit).toBeFocused();
      expect(writes).toBe(3);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    });
  }
}
