import { expect, type Page, type Route, test } from "@playwright/test";
import type { SiteView } from "../../src/admin/site.ts";

const origin = `https://${"long-domain-".repeat(5)}app.example.com`;
const site: SiteView = {
  revision: 1,
  domain: new URL(origin).hostname,
  origin,
  fallbackOrigin: "http://127.0.0.1:3107",
  githubCallbackUrl: `${origin}/api/admin/github/callback`,
  githubSetupUrl: `${origin}/api/admin/github/app/callback`,
  telegramWebhookUrl: `${origin}/telegram/webhook`,
  telegramTransport: "polling",
  webhookReady: false,
};

async function openSite(page: Page) {
  const held: Route[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/operator/site") {
      held.push(route);
      return;
    }
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "fixture",
            }
          : path === "/api/admin/workspaces"
            ? []
            : {};
    await route.fulfill({ json });
  });
  await page.goto("/admin/site");
  await expect.poll(() => held.length).toBe(1);
  return held;
}

for (const width of [1280, 390]) {
  test(`connected service URLs copy and wrap in both themes at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const held = await openSite(page);
    const card = page.getByRole("region", {
      name: "Update connected services",
    });
    await expect(card).toHaveAttribute("aria-busy", "true");
    for (const label of ["Homepage URL", "Callback URL", "Setup URL"]) {
      await expect(card.getByText(label, { exact: true })).toBeVisible();
      await expect(
        card.getByRole("button", { name: `Copy ${label}` }),
      ).toBeDisabled();
    }
    await expect(
      card.getByText("No webhook update", { exact: false }),
    ).toHaveCount(0);
    await held[0]?.fulfill({ json: site });
    await expect(card).toHaveAttribute("aria-busy", "false");
    await expect(
      card.getByText("Telegram uses polling. No webhook update is needed."),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Register Telegram webhook" }),
    ).toHaveCount(0);
    await expect(
      card.getByText("Changing domains cancels pending GitHub connections."),
    ).toBeVisible();

    for (const [label, value] of [
      ["Homepage URL", site.origin],
      ["Callback URL", site.githubCallbackUrl],
      ["Setup URL", site.githubSetupUrl],
    ]) {
      const copy = card.getByRole("button", {
        name: `Copy ${label}`,
        exact: true,
      });
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect(
        card.getByRole("button", { name: `Copied ${label}` }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        value,
      );
      await expect(copy).toBeEnabled();
    }

    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      for (const row of await card.locator(".service-url-value").all()) {
        expect(
          await row.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
      }
      await card.screenshot({
        path: testInfo.outputPath(`connected-services-${theme}-${width}.png`),
      });
    }

    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new Error("Clipboard denied");
        },
      });
    });
    await card.getByRole("button", { name: "Copy Homepage URL" }).click();
    await expect(card.getByRole("alert")).toContainText(
      "Select the URL to copy it manually.",
    );
    await expect(card.getByText(site.origin, { exact: true })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Copy Homepage URL" }),
    ).toBeEnabled();
  });
}

test("failed service details can retry and webhook registration remains explicit", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const held = await openSite(page);
  const card = page.getByRole("region", { name: "Update connected services" });
  await held[0]?.fulfill({ status: 500, json: { error: "unavailable" } });
  await expect(card).toHaveAttribute("aria-busy", "false");
  await expect(card.getByText("Connection details unavailable.")).toBeVisible();
  await expect(card.locator(".skeleton")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Copy Homepage URL" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => held.length).toBe(2);
  await held[1]?.fulfill({ json: { ...site, telegramTransport: "webhook" } });
  await expect(card.getByText("Status: Registration required")).toBeVisible();
  await expect(
    card.getByText("After the HTTPS address is reachable", { exact: false }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Copy Telegram webhook" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    site.telegramWebhookUrl,
  );

  let registrations = 0;
  let registration: Route | undefined;
  await page.route("**/api/setup/webhook", (route) => {
    registrations++;
    registration = route;
  });
  expect(registrations).toBe(0);
  await card.getByRole("button", { name: "Register Telegram webhook" }).click();
  await expect.poll(() => registrations).toBe(1);
  expect(registration?.request().method()).toBe("POST");
  await expect(card.getByRole("button", { name: "Working…" })).toBeDisabled();
  await registration?.fulfill({ json: {} });
  await expect.poll(() => held.length).toBe(3);
  await held[2]?.fulfill({
    json: { ...site, telegramTransport: "webhook", webhookReady: true },
  });
  await expect(
    card.getByText("Status: Registered", { exact: true }),
  ).toBeVisible();
});
