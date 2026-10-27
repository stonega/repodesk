import { expect, type Page, type Route, test } from "@playwright/test";
import { expectTopRightAction } from "./card-layout.ts";

const workspace = "b6e6d846-06b0-46ee-ac0c-47b617d17dcc";
const other = "48cfa12b-ae0b-4eb0-a8ee-b5cc10eb89ae";
async function fixture(page: Page) {
  const state = {
    defer: false,
    pending: [] as Route[],
    requests: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    state.requests.push(url.pathname + url.search);
    const members = path.endsWith("/members");
    const groups = path.endsWith("/chats");
    if (state.defer && (members || groups)) {
      state.pending.push(route);
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "Admin", operator: true },
                csrf: "fixture-csrf",
              }
            : path === "/api/admin/workspaces"
              ? [
                  { id: workspace, name: "First team" },
                  { id: other, name: "Other team" },
                ]
              : groups
                ? {
                    items: path.includes(other)
                      ? []
                      : [
                          {
                            id: "-100100",
                            title: "Design team",
                            active: true,
                            collection: false,
                            visibleAll: true,
                          },
                        ],
                  }
                : members
                  ? {
                      version: 1,
                      total: 101,
                      items: [
                        {
                          id: "202",
                          name: "Team member",
                          role: "member",
                          active: true,
                        },
                      ],
                    }
                  : path.endsWith("/access-requests")
                    ? {
                        version: 1,
                        items: [],
                        requestUrl:
                          "https://t.me/fixture_bot?start=access_fixture",
                      }
                    : path.endsWith("/members/github")
                      ? { connected: false, members: [] }
                      : {},
    });
  });
  return state;
}

async function expectMatchingGroupCard(page: Page) {
  const groups = page.getByRole("region", { name: "Groups", exact: true });
  const members = page.getByRole("region", {
    name: "Workspace members",
    exact: true,
  });
  const surfaces = await Promise.all(
    [groups, members].map((card) =>
      card.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.borderTopWidth,
          borderColor: style.borderTopColor,
          radius: style.borderTopLeftRadius,
          padding: style.padding,
          gap: style.rowGap,
        };
      }),
    ),
  );
  expect(surfaces[0]).toEqual(surfaces[1]);
  expect(Number.parseFloat(surfaces[0]?.border ?? "0")).toBeGreaterThan(0);
  await expect(groups.locator(".card")).toHaveCount(0);
  const spacing = await groups.evaluate((card) => {
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const first = card.firstElementChild?.getBoundingClientRect();
    const last = card.lastElementChild?.getBoundingClientRect();
    return {
      top: (first?.top ?? 0) - bounds.top,
      bottom: bounds.bottom - (last?.bottom ?? 0),
      expectedTop:
        parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
      expectedBottom:
        parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth),
    };
  });
  expect(spacing.top).toBeCloseTo(spacing.expectedTop, 0);
  expect(spacing.bottom).toBeCloseTo(spacing.expectedBottom, 0);
  await expectTopRightAction(
    groups,
    groups.getByRole("button", { name: "Link a group" }),
  );
}

