import { expect, type Page, test } from "@playwright/test";
import type { Member } from "../../src/domain.ts";
import { workspace } from "../fixtures.ts";
import { chooseOption } from "./dropdown-helpers.ts";

async function fixture(
  page: Page,
  missingPermission = false,
  beforeDirectory?: (call: number) => Promise<void>,
  memberOverrides: Partial<Member> = {},
) {
  const w = workspace();
  let version = w.memberVersion;
  const member: Member = {
    id: "202",
    role: "member",
    active: true,
    name: "Stone",
    username: "stonegate",
    ...memberOverrides,
  };
  let directoryCalls = 0;
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/members/github")) {
      directoryCalls++;
      await beforeDirectory?.(directoryCalls);
      if (missingPermission) {
        await route.fulfill({
          status: 409,
          json: { error: "github_members_permission_missing" },
        });
        return;
      }
      await route.fulfill({
        json: {
          connected: true,
          revision: 7,
          account: "example",
          source: "organization",
          members: [
            { id: 42, login: "stonega" },
            { id: 43, login: "colleague" },
          ],
        },
      });
      return;
    }
    if (path.endsWith("/members") && request.method() === "POST") {
      saved = request.postDataJSON();
      if (saved?.githubId === 42)
        member.githubAccount = { id: 42, login: "stonega" };
      version++;
      await route.fulfill({ json: [member] });
      return;
    }
    if (path.endsWith("/members")) {
      const search = url.searchParams.get("search") ?? "";
      const items =
        !search ||
        `${member.name} ${member.githubAccount?.login}`.includes(search)
          ? [member]
          : [];
      await route.fulfill({ json: { items, total: items.length, version } });
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
              ? [{ id: w.id, name: "Members" }]
              : path.endsWith("/access-requests")
                ? { items: [], version, requestUrl: "https://t.me/fixture_bot" }
                : {},
    });
  });
  return {
    w,
    member,
    saved: () => saved,
    calls: () => directoryCalls,
    recover: () => {
      missingPermission = false;
    },
  };
}

function repositoryAccess(count: number): NonNullable<Member["github"]> {
  return {
    id: 42,
    login: "stonega",
    status: "connected",
    connectionRevision: 7,
    syncedAt: "2026-10-08T09:54:57Z",
    repositories: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      full_name:
        index === 59
          ? `stonega/${"long-repository-name-".repeat(5)}`
          : `stonega/repository-${index + 1}`,
      permissions: {
        pull: true,
        push: index % 5 <= 2,
        admin: index % 5 === 0,
        maintain: index % 5 === 1,
        triage: index % 5 === 3,
      },
    })),
  };
}

