import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { passwordHash } from "../../src/setup/credentials.ts";
import {
  installedVersion,
  type UpdateView,
} from "../../src/updates/releases.ts";

const nextTag = `v${installedVersion.split(".").slice(0, 2).join(".")}.${Number(installedVersion.split(".")[2]) + 1}`;
const available: UpdateView = {
  currentVersion: installedVersion,
  repository: "stonega/repodesk",
  available: true,
  configured: true,
  updaterReady: true,
  release: {
    id: 42,
    tag: nextTag,
    name: `RepoDesk ${nextTag}`,
    notes:
      "## Improvements\n- Check GitHub releases automatically.\n- Show changelogs before updating.\n\n## Upgrade notes\nDatabase migrations run after a backup.\n\n<img src=x onerror=alert(1)>\n" +
      "A long release-note line ".repeat(20),
    publishedAt: "2026-10-09T00:00:00Z",
    url: `https://github.com/stonega/repodesk/releases/tag/${nextTag}`,
    commit: "a".repeat(40),
    fingerprint: "b".repeat(64),
  },
};
async function signIn(page: Page, port: string, operator = true) {
  const fixture = JSON.parse(
    await readFile(join(tmpdir(), `repodesk-browser-${port}-db.json`), "utf8"),
  );
  const pool = database(fixture.url);
  const username = `updates_${randomUUID().slice(0, 8)}`,
    password = "update browser password";
  try {
    await pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,$4)",
      [randomUUID(), username, await passwordHash(password), operator],
    );
    await pool.query("UPDATE deployment SET claimed=true WHERE id=true");
  } finally {
    await pool.end();
  }
  await page.goto("/admin");
  await expect(
    page.getByRole("button", { name: /Update available/ }),
  ).toHaveCount(0);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
