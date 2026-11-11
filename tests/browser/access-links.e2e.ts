import { expect, type Page, test } from "@playwright/test";
import { AccessLinks } from "../../src/workspaces/access-links.ts";
import { workspace } from "../fixtures.ts";

const startTime = new Date("2026-10-14T12:00:00Z");
async function expectInviteSpacing(page: Page) {
  const spacing = await page
    .getByRole("dialog", { name: "Add member" })
    .locator(".group-link-details")
    .evaluate((content) => {
      const rows = Array.from(content.children, (row) =>
        row.getBoundingClientRect(),
      );
      const bounds = content.getBoundingClientRect();
      return {
        top: (rows[0]?.top ?? 0) - bounds.top,
        bottom: bounds.bottom - (rows.at(-1)?.bottom ?? 0),
        gap: parseFloat(getComputedStyle(content).rowGap),
        gaps: rows.flatMap((row, index) => {
          const next = rows[index + 1];
          return next ? [next.top - row.bottom] : [];
        }),
      };
    });
  expect(spacing.top).toBeCloseTo(0, 0);
  expect(spacing.bottom).toBeCloseTo(0, 0);
  for (const gap of spacing.gaps) expect(gap).toBeCloseTo(spacing.gap, 0);
}

async function fixture(page: Page) {
  const w = workspace();
  const links = new AccessLinks("ab".repeat(32));
  let calls = 0;
  let failure = false;
  let gate: Promise<void> | undefined;
  let joined = false;
  let botAvailable = true;
  const members = Promise.withResolvers<void>();
  await page.clock.install({ time: startTime });
  await page.clock.pauseAt(new Date(startTime.getTime() + 1000));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chats")) {
      await route.fulfill({ json: { items: [], total: 0, offset: 0 } });
      return;
    }
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
            botAvailable ? { id: "999", username: "fixture_bot" } : undefined,
            new Date(startTime.getTime() + (calls - 1) * 10_000),
          ),
        },
      });
      return;
    }
    if (path.endsWith("/members")) await members.promise;
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
    enableMembers: () => members.resolve(),
    disconnectBot: () => {
      botAvailable = false;
    },
    ready: async () => {
      members.resolve();
      await expect(
        page.getByText("No members match your search."),
      ).toBeVisible();
      const requests = page.getByRole("region", {
        name: "Access requests",
        exact: true,
      });
      await expect(requests).toHaveAttribute("aria-busy", "false");
      if (
        (await page.getByRole("dialog", { name: "Add member" }).count()) === 0
      )
        await page
          .getByRole("button", { name: "Add member", exact: true })
          .click();
      await expect(
        page.getByRole("timer", { name: "Invite link refresh" }),
      ).toHaveText("New link in 10s");
    },
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
    await f.ready();
    const requests = page.getByRole("dialog", {
      name: "Add member",
      exact: true,
    });
    const timer = requests.getByRole("timer", { name: "Invite link refresh" });
    const heading = requests.locator(".service-url dt");
    const progress = timer.locator(".access-link-timer-progress");
    const link = requests.locator(".service-url code");
    await expectInviteSpacing(page);
    await expect(timer).toHaveText("New link in 10s");
    await expect(timer.locator("svg")).toBeVisible();
    await expect(progress).toHaveAttribute("stroke-dashoffset", "0");
    await expect(progress).toHaveCSS("transition-duration", "0.25s");
    await expect(timer.locator(".sr-only")).toHaveCSS(
      "clip-path",
      "inset(50%)",
    );
    const titleBox = await heading.evaluate((element) => {
      const finalWord = element.firstChild;
      if (!finalWord) throw Error("Missing final title word");
      const range = document.createRange();
      range.selectNodeContents(finalWord);
      const last = range.getBoundingClientRect();
      return { x: last.x, y: last.y, width: last.width, height: last.height };
    });
    const timerBox = await timer.boundingBox();
    expect(timerBox?.x).toBeGreaterThanOrEqual(
      (titleBox?.x ?? 0) + (titleBox?.width ?? 0),
    );
    expect(
      Math.abs(
        (timerBox?.y ?? 0) +
          (timerBox?.height ?? 0) / 2 -
          ((titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2),
      ),
    ).toBeLessThan(6);
    const approvals = page.getByRole("region", {
      name: "Access requests",
      exact: true,
    });
    await expect(approvals).toContainText("No pending access requests.");
    await expect(approvals.locator(".service-url")).toHaveCount(0);
    await expect(requests.locator("input, select, textarea")).toHaveCount(0);
    await expect(
      requests.getByRole("button", { name: "Save membership" }),
    ).toHaveCount(0);
    await expect(requests.getByRole("textbox")).toHaveCount(0);
    await expect(
      requests.getByRole("button", { name: /Refresh|Reload/ }),
    ).toHaveCount(0);
    await expect(requests).toContainText(
      "One Telegram account per link. No approval required.",
    );
    const first = await link.textContent();
    const initialCalls = f.calls();
    await page.clock.runFor(3000);
    await expect(timer).toHaveText("New link in 7s");
    await expect(progress).toHaveAttribute("stroke-dashoffset", "30");
    await page.screenshot({
      path: `test-results/access-link-circle-${width}.png`,
      fullPage: true,
    });
    await page.clock.runFor(6000);
    await expect(timer).toHaveText("New link in 1s");
    await expect(progress).toHaveAttribute("stroke-dashoffset", "90");
    expect(f.calls()).toBe(initialCalls);
    const pending = Promise.withResolvers<void>();
    f.hold(pending.promise);
    f.join();
    try {
      await page.clock.runFor(1000);
      await expect(timer).toHaveText("Updating link…");
      await expect(timer.locator("svg")).toHaveCSS(
        "animation-name",
        "icon-spin",
      );
      await expect(link).toHaveText(first ?? "");
      await expectInviteSpacing(page);
      await expect(
        requests.getByRole("button", { name: "Copy Access link" }),
      ).toBeEnabled();
      await requests.getByRole("button", { name: "Copy Access link" }).focus();
      await page.screenshot({
        path: `test-results/access-link-pending-${width}.png`,
        fullPage: true,
      });
    } finally {
      pending.resolve();
    }
    await expect(link).not.toHaveText(first ?? "");
    await expect(timer).toHaveText("New link in 10s");
    await expect(progress).toHaveAttribute("stroke-dashoffset", "0");
    await expect(
      requests.getByRole("button", { name: "Copy Access link" }),
    ).toBeFocused();
    await expect(
      page.getByRole("row").filter({ hasText: "Joined via invite" }),
    ).toBeVisible();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = requests.getByRole("button", {
      name: "Copy Access link",
      exact: true,
    });
    await expect(copy).toHaveCSS("border-top-width", "0px");
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await copy.click();
    await expect(
      requests.getByRole("button", { name: "Copied Access link" }),
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
    await requests.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Add member", exact: true }),
    ).toBeFocused();
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
    await f.ready();
    const requests = page.getByRole("dialog", {
      name: "Add member",
      exact: true,
    });
    const timer = requests.getByRole("timer");
    const link = requests.locator(".service-url code");
    await expect(timer).toHaveText("New link in 10s");
    const first = await link.textContent();
    const initialCalls = f.calls();
    f.fail(true);
    await page.clock.runFor(10_000);
    await expect(requests.getByRole("alert")).toBeVisible();
    await expect(timer).toHaveText("Link refresh paused.");
    await expectInviteSpacing(page);
    await expect(timer.locator("svg")).toHaveCSS("animation-name", "none");
    await expect(link).toHaveText(first ?? "");
    await page.clock.runFor(30_000);
    expect(f.calls()).toBe(initialCalls + 1);
    await expect(timer).toHaveText("Link refresh paused.");
    await page.screenshot({
      path: `test-results/access-link-error-${width}.png`,
      fullPage: true,
    });
    f.fail(false);
    await page.getByRole("button", { name: "Reload access requests" }).click();
    await expect(requests.getByRole("alert")).toHaveCount(0);
    await expect(timer).toHaveText("New link in 10s");
    await expect(link).not.toHaveText(first ?? "");
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () => Promise.reject(Error("denied")),
      });
    });
    await requests
      .getByRole("button", { name: "Copy Access link", exact: true })
      .click();
    await expect(requests.getByRole("alert")).toContainText(
      "Could not copy the link",
    );
  });

  test(`invite initial loading retains the dialog and errors offer recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const pending = Promise.withResolvers<void>();
    f.hold(pending.promise);
    await f.open();
    const requests = page.getByRole("dialog", {
      name: "Add member",
      exact: true,
    });
    f.enableMembers();
    await page.getByRole("button", { name: "Add member", exact: true }).click();
    try {
      await expect(
        requests.getByRole("heading", { name: "Add member", exact: true }),
      ).toBeVisible();
      await expect(requests.locator(".skeleton").first()).toBeVisible();
      await expect(
        requests.getByRole("button", { name: "Copy Access link" }),
      ).toBeDisabled();
      await page.screenshot({
        path: `test-results/access-link-loading-${width}.png`,
        fullPage: true,
      });
      f.fail(true);
    } finally {
      pending.resolve();
    }
    await expect(requests.getByRole("alert")).toBeVisible();
    f.fail(false);
    await page.getByRole("button", { name: "Reload access requests" }).click();
    await f.ready();
    await expect(requests.getByRole("timer")).toHaveText("New link in 10s");
  });

  test(`invite without a connected bot keeps its layout and offers no unusable link at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    f.disconnectBot();
    f.enableMembers();
    await f.open();
    await page.getByRole("button", { name: "Add member", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Add member",
      exact: true,
    });
    await expect(dialog.getByRole("status")).toHaveText(
      "Connect your Telegram bot before inviting members.",
    );
    await expect(
      dialog.getByRole("button", { name: "Copy Access link" }),
    ).toBeDisabled();
    await expect(dialog.getByRole("timer")).toHaveCount(0);
    await expect(dialog.locator("input, select, textarea")).toHaveCount(0);
    await expectInviteSpacing(page);
    await page.screenshot({
      path: `test-results/access-link-unavailable-${width}.png`,
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Add member", exact: true }),
    ).toBeFocused();
  });

  test(`invite circle respects reduced motion and still rotates links at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    const f = await fixture(page);
    await f.open();
    await f.ready();
    const timer = page.getByRole("timer", { name: "Invite link refresh" });
    const progress = timer.locator(".access-link-timer-progress");
    const link = page.locator(".service-url code");
    await expect(timer).toHaveText("New link in 10s");
    await expect(progress).toHaveCSS("transition-duration", "0s");
    await expectInviteSpacing(page);
    const first = await link.textContent();
    await page.clock.runFor(3000);
    await expect(timer).toHaveText("New link in 7s");
    await expect(progress).toHaveAttribute("stroke-dashoffset", "30");
    await page.screenshot({
      path: `test-results/access-link-circle-reduced-motion-${width}.png`,
      fullPage: true,
    });
    const pending = Promise.withResolvers<void>();
    f.hold(pending.promise);
    try {
      await page.clock.runFor(7000);
      await expect(timer).toHaveText("Updating link…");
      await expect(timer.locator("svg")).toHaveCSS("animation-name", "none");
      await expect(link).toHaveText(first ?? "");
    } finally {
      pending.resolve();
    }
    await expect(timer).toHaveText("New link in 10s");
    await expect(link).not.toHaveText(first ?? "");
  });
}