for (const width of [1280, 390]) {
  test(`member GitHub column only shows View and opens complete read-only details at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const github = repositoryAccess(60);
    const f = await fixture(page, false, undefined, { github });
    await page.goto(`/admin/members?workspace=${f.w.id}`);
    const row = page.getByRole("row").filter({ hasText: "ID: 202" });
    const githubCell = row.getByRole("cell").nth(3);
    await expect(githubCell).toHaveText("View");
    await expect(githubCell.getByRole("button")).toHaveCount(1);
    await expect(githubCell.getByRole("link")).toHaveCount(0);
    await expect(githubCell.getByRole("listitem")).toHaveCount(0);
    expect(
      await row.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThan(140);
    const view = row.getByRole("button", {
      name: "View GitHub for member 202",
    });
    await view.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/repodesk-member-github-view-${width}.png`,
      fullPage: true,
    });
    await view.click();
    const dialog = page.getByRole("dialog", { name: "stonega GitHub" });
    const items = dialog.getByRole("listitem");
    await expect(items).toHaveCount(60);
    await expect(items.nth(0)).toHaveText("stonega/repository-1 Admin");
    await expect(items.nth(1)).toHaveText("stonega/repository-2 Maintain");
    await expect(items.nth(2)).toHaveText("stonega/repository-3 Write");
    await expect(items.nth(3)).toHaveText("stonega/repository-4 Triage");
    await expect(items.nth(4)).toHaveText("stonega/repository-5 Read");
    await expect(items.nth(5)).toHaveText("stonega/repository-6 Admin");
    await expect(dialog).toContainText("connected · Synced");
    await expect(
      dialog.getByText("60 repositories", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Save/ })).toHaveCount(0);
    const close = dialog.getByRole("button", {
      name: "Close stonega GitHub",
    });
    await expect(close).toBeFocused();
    const links = dialog.getByRole("link");
    await expect(links).toHaveCount(61);
    await expect(links.first()).toHaveAttribute(
      "href",
      "https://github.com/stonega",
    );
    await expect(links.nth(1)).toHaveAttribute(
      "href",
      "https://github.com/stonega/repository-1",
    );
    await expect(links.first()).toHaveAttribute("rel", "noopener noreferrer");
    await close.press("Tab");
    await expect(links.first()).toBeFocused();
    await links.first().press("Shift+Tab");
    await expect(close).toBeFocused();
    await close.press("Shift+Tab");
    await expect(links.last()).toBeFocused();
    await links.last().press("Tab");
    await expect(close).toBeFocused();
    expect(
      await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          element.scrollHeight > element.clientHeight &&
          element.scrollWidth <= element.clientWidth
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/repodesk-member-repository-modal-${width}.png`,
      fullPage: true,
    });
    await items.last().scrollIntoViewIfNeeded();
    await expect(items.last()).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/repodesk-member-repository-modal-last-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(view).toBeFocused();
    await expect(githubCell).toHaveText("View");
    await view.click();
    await close.click();
    await expect(dialog).not.toBeVisible();
    await expect(view).toBeFocused();
    expect(f.saved()).toBeUndefined();
    expect(f.calls()).toBe(0);
  });

  test(`member GitHub details handle zero, one, five and six repositories at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    for (const count of [0, 1, 5, 6]) {
      f.member.github = repositoryAccess(count);
      await page.goto(`/admin/members?workspace=${f.w.id}`);
      const row = page.getByRole("row").filter({ hasText: "ID: 202" });
      await expect(row.getByRole("cell").nth(3)).toHaveText("View");
      await row
        .getByRole("button", { name: "View GitHub for member 202" })
        .click();
      const dialog = page.getByRole("dialog", { name: "stonega GitHub" });
      await expect(
        dialog.getByRole("link", { name: "stonega", exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole("listitem")).toHaveCount(count);
      await expect(
        dialog.getByText(
          count === 0
            ? "No repository access."
            : `${count} ${count === 1 ? "repository" : "repositories"}`,
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `/tmp/repodesk-member-github-${count}-${width}.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
    }
  });

  test(`member GitHub View shows unlinked and verification-pending accounts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    for (const pending of [false, true]) {
      f.member.githubAccount = pending
        ? { id: 42, login: "stonega" }
        : undefined;
      await page.goto(`/admin/members?workspace=${f.w.id}`);
      const row = page.getByRole("row").filter({ hasText: "ID: 202" });
      await expect(row.getByRole("cell").nth(3)).toHaveText("View");
      await expect(row.getByRole("link")).toHaveCount(0);
      await row
        .getByRole("button", { name: "View GitHub for member 202" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: pending ? "stonega GitHub" : "Stone GitHub",
      });
      await expect(dialog).toContainText(
        pending ? "Verification pending" : "Not linked",
      );
      await expect(dialog.getByRole("listitem")).toHaveCount(0);
      await expect(dialog.getByRole("combobox")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /Save/ })).toHaveCount(0);
      await expect(dialog.getByRole("link")).toHaveCount(pending ? 1 : 0);
      await page.screenshot({
        path: `/tmp/repodesk-member-github-${pending ? "pending" : "unlinked"}-${width}.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
    }
    expect(f.saved()).toBeUndefined();
    expect(f.calls()).toBe(0);
  });

  test(`member GitHub View preserves loading, failed-load recovery and empty states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, false, undefined, {
      github: repositoryAccess(1),
    });
    const release = Promise.withResolvers<void>();
    let fail = true;
    await page.route(
      /\/api\/admin\/workspaces\/[^/]+\/members\?/,
      async (route) => {
        await release.promise;
        if (fail) {
          await route.fulfill({
            status: 503,
            json: { error: "Members unavailable" },
          });
        } else {
          await route.fallback();
        }
      },
    );
    await page.goto(`/admin/members?workspace=${f.w.id}`);
    const table = page.getByRole("region", { name: "Member access table" });
    await expect(
      table.getByRole("columnheader", { name: "GitHub" }),
    ).toBeVisible();
    await expect(
      table.getByRole("button", { name: /View GitHub/ }),
    ).toHaveCount(0);
    await expect(page.getByText("Not linked", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/repodesk-member-github-loading-${width}.png`,
      fullPage: true,
    });
    release.resolve();
    const notification = page.getByRole("region", { name: "Notification" });
    await expect(notification.getByRole("alert")).toContainText(
      "Members unavailable",
    );
    await page.screenshot({
      path: `/tmp/repodesk-member-github-error-${width}.png`,
      fullPage: true,
    });
    fail = false;
    await notification
      .getByRole("button", { name: "Retry loading members" })
      .click();
    const view = table.getByRole("button", {
      name: "View GitHub for member 202",
    });
    await expect(view).toBeEnabled();
    await expect(notification).not.toBeVisible();
    await view.click();
    await expect(
      page.getByRole("dialog", { name: "stonega GitHub" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByLabel("Search members by name, username or ID")
      .fill("nobody");
    await expect(page.getByText("No members match your search.")).toBeVisible();
    await expect(
      table.getByRole("button", { name: /View GitHub/ }),
    ).toHaveCount(0);
    await expect(
      table.getByRole("columnheader", { name: "GitHub" }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/repodesk-member-github-empty-${width}.png`,
      fullPage: true,
    });
  });
}

for (const width of [1280, 390]) {
  test(`member edit fetches GitHub accounts, saves selection and restores it at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await page.goto(`/admin/members?workspace=${f.w.id}`);
    await page.getByRole("button", { name: "Edit member 202" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit member" });
    const selector = dialog.getByRole("combobox", { name: "GitHub account" });
    await expect(selector).toBeEnabled();
    expect(f.calls()).toBe(1);
    await chooseOption(selector, "42");
    await expect(
      dialog.getByRole("link", { name: "View stonega on GitHub" }),
    ).toHaveAttribute("href", "https://github.com/stonega");
    await page.screenshot({
      path: `/tmp/repodesk-github-member-${width}.png`,
      fullPage: true,
    });
    expect(
      await dialog.evaluate(
        (element) => element.getBoundingClientRect().right <= window.innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "Save membership" }).click();
    await expect(dialog).not.toBeVisible();
    expect(f.saved()).toMatchObject({
      id: "202",
      githubId: 42,
      githubRevision: 7,
      version: f.w.memberVersion,
    });
    await page
      .getByRole("button", { name: "View GitHub for member 202" })
      .click();
    const details = page.getByRole("dialog", { name: "stonega GitHub" });
    await expect(
      details.getByRole("link", { name: "stonega", exact: true }),
    ).toHaveAttribute("href", "https://github.com/stonega");
    await expect(details.getByText("Verification pending")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit member 202" }).click();
    await expect(selector).toHaveAttribute("value", "42");
    await expect(selector).toHaveAttribute("aria-expanded", "false");
    await dialog.getByRole("button", { name: "Save membership" }).click();
    await expect(dialog).not.toBeVisible();
    expect(f.saved()).not.toHaveProperty("githubId");
  });
}

test("missing GitHub permission explains recovery and leaves membership editing available", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.goto(`/admin/members?workspace=${f.w.id}`);
  await page.getByRole("button", { name: "Edit member 202" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit member" });
  await expect(dialog.getByRole("alert")).toContainText("Enable Members: read");
  await expect(
    dialog.getByRole("combobox", { name: "GitHub account" }),
  ).toBeDisabled();
  f.recover();
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => f.calls()).toBe(2);
  await expect(
    dialog.getByRole("combobox", { name: "GitHub account" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("alert")).not.toBeVisible();
  await dialog.getByRole("button", { name: "Save membership" }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.saved()).not.toHaveProperty("githubId");
});

test("stalled member lookups time out and retry without losing the membership draft", async ({
  page,
}) => {
  const release = Promise.withResolvers<void>();
  const f = await fixture(page, false, (call) =>
    call === 1 ? release.promise : Promise.resolve(),
  );
  await page.clock.install();
  await page.goto(`/admin/members?workspace=${f.w.id}`);
  await page.getByRole("button", { name: "Edit member 202" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit member" });
  const selector = dialog.getByRole("combobox", { name: "GitHub account" });
  try {
    await expect(dialog.getByText("Fetching GitHub members…")).toBeVisible();
    await expect.poll(() => f.calls()).toBe(1);
    await chooseOption(dialog.getByRole("combobox", { name: "Role" }), "admin");
    await dialog.getByRole("switch", { name: "Active membership" }).uncheck();
    await page.clock.runFor(65000);
    await expect(dialog.getByRole("alert")).toContainText(
      "GitHub is taking too long",
    );
    await expect(
      dialog.getByText("Fetching GitHub members…"),
    ).not.toBeVisible();
    await expect(selector).toBeDisabled();
    await expect(
      dialog.getByRole("combobox", { name: "Role" }),
    ).toHaveAttribute("value", "admin");
    await expect(
      dialog.getByRole("switch", { name: "Active membership" }),
    ).not.toBeChecked();
    await dialog
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(selector).toBeEnabled();
    expect(f.calls()).toBe(2);
    await expect(dialog.getByRole("alert")).not.toBeVisible();
    await chooseOption(selector, "42");
    release.resolve();
    await dialog.getByRole("button", { name: "Save membership" }).click();
    await expect(dialog).not.toBeVisible();
    expect(f.saved()).toMatchObject({
      role: "admin",
      active: false,
      githubId: 42,
      githubRevision: 7,
    });
  } finally {
    release.resolve();
  }
});

test("server lookup timeouts end loading with actionable recovery", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/members/github", (route) =>
    route.fulfill({ status: 504, json: { error: "github_members_timeout" } }),
  );
  await page.goto(`/admin/members?workspace=${f.w.id}`);
  await page.getByRole("button", { name: "Edit member 202" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit member" });
  await expect(dialog.getByRole("alert")).toContainText(
    "GitHub is taking too long",
  );
  await expect(dialog.getByText("Fetching GitHub members…")).not.toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Save membership" }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.saved()).not.toHaveProperty("githubId");
});
