import { expect, type Page, test } from "@playwright/test";
import type { Member } from "../../src/domain.ts";
import { workspace } from "../fixtures.ts";
import { chooseOption } from "./dropdown-helpers.ts";

async function fixture(
  page: Page,
  missingPermission = false,
  beforeDirectory?: (call: number) => Promise<void>,
) {
  const w = workspace();
  let version = w.memberVersion;
  const member: Member = {
    id: "202",
    role: "member",
    active: true,
    name: "Stone",
    username: "stonegate",
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
    saved: () => saved,
    calls: () => directoryCalls,
    recover: () => {
      missingPermission = false;
    },
  };
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
    await expect(
      page.getByRole("link", { name: "stonega", exact: true }),
    ).toHaveAttribute("href", "https://github.com/stonega");
    await expect(page.getByText("Verification pending")).toBeVisible();
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
