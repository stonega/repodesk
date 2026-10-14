import { expect, type Page, test } from "@playwright/test";
import { AccessLinks } from "../../src/workspaces/access-links.ts";
import { workspace } from "../fixtures.ts";

const startTime = new Date("2026-10-14T12:00:00Z");
async function fixture(page: Page) {
  const w = workspace();
  const links = new AccessLinks("ab".repeat(32));
  let calls = 0;
  let failure = false;
  let gate: Promise<void> | undefined;
  let joined = false;
  await page.clock.install({ time: startTime });
  await page.clock.pauseAt(new Date(startTime.getTime() + 1000));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/access-requests")) {
      calls++;
      await gate;
      if (failure) {
        await route.fulfill({
          status: 503,
          json: { error: "fixture_refresh_failed" },
        });
        return;
      }
      await route.fulfill({
        json: {
          version: joined ? 2 : 1,
          items: [],
          ...links.view(
            w,
            { id: "999", username: "fixture_bot" },
            new Date(startTime.getTime() + (calls - 1) * 10_000),
          ),
        },
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
                  id: w.operatorId,
                  username: "fixture",
                  operator: true,
                },
                csrf: "fixture",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: w.id, name: "Invitations" }]
              : path.endsWith("/members")
                ? {
                    version: joined ? 2 : 1,
                    total: joined ? 1 : 0,
                    items: joined
                      ? [
                          {
                            id: "404",
                            name: "Joined via invite",
                            role: "member",
                            active: true,
                          },
                        ]
                      : [],
                  }
                : {},
    });
  });
  return {
    open: () => page.goto(`/admin/members?workspace=${w.id}`),
    calls: () => calls,
    fail: (value: boolean) => {
      failure = value;
    },
    hold: (value?: Promise<void>) => {
      gate = value;
    },
    join: () => {
      joined = true;
    },
  };
}

for (const width of [1280, 390]) {
  test(`invite link counts down, refreshes, copies the current URL and updates members at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const requests = page.getByRole("region", {
      name: "Access requests",
      exact: true,
    });
    const timer = requests.getByRole("timer", { name: "Invite link refresh" });
    const link = requests.locator(".access-link-url");
    await expect(timer).toHaveText("New link in 10s");
    await expect(
      requests.getByText("No pending access requests."),
    ).toBeVisible();
    await expect(requests.getByRole("textbox")).toHaveCount(0);
    await expect(
      requests.getByRole("button", { name: /Refresh|Reload/ }),
    ).toHaveCount(0);
    await expect(requests).toContainText(
      "One Telegram account per link. No approval required.",
    );
    const first = await link.textContent();
    const initialCalls = f.calls();
    await page.clock.runFor(9000);
    await expect(timer).toHaveText("New link in 1s");
    expect(f.calls()).toBe(initialCalls);
    const pending = Promise.withResolvers<void>();
    f.hold(pending.promise);
    f.join();
    try {
      await page.clock.runFor(1000);
      await expect(timer).toHaveText("Updating link…");
      await expect(link).toHaveText(first ?? "");
      await expect(
        requests.getByRole("button", { name: "Copy access link" }),
      ).toBeEnabled();
      await page.screenshot({
        path: `test-results/access-link-pending-${width}.png`,
        fullPage: true,
      });
    } finally {
      pending.resolve();
    }
    await expect(link).not.toHaveText(first ?? "");
    await expect(timer).toHaveText("New link in 10s");
    await expect(
      page.getByRole("row").filter({ hasText: "Joined via invite" }),
    ).toBeVisible();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = requests.getByRole("button", {
      name: "Copy access link",
      exact: true,
    });
    await expect(copy).toHaveCSS("border-top-width", "0px");
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await copy.click();
    await expect(
      requests.getByRole("button", { name: "Copied access link" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      await link.textContent(),
    );
    await expect(requests.getByText("Link copied.")).toHaveCount(0);
    await page.clock.runFor(1000);
    await expect(copy).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/access-link-countdown-${width}.png`,
      fullPage: true,
    });
    const calls = f.calls();
    if (width < 768)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page.clock.runFor(30_000);
    expect(f.calls()).toBe(calls);
  });

  test(`invite refresh errors preserve the copied link and retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await f.open();
    const requests = page.getByRole("region", {
      name: "Access requests",
      exact: true,
    });
    const timer = requests.getByRole("timer");
    const link = requests.locator(".access-link-url");
    await expect(timer).toHaveText("New link in 10s");
    const first = await link.textContent();
    const initialCalls = f.calls();
    f.fail(true);
    await page.clock.runFor(10_000);
    await expect(page.locator(".toast").getByRole("alert")).toBeVisible();
    await expect(timer).toHaveText("Link refresh paused.");
    await expect(link).toHaveText(first ?? "");
    await page.clock.runFor(30_000);
    expect(f.calls()).toBe(initialCalls + 1);
    await page.screenshot({
      path: `test-results/access-link-error-${width}.png`,
      fullPage: true,
    });
    f.fail(false);
    await page.getByRole("button", { name: "Reload access requests" }).click();
    await expect(page.locator(".toast").getByRole("alert")).toHaveCount(0);
    await expect(timer).toHaveText("New link in 10s");
    await expect(link).not.toHaveText(first ?? "");
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () => Promise.reject(Error("denied")),
      });
    });
    await requests
      .getByRole("button", { name: "Copy access link", exact: true })
      .click();
    await expect(page.locator(".toast").getByRole("alert")).toContainText(
      "Could not copy the link",
    );
  });

  test(`invite initial loading retains the card and errors offer recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const pending = Promise.withResolvers<void>();
    f.hold(pending.promise);
    await f.open();
    const requests = page.getByRole("region", {
      name: "Access requests",
      exact: true,
    });
    try {
      await expect(
        requests.getByRole("heading", { name: "Access requests", exact: true }),
      ).toBeVisible();
      await expect(requests.locator(".skeleton").first()).toBeVisible();
      await expect(
        requests.getByRole("button", { name: "Copy access link" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `test-results/access-link-loading-${width}.png`,
        fullPage: true,
      });
      f.fail(true);
    } finally {
      pending.resolve();
    }
    await expect(page.locator(".toast").getByRole("alert")).toBeVisible();
    f.fail(false);
    await page.getByRole("button", { name: "Reload access requests" }).click();
    await expect(requests.getByRole("timer")).toHaveText("New link in 10s");
  });
}
