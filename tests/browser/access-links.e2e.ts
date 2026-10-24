import { expect, type Page, test } from "@playwright/test";
import { AccessLinks } from "../../src/workspaces/access-links.ts";
import { workspace } from "../fixtures.ts";

const startTime = new Date("2026-10-14T12:00:00Z");
async function expectInviteSpacing(page: Page) {
  const spacing = await page.locator(".access-link-card").evaluate((card) => {
    const rows = Array.from(
      card.querySelector(".access-link-details")?.children ?? [],
      (row) => row.getBoundingClientRect(),
    );
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) throw Error("Missing invite content");
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return {
      top: first.top - bounds.top,
      expectedTop:
        parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
      bottom: bounds.bottom - last.bottom,
      expectedBottom:
        parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth),
      gaps: rows.flatMap((row, index) => {
        const next = rows[index + 1];
        return next ? [next.top - row.bottom] : [];
      }),
    };
  });
  expect(spacing.top).toBeCloseTo(spacing.expectedTop, 0);
  expect(spacing.bottom).toBeCloseTo(spacing.expectedBottom, 0);
  const firstGap = spacing.gaps[0];
  if (firstGap === undefined) throw Error("Missing invite rows");
  expect(firstGap).toBeGreaterThan(0);
  for (const gap of spacing.gaps) {
    expect(gap).toBeCloseTo(firstGap, 0);
  }
}

async function fixture(page: Page) {
  const w = workspace();
  const links = new AccessLinks("ab".repeat(32));
  let calls = 0;
  let failure = false;
  let gate: Promise<void> | undefined;
  let joined = false;
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
            { id: "999", username: "fixture_bot" },
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
    ready: async () => {
      const timer = page.getByRole("timer", { name: "Invite link refresh" });
      await expect(timer).toHaveText("New link in 10s");
      // Member data triggers another initial invite load. Stage it explicitly
      // and wait for its rendered URL before capturing a baseline or ticking.
      const issuedAt = new Date(startTime.getTime() + calls * 10_000);
      members.resolve();
      await expect(
        page.getByText("No members match your search."),
      ).toBeVisible();
      await expect(page.locator(".access-link-url")).toHaveText(
        links.view(w, { id: "999", username: "fixture_bot" }, issuedAt)
          .requestUrl ?? "",
      );
      await expect(timer).toHaveText("New link in 10s");
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
    const requests = page.getByRole("region", {
      name: "Access requests",
      exact: true,
    });
    const timer = requests.getByRole("timer", { name: "Invite link refresh" });
    const heading = requests.getByRole("heading", {
      name: "Share this link with someone who needs access",
    });
    const progress = timer.locator(".access-link-timer-progress");
    const link = requests.locator(".access-link-url");
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
      const finalWord = element.querySelector(
        ".access-link-heading-end",
      )?.firstChild;
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
    await expect(progress).toHaveAttribute("stroke-dashoffset", "0");
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
    await f.ready();
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
    await f.ready();
    await expect(requests.getByRole("timer")).toHaveText("New link in 10s");
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
    const link = page.locator(".access-link-url");
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