async function expectMatchingTables(page: Page) {
  const groupTable = page.getByRole("region", { name: "Group access table" });
  const memberTable = page.getByRole("region", { name: "Member access table" });
  await expect(groupTable.getByRole("columnheader")).toHaveText([
    "Group",
    "Status",
    "Visibility",
    "Collection",
    "Actions",
  ]);
  const styles = await Promise.all(
    [groupTable, memberTable].map((region) =>
      region.getByRole("table").evaluate((table) => {
        const style = getComputedStyle(table);
        const cell = table.querySelector("th");
        if (!cell) throw new Error("Table header missing");
        const cellStyle = getComputedStyle(cell);
        return {
          fontSize: style.fontSize,
          minWidth: style.minWidth,
          borderCollapse: style.borderCollapse,
          padding: cellStyle.padding,
          border: cellStyle.borderBottom,
          color: cellStyle.color,
          overflow: getComputedStyle(table.parentElement as HTMLElement)
            .overflowX,
        };
      }),
    ),
  );
  expect(styles[0]).toEqual(styles[1]);
  await expect(groupTable).toHaveAttribute("tabindex", "0");
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`combined navigation, summaries and separate editors at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `/admin/chats?workspace=${workspace}&offset=100&source=legacy`,
      );
      await expect(page).toHaveURL(
        `/admin/members?workspace=${workspace}&offset=100&source=legacy`,
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Groups & Members",
      );
      if (width === 390)
        await page.getByRole("button", { name: "Open navigation" }).click();
      const link = page.getByRole("link", {
        name: "Groups & Members",
        exact: true,
      });
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("link", { name: /^(Group access|Members & access)$/ }),
      ).toHaveCount(0);
      if (width === 390) await page.keyboard.press("Escape");
      const groups = page.getByRole("region", { name: "Groups", exact: true });
      const members = page.getByRole("region", {
        name: "Workspace members",
        exact: true,
      });
      await expect(groups).toContainText("Design team");
      await expect(members).toContainText("Team member");
      await expect(
        page.getByRole("region", { name: "Access requests", exact: true }),
      ).toContainText("access_fixture");
      await expect(groups.locator("input, select, textarea")).toHaveCount(0);
      await expect(members.getByLabel("Telegram user ID")).toHaveCount(0);
      await expectMatchingGroupCard(page);
      await expectMatchingTables(page);
      const row = groups.getByRole("row").filter({ hasText: "Design team" });
      await expect(row.getByRole("cell")).toHaveText([
        "Design teamGroup ID: -100100",
        "Linked",
        "Receives group messages",
        "Directed only",
        "",
      ]);
      await expect(row.getByRole("button")).toHaveCount(1);
      await expect(
        row.getByRole("cell").last().getByRole("button"),
      ).toHaveAttribute("aria-label", "Edit Design team");
      await groups.screenshot({
        path: test.info().outputPath("group-table.png"),
      });
      if (width === 390) {
        const scroll = groups.getByRole("region", {
          name: "Group access table",
        });
        await scroll.focus();
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => scroll.evaluate((el) => el.scrollLeft))
          .toBeGreaterThan(0);
        await page.keyboard.press("Tab");
        await expect(row.getByRole("button")).toBeFocused();
      }
      const spacing = await members.evaluate((card) => {
        const bounds = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        const first = card.firstElementChild?.getBoundingClientRect();
        const last = card.lastElementChild?.getBoundingClientRect();
        const search = card.querySelector(".field");
        const next = search?.nextElementSibling;
        return {
          top: (first?.top ?? 0) - bounds.top,
          bottom: bounds.bottom - (last?.bottom ?? 0),
          expectedTop:
            parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
          expectedBottom:
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderBottomWidth),
          searchGap:
            (next?.getBoundingClientRect().top ?? 0) -
            (search?.getBoundingClientRect().bottom ?? 0),
          gap: parseFloat(style.rowGap),
        };
      });
      expect(spacing.top).toBeCloseTo(spacing.expectedTop, 0);
      expect(spacing.bottom).toBeCloseTo(spacing.expectedBottom, 0);
      expect(spacing.searchGap).toBeCloseTo(spacing.gap, 0);
      await expectTopRightAction(
        members,
        members.getByRole("button", { name: "Add member" }),
      );
      await expectTopRightAction(
        groups,
        groups.getByRole("button", { name: "Link a group" }),
      );
      expect(state.requests.filter((path) => path.includes("/chats?"))).toEqual(
        [`/api/admin/workspaces/${workspace}/chats?offset=0`],
      );
      await page.screenshot({
        path: test.info().outputPath("combined.png"),
        fullPage: true,
      });
      await members.getByRole("button", { name: "Add member" }).click();
      const memberDialog = page.getByRole("dialog", {
        name: "Add member",
        exact: true,
      });
      await expect(memberDialog.getByLabel("Telegram user ID")).toBeVisible();
      await expect(
        page.getByRole("dialog", { name: "Edit group", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("member-editor.png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(
        members.getByRole("button", { name: "Add member" }),
      ).toBeFocused();
      await groups.getByRole("button", { name: "Edit Design team" }).click();
      await expect(
        page.getByRole("dialog", { name: "Edit group", exact: true }),
      ).toContainText("Recheck bot visibility");
      await page.screenshot({
        path: test.info().outputPath("group-editor.png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(
        groups.getByRole("button", { name: "Edit Design team" }),
      ).toBeFocused();
      await members
        .getByLabel("Search members by name, username or ID")
        .fill("Team");
      await expect
        .poll(() =>
          state.requests.some((path) =>
            path.endsWith("/members?offset=0&search=Team"),
          ),
        )
        .toBe(true);
      await expect(groups).toContainText("Design team");
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.goto(`/admin/access-policy?workspace=${other}&offset=100`);
      await expect(page).toHaveURL(
        `/admin/members?workspace=${other}&offset=100`,
      );
      await expect(groups).toContainText("No group linked");
      await expect(groups).not.toContainText("Design team");
      await expect(members).toContainText("Team member");
      await expectMatchingGroupCard(page);
      await expectMatchingTables(page);
      await expect(groups.getByRole("row")).toHaveCount(1);
      const emptyGuidance = groups.locator(".group-table-message");
      await expect(emptyGuidance).toContainText("Telegram group admin.");
      const emptyBounds = await emptyGuidance.evaluate((element) => {
        const container = element.closest(".groups-card");
        const paragraph = element.querySelector("p");
        if (!container || !paragraph) throw new Error("Empty guidance missing");
        return {
          left: paragraph.getBoundingClientRect().left,
          right: paragraph.getBoundingClientRect().right,
          cardLeft: container.getBoundingClientRect().left,
          cardRight: container.getBoundingClientRect().right,
          overflow: paragraph.scrollWidth - paragraph.clientWidth,
        };
      });
      expect(emptyBounds.left).toBeGreaterThan(emptyBounds.cardLeft);
      expect(emptyBounds.right).toBeLessThan(emptyBounds.cardRight);
      expect(emptyBounds.overflow).toBeLessThanOrEqual(1);
      await groups.screenshot({
        path: test.info().outputPath("empty-group-table.png"),
      });
      await page.screenshot({
        path: test.info().outputPath("empty.png"),
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });
    test(`group and member requests load and recover independently at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      state.defer = true;
      await page.goto(`/admin/members?workspace=${workspace}`);
      const groups = page.getByRole("region", { name: "Groups", exact: true });
      const members = page.getByRole("region", {
        name: "Workspace members",
        exact: true,
      });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Groups & Members",
      );
      await expect(
        groups.getByRole("button", { name: "Link a group" }),
      ).toBeDisabled();
      await expect(
        members.getByRole("button", { name: "Add member" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("region", { name: "Group @mentions", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("No members match your search.")).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("heading", { name: "No group linked" }),
      ).toHaveCount(0);
      await expectMatchingGroupCard(page);
      await expectMatchingTables(page);
      await expect(groups.getByRole("cell")).toHaveAttribute("colspan", "5");
      await expect(
        groups.getByRole("status", { name: "Group details" }),
      ).toBeVisible();
      await groups.screenshot({
        path: test.info().outputPath("loading-group-table.png"),
      });
      await page.screenshot({
        path: test.info().outputPath("loading.png"),
        fullPage: true,
      });
      await expect.poll(() => state.pending.length).toBe(2);
      for (const route of state.pending.splice(0))
        await route.fulfill({
          status: 503,
          json: {
            error: route.request().url().includes("/chats")
              ? "Groups unavailable"
              : "Members unavailable",
          },
        });
      await expect(
        page.getByRole("alert").filter({ hasText: "Groups unavailable" }),
      ).toBeVisible();
      await expect(
        page.getByRole("alert").filter({ hasText: "Members unavailable" }),
      ).toBeVisible();
      const alerts = await page.locator(".toast-error").evaluateAll((toasts) =>
        toasts.map((toast) => {
          const bounds = toast.getBoundingClientRect();
          return { top: bounds.top, bottom: bounds.bottom };
        }),
      );
      expect(alerts).toHaveLength(2);
      expect(alerts[1]?.top).toBeGreaterThan(alerts[0]?.bottom ?? 0);
      await expectMatchingGroupCard(page);
      await expectMatchingTables(page);
      await expect(groups.getByRole("cell")).toHaveText(
        "Group details are unavailable.",
      );
      await groups.screenshot({
        path: test.info().outputPath("unavailable-group-table.png"),
      });
      await page.screenshot({
        path: test.info().outputPath("load-errors.png"),
        fullPage: true,
      });
      state.defer = false;
      await page.getByRole("button", { name: "Retry loading groups" }).click();
      await expect(groups).toContainText("Design team");
      await expect(
        members.getByRole("button", { name: "Add member" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Retry loading members" }).click();
      await expect(members).toContainText("Team member");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    });
  }
}