test("compact update indicator keeps its tap target and keyboard access in both themes", async ({
  page,
}, testInfo) => {
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({ json: available }),
  );
  await signIn(page, new URL(String(testInfo.project.use.baseURL)).port);
  await page.getByRole("link", { name: "Operations", exact: true }).click();
  const indicator = page.getByRole("button", {
    name: `Update available: ${nextTag}`,
  });
  const modal = page.getByRole("dialog", { name: "Update RepoDesk" });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page
        .getByRole("heading", { name: "Operations", exact: true })
        .click();
      await expect(indicator).toBeVisible();
      const size = await indicator.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const glyph = button.querySelector("svg")?.getBoundingClientRect();
        const circle = getComputedStyle(button, "::before");
        const dot = getComputedStyle(button, "::after");
        return {
          target: [bounds.width, bounds.height],
          glyph: [glyph?.width, glyph?.height],
          circle: [circle.width, circle.height],
          dot: [dot.width, dot.height],
          border: getComputedStyle(button).borderWidth,
        };
      });
      expect(size).toEqual({
        target: [44, 44],
        glyph: [16, 16],
        circle: ["28px", "28px"],
        dot: ["5px", "5px"],
        border: "0px",
      });
      await page.screenshot({
        path: testInfo.outputPath(`update-indicator-${width}-${theme}.png`),
      });
      // The transparent padding remains clickable outside the smaller circle.
      await indicator.click({ position: { x: 22, y: 4 } });
      await expect(modal).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(indicator).toBeFocused();
      await expect(indicator).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(modal).toBeVisible();
      await page.keyboard.press("Escape");
    }
  }
});
test("version indicator opens release notes; pending update is locked and queues once", async ({
  page,
}, testInfo) => {
  let view = structuredClone(available),
    posts = 0;
  let finish: (() => void) | undefined;
  let checking = false;
  let completeCheck: (() => void) | undefined;
  const checked = new Promise<void>((resolve) => {
    completeCheck = resolve;
  });
  await page.route("**/api/admin/updates", async (route) => {
    checking = true;
    await checked;
    await route.fulfill({ json: view });
  });
  await page.route("**/api/admin/operator/updates", async (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({
      releaseId: 42,
      fingerprint: "b".repeat(64),
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    view = {
      ...view,
      attempt: {
        state: "running",
      },
    };
    await route.fulfill({ json: view });
  });
  await signIn(page, new URL(String(testInfo.project.use.baseURL)).port);
  const indicator = page.getByRole("button", {
    name: `Update available: ${nextTag}`,
  });
  await expect.poll(() => checking).toBe(true);
  await expect(page.locator(".app-version")).toContainText(
    `v${installedVersion}`,
  );
  await expect(indicator).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("update-loading-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("update-loading-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  completeCheck?.();
  await expect(indicator).toBeVisible();
  const footer = page.locator(".app-version");
  await expect(footer).toContainText(`v${installedVersion}`);
  await expect(footer.locator("#app-update button")).toHaveCount(1);
  await indicator.click();
  const modal = page.getByRole("dialog", { name: "Update RepoDesk" });
  await expect(
    modal.getByRole("region", { name: "Changelog", exact: true }),
  ).toContainText("Show changelogs");
  await expect(
    modal.getByRole("region", { name: "Update notes", exact: true }),
  ).toContainText("backs up the database");
  await expect(modal.locator("img")).toHaveCount(0);
  await expect(modal.locator(".modal-actions button")).toHaveText([
    "Update now",
    "Cancel",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("update-desktop.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(indicator).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await indicator.click();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(modal).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("update-mobile.png"),
    fullPage: true,
  });
  await modal.getByRole("button", { name: "Update now", exact: true }).click();
  await expect(modal).toHaveAttribute("aria-busy", "true");
  await expect(
    modal.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("update-pending-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({
    path: testInfo.outputPath("update-pending-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  finish?.();
  await expect(modal).toContainText("Update queued or running");
  await expect(
    modal.getByRole("button", { name: "Update now", exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await indicator.click();
  await expect(modal).toContainText("Update queued or running");
});
test("failure retains notes; empty changelog and missing configuration are clear", async ({
  page,
}, testInfo) => {
  let view = structuredClone(available);
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({ json: view }),
  );
  await page.route("**/api/admin/operator/updates", (route) =>
    route.fulfill({ status: 409, json: { error: "release_changed" } }),
  );
  await signIn(page, new URL(String(testInfo.project.use.baseURL)).port);
  await page.getByRole("button", { name: /Update available/ }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("button", { name: "Update now", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("release changed");
  await expect(modal).toContainText("Show changelogs");
  await expect(
    modal.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("update-error-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("update-error-mobile.png"),
    fullPage: true,
  });
  view = {
    ...view,
    configured: false,
    release: view.release && { ...view.release, notes: "" },
  };
  await page.reload();
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(modal).toContainText("No changelog was included");
  await expect(modal).toContainText("One-click updates need");
  await expect(
    modal.getByRole("button", { name: "Update now", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("update-unconfigured-mobile.png"),
    fullPage: true,
  });
});
test("workspace accounts can review notes; current versions have no update indicator", async ({
  page,
}, testInfo) => {
  let view = { ...available, configured: false };
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({ json: view }),
  );
  await signIn(page, new URL(String(testInfo.project.use.baseURL)).port, false);
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Ask a deployment administrator",
  );
  await expect(
    page.getByRole("button", { name: "Update now", exact: true }),
  ).toHaveCount(0);
  view = { ...view, available: false };
  await page.reload();
  await expect(page.locator(".app-version")).toContainText(
    `v${installedVersion}`,
  );
  await expect(
    page.getByRole("button", { name: /Update available/ }),
  ).toHaveCount(0);
});

test("failed host jobs require an explicit retry; offline and unknown outcomes cannot start", async ({
  page,
}, testInfo) => {
  let view: UpdateView = {
    ...available,
    attempt: { state: "failed", error: "verification_failed" },
  };
  let posts = 0;
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({ json: view }),
  );
  await page.route("**/api/admin/operator/updates", async (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({
      releaseId: 42,
      fingerprint: "b".repeat(64),
      retry: true,
    });
    view = { ...view, attempt: { state: "queued" } };
    await route.fulfill({ json: view });
  });
  await signIn(page, new URL(String(testInfo.project.use.baseURL)).port);
  const modal = page.getByRole("dialog");
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(modal).toContainText("Verification has not passed");
  await modal
    .getByRole("button", { name: "Retry update", exact: true })
    .click();
  await expect(modal).toContainText("Update queued or running");
  expect(posts).toBe(1);
  view = {
    ...available,
    attempt: { state: "failed", error: "insufficient_disk_space" },
  };
  await page.reload();
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(modal).toContainText("not have enough free disk space");
  await expect(
    modal.getByRole("button", { name: "Retry update", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("update-disk-space-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("update-disk-space-mobile.png"),
    fullPage: true,
  });
  await modal
    .getByRole("button", { name: "Retry update", exact: true })
    .click();
  await expect(modal).toContainText("Update queued or running");
  expect(posts).toBe(2);
  view = { ...available, updaterReady: false };
  await page.reload();
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(
    modal.getByRole("button", { name: "Update now", exact: true }),
  ).toBeDisabled();
  await expect(modal).toContainText("host updater is offline");
  await page.screenshot({
    path: testInfo.outputPath("update-offline-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("update-offline-mobile.png"),
    fullPage: true,
  });
  view = { ...available, attempt: { state: "unknown" } };
  await page.reload();
  await page.getByRole("button", { name: /Update available/ }).click();
  await expect(modal).toContainText("outcome is unconfirmed");
  await expect(
    modal.getByRole("button", { name: /Update now|Retry update/ }),
  ).toHaveCount(0);
  expect(posts).toBe(2);
});
