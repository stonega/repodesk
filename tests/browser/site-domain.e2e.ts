import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { passwordHash } from "../../src/setup/credentials.ts";

test("custom domain setup preserves failed edits and fits desktop/mobile", async ({
  page,
}, testInfo) => {
  const fixture = JSON.parse(
    await readFile(
      join(
        tmpdir(),
        `repodesk-browser-${new URL(String(testInfo.project.use.baseURL)).port}-db.json`,
      ),
      "utf8",
    ),
  );
  const pool = database(fixture.url);
  const username = `domain_${randomUUID().slice(0, 8)}`;
  const password = "domain browser test password";
  try {
    await pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,true)",
      [randomUUID(), username, await passwordHash(password)],
    );
    await pool.query("UPDATE deployment SET claimed=true WHERE id=true");
    await page.goto("/admin/site");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("link", { name: "Site domain", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Site domain", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add custom domain" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(1);
    await dialog
      .getByLabel("Domain", { exact: true })
      .fill("https://admin.example.com/path");
    await dialog.getByRole("button", { name: "Save domain" }).click();
    await expect(dialog.getByRole("alert")).toContainText("hostname");
    await expect(dialog.getByLabel("Domain", { exact: true })).toHaveValue(
      "https://admin.example.com/path",
    );
    await dialog
      .getByLabel("Domain", { exact: true })
      .fill("admin.example.com");
    await page.screenshot({
      path: testInfo.outputPath("site-domain-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.screenshot({
      path: testInfo.outputPath("site-domain-mobile.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Save domain" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Custom domain configured.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("https://admin.example.com/api/admin/github/callback", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.getByRole("button", { name: "Edit domain" }).click();
    await dialog.getByRole("button", { name: "Use default address" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Using the deployment’s default address."),
    ).toBeVisible();
  } finally {
    await pool.end();
  }
});
