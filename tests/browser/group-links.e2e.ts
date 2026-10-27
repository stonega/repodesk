import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import type { Chat } from "../../src/domain.ts";

async function expectRowAction(row: Locator, action: Locator) {
  const cell = row.getByRole("cell").last();
  await expect(cell.getByRole("button")).toHaveCount(1);
  await expect(action).toBeVisible();
  const placement = await action.evaluate((button) => {
    const cell = button.closest("td");
    if (!cell) throw new Error("Group action must be in a table cell");
    const bounds = button.getBoundingClientRect();
    const parent = cell.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      cellTop: parent.top,
      cellBottom: parent.bottom,
      cellLeft: parent.left,
      cellRight: parent.right,
    };
  });
  expect(placement.top).toBeGreaterThanOrEqual(placement.cellTop);
  expect(placement.bottom).toBeLessThanOrEqual(placement.cellBottom);
  expect(placement.left).toBeGreaterThanOrEqual(placement.cellLeft);
  expect(placement.right).toBeLessThanOrEqual(placement.cellRight);
}

const first = "b6e6d846-06b0-46ee-ac0c-47b617d17dcc";
const second = "48cfa12b-ae0b-4eb0-a8ee-b5cc10eb89ae";
const command = `/link@fixture_bot ${"a".repeat(43)}`;
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Link a group" });
const editor = (page: Page) =>
  page.getByRole("dialog", { name: "Edit group", exact: true });
async function fixture(page: Page) {
  const state = {
    linked: false,
    title: "Fixture group",
    active: true,
    collection: false,
    visibleAll: false,
    linkedAt: "2026-10-25T00:00:00.000Z",
    extraGroups: [] as Chat[],
    listOffsets: [] as number[],
    deferList: false,
    failList: false,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    pending: [] as Route[],
    lists: [] as Route[],
    issued: [] as string[],
    actions: [] as string[],
    actionTargets: [] as string[],
    pendingActions: [] as Route[],
    visibility: [] as Route[],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/members") || path.endsWith("/access-requests")) {
      await route.fulfill({
        json: { version: 1, items: [], total: 0, offset: 0, requestUrl: null },
      });
      return;
    }
    if (/\/chats\/-\d+\/visibility$/.test(path)) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
      state.visibility.push(route);
      return;
    }
    if (/\/chats\/-\d+\/action$/.test(path)) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
      state.actions.push(route.request().postDataJSON().action);
      state.actionTargets.push(path);
      state.pendingActions.push(route);
      return;
    }
    if (path.endsWith("/chats/link-token")) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
      state.issued.push(path);
      state.pending.push(route);
      return;
    }
    if (path.endsWith("/chats")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      state.listOffsets.push(offset);
      if (state.deferList) {
        state.lists.push(route);
        return;
      }
      if (state.failList) {
        await route.fulfill({
          status: 503,
          json: { error: "Groups unavailable" },
        });
        return;
      }
      const groups = path.includes(first)
        ? [
            ...(state.linked
              ? [
                  {
                    id: "-100100",
                    title: state.title,
                    active: state.active,
                    visibleAll: state.visibleAll,
                    collection: state.collection,
                    linkedAt: state.linkedAt,
                  },
                ]
              : []),
            ...state.extraGroups,
          ]
        : [];
      await route.fulfill({
        json: {
          items: groups.slice(offset, offset + 100),
          total: groups.length,
          offset,
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
                admin: { id: "operator", username: "Admin", operator: true },
                csrf: "fixture-csrf",
              }
            : path === "/api/admin/workspaces"
              ? [
                  { id: first, name: "First team" },
                  { id: second, name: "Other team" },
                ]
              : {},
    });
  });
  return state;
}
async function complete(
  state: Awaited<ReturnType<typeof fixture>>,
  value = command,
) {
  await expect.poll(() => state.pending.length).toBe(1);
  const route = state.pending.shift();
  await route?.fulfill({
    status: 201,
    json: { command: value, expiresAt: state.expiresAt },
  });
}
async function shot(page: Page, name: string) {
  const guide = page.getByRole("region", {
    name: "Group @mentions",
  });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Administrator access is optional.");
  await expect(guide).toContainText(
    "Message collection is not required for @mentions.",
  );
  await expect(
    guide.getByRole("link", { name: "Telegram privacy-mode guide" }),
  ).toHaveAttribute(
    "href",
    "https://core.telegram.org/bots/features#privacy-mode",
  );
  const overflow = await page
    .locator(
      ".group-link-details, .group-link-details > *, .modal-fields, .group-table td:first-child, .group-table td:first-child > *, .group-mention-guide, .group-mention-guide > *, .group-mention-guide li",
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          className: element.className,
          width: element.clientWidth,
          contentWidth: element.scrollWidth,
        })),
    );
  expect(overflow).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
  });
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    page.viewportSize()?.width,
  );
}
for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`one collection action follows saved state, pending refresh and retry at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      state.linked = true;
      state.visibleAll = true;
      await page.goto(`/admin/chats?workspace=${first}`);
      const card = page.locator(".group-row");
      const edit = card.getByRole("button", { name: "Edit Fixture group" });
      await expect(card.getByRole("button")).toHaveCount(1);
      await expect(edit).toHaveAttribute("title", "Edit");
      await expect(edit.locator("svg")).toHaveCount(1);
      await expect(edit).toHaveCSS("border-width", "0px");
      await expectRowAction(card, edit);
      const bounds = await edit.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      await expect(card.locator("input, select, textarea")).toHaveCount(0);
      const collection = editor(page).locator(".modal-actions .action button");
      for (const enabled of [false, true]) {
        const label = enabled
          ? "Disable message collection"
          : "Enable message collection";
        const status = enabled ? "Enabled" : "Directed only";
        const action = enabled ? "directed" : "collect";
        await expect(card.getByRole("cell").nth(3)).toHaveText(status);
        await shot(
          page,
          enabled ? "collection-enabled-card" : "collection-disabled-card",
        );
        await edit.focus();
        await page.keyboard.press("Enter");
        await expect(editor(page)).toBeVisible();
        await expect(editor(page)).toContainText(
          "Changes take effect immediately.",
        );
        await expect(editor(page)).toContainText(
          "people who are not workspace members",
        );
        await expect(collection).toHaveText(label);
        await expect(
          editor(page).getByRole("button", {
            name: /Consent to collection|Directed messages only/,
          }),
        ).toHaveCount(0);
        await shot(
          page,
          enabled ? "collection-enabled" : "collection-disabled",
        );
        await collection.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => state.pendingActions.length).toBe(1);
        expect(state.actions.at(-1)).toBe(action);
        await expect(collection).toHaveText("Working…");
        for (const button of await editor(page).getByRole("button").all())
          await expect(button).toBeDisabled();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        await expect(editor(page)).toBeVisible();
        expect(state.pendingActions).toHaveLength(1);
        await expect(card.getByRole("cell").nth(3)).toHaveText(status);
        await shot(page, `collection-${action}-pending`);
        await state.pendingActions.shift()?.fulfill({
          status: 503,
          json: { error: "Collection update failed" },
        });
        await expect(editor(page).getByRole("alert")).toContainText(
          "Collection update failed",
        );
        await expect(collection).toHaveText(label);
        await expect(collection).toBeEnabled();
        await expect(card.getByRole("cell").nth(3)).toHaveText(status);
        await shot(page, `collection-${action}-error`);
        await collection.click();
        await expect.poll(() => state.pendingActions.length).toBe(1);
        state.collection = !enabled;
        state.deferList = true;
        await state.pendingActions.shift()?.fulfill({ json: { ok: true } });
        await expect.poll(() => state.lists.length).toBe(1);
        await expect(collection).toBeDisabled();
        await expect(
          editor(page).getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await expect(card.getByRole("cell").nth(3)).toHaveText(status);
        await shot(page, `collection-${action}-refresh`);
        state.deferList = false;
        await state.lists.shift()?.fulfill({
          json: {
            items: [
              {
                id: "-100100",
                title: "Fixture group",
                active: true,
                visibleAll: true,
                collection: state.collection,
              },
            ],
            total: 1,
            offset: 0,
          },
        });
        await expect(collection).toHaveText(
          enabled ? "Enable message collection" : "Disable message collection",
        );
        await expect(collection).toBeEnabled();
        await expect(editor(page).getByRole("alert")).toHaveCount(0);
        await collection.focus();
        await page.keyboard.press("Tab");
        const cancel = editor(page).getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        await expect(cancel).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          editor(page).getByRole("button", { name: "Close Edit group" }),
        ).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(cancel).toBeFocused();
        if (enabled) await cancel.click();
        else await page.keyboard.press("Escape");
        await expect(editor(page)).toHaveCount(0);
        await expect(edit).toBeFocused();
        await page.reload();
        await expect(card.getByRole("cell").nth(3)).toHaveText(
          enabled ? "Directed only" : "Enabled",
        );
        await expect(card.getByRole("button")).toHaveCount(1);
      }
      expect(state.actions).toEqual([
        "collect",
        "collect",
        "directed",
        "directed",
      ]);
      for (const section of [
        page.locator(".groups-card"),
        page.locator(".group-mention-guide"),
      ]) {
        const spacing = await section.evaluate((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const first = element.firstElementChild;
          const last = element.lastElementChild;
          if (!first || !last) throw new Error("Group card content is missing");
          return {
            top: first.getBoundingClientRect().top - bounds.top,
            bottom: bounds.bottom - last.getBoundingClientRect().bottom,
            expectedTop:
              parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
            expectedBottom:
              parseFloat(style.paddingBottom) +
              parseFloat(style.borderBottomWidth),
          };
        });
        expect(spacing.top).toBeCloseTo(spacing.expectedTop);
        expect(spacing.bottom).toBeCloseTo(spacing.expectedBottom);
      }
    });
    test(`group editor rechecks visibility and unlinks with error recovery at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      state.linked = true;
      await page.goto(`/admin/chats?workspace=${first}`);
      const card = page.locator(".group-row");
      const edit = card.getByRole("button", { name: "Edit Fixture group" });
      await edit.click();
      const recheck = editor(page).getByRole("button", {
        name: "Recheck bot visibility",
      });
      await recheck.click();
      await expect.poll(() => state.visibility.length).toBe(1);
      await page.keyboard.press("Escape");
      await expect(editor(page)).toBeVisible();
      for (const button of await editor(page).getByRole("button").all())
        await expect(button).toBeDisabled();
      await state.visibility
        .shift()
        ?.fulfill({ status: 503, json: { error: "Visibility check failed" } });
      await expect(editor(page).getByRole("alert")).toHaveText(
        "Visibility check failed",
      );
      await expect(card).toContainText("Directed visibility");
      await recheck.click();
      await expect.poll(() => state.visibility.length).toBe(1);
      state.visibleAll = true;
      state.failList = true;
      await state.visibility.shift()?.fulfill({ json: { ok: true } });
      await expect(editor(page).getByRole("alert")).toHaveText(
        "Groups unavailable",
      );
      await shot(page, "editor-refresh-error");
      state.failList = false;
      await editor(page)
        .getByRole("button", { name: "Retry loading groups" })
        .click();
      await expect(editor(page)).toContainText("Receives group messages");
      await expect(editor(page)).toContainText("Collection: directed only");
      await expect(editor(page).getByRole("alert")).toHaveCount(0);
      const unlink = editor(page).getByRole("button", { name: "Unlink group" });
      await unlink.click();
      await expect.poll(() => state.pendingActions.length).toBe(1);
      await shot(page, "unlink-pending");
      await state.pendingActions
        .shift()
        ?.fulfill({ status: 503, json: { error: "Unlink failed" } });
      await expect(editor(page).getByRole("alert")).toHaveText("Unlink failed");
      await expect(card).toContainText("Linked");
      await unlink.click();
      await expect.poll(() => state.pendingActions.length).toBe(1);
      state.active = false;
      await state.pendingActions.shift()?.fulfill({ json: { ok: true } });
      await expect(editor(page)).toContainText("Inactive");
      await expect(editor(page).getByRole("alert")).toHaveCount(0);
      await editor(page)
        .getByRole("button", { name: "Close Edit group" })
        .click();
      await expect(edit).toBeFocused();
      await expect(card).toContainText("This group is inactive.");
      await shot(page, "unlinked-card");
      expect(state.actions).toEqual(["unlink", "unlink"]);
    });
    test(`panel group command, pending locks, copying and saved summary at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text: string) => {
              (window as unknown as { copied: string }).copied = text;
            },
          },
        });
      });
      const state = await fixture(page);
      await page.goto(`/admin/chats?workspace=${first}`);
      await expect(
        page.getByRole("heading", { name: "No group linked" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Groups", exact: true })
          .locator("input, select, textarea"),
      ).toHaveCount(0);
      await shot(page, "empty");
      const start = page.getByRole("button", {
        name: "Link a group",
        exact: true,
      });
      await start.click();
      await expect(dialog(page)).toContainText("Generating command");
      await expect(
        dialog(page).getByRole("button", { name: "Close Link a group" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeVisible();
      await shot(page, "pending");
      expect(state.issued).toHaveLength(1);
      await complete(state);
      await expect(dialog(page).locator("code")).toHaveText(command);
      await expect(dialog(page)).toContainText(
        "Linking enables message collection by default.",
      );
      await expect(dialog(page).locator(".service-urls")).toHaveCSS(
        "margin",
        "0px",
      );
      await expect(dialog(page).locator("input, textarea, select")).toHaveCount(
        0,
      );
      const copy = dialog(page).getByRole("button", {
        name: "Copy Group-link command",
      });
      await copy.click();
      expect(
        await page.evaluate(
          () => (window as unknown as { copied: string }).copied,
        ),
      ).toBe(command);
      await expect(
        dialog(page).getByRole("button", { name: "Copied Group-link command" }),
      ).toBeVisible();
      await expect(copy).toBeVisible();
      await shot(page, "command");
      await dialog(page)
        .getByRole("button", { name: "Cancel", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog(page).getByRole("button", { name: "Close Link a group" }),
      ).toBeFocused();
      state.linked = true;
      state.collection = true;
      await expect(dialog(page)).toContainText("Group linked.");
      await expect(dialog(page).locator("code")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(start).toBeEnabled();
      await expect(
        page.getByRole("cell").filter({ hasText: "Fixture group" }),
      ).toBeVisible();
      await expect(start).toBeFocused();
      await expect(
        page
          .getByRole("region", { name: "Groups", exact: true })
          .locator("input, select, textarea"),
      ).toHaveCount(0);
      await shot(page, "linked");
    });
    test(`inactive groups guide users through relinking at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      state.linked = true;
      state.active = false;
      state.visibleAll = true;
      await page.goto(`/admin/chats?workspace=${first}`);
      const card = page.locator(".group-row");
      await expect(card).toContainText("Inactive");
      await expect(card).toContainText(
        "Re-adding the bot in Telegram does not restore the RepoDesk link.",
      );
      await shot(page, "inactive");
      await page
        .getByRole("button", { name: "Link a group", exact: true })
        .click();
      await complete(state);
      await expect(dialog(page).locator("code")).toHaveText(command);
      state.active = true;
      state.collection = true;
      await expect(dialog(page)).toContainText("Group linked.");
      await page.keyboard.press("Escape");
      await expect(card).not.toContainText("This group is inactive.");
      await expect(
        page.getByRole("button", { name: "Link a group", exact: true }),
      ).toBeEnabled();
      await shot(page, "relinked");
    });
    test(`multiple groups link and edit independently at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (value) => localStorage.setItem("repodesk.theme", value),
        theme,
      );
      const state = await fixture(page);
      state.linked = true;
      await page.goto(`/admin/members?workspace=${first}`);
      const groups = page.getByRole("region", { name: "Groups", exact: true });
      const start = groups.getByRole("button", { name: "Link a group" });
      const original = groups
        .locator(".group-row")
        .filter({ hasText: "Fixture group" });
      await expect(start).toBeEnabled();
      await start.click();
      await expect(dialog(page)).toContainText("Generating command");
      await expect(dialog(page)).not.toContainText("Group linked.");
      await shot(page, "second-group-pending");
      await expect.poll(() => state.pending.length).toBe(1);
      await state.pending
        .shift()
        ?.fulfill({ status: 503, json: { error: "unavailable" } });
      await expect(dialog(page).getByRole("alert")).toContainText(
        "Could not create",
      );
      await shot(page, "second-group-error");
      await dialog(page)
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await complete(state);
      await expect(dialog(page).locator("code")).toHaveText(command);
      const requests = state.listOffsets.length;
      // An unrelated refresh or collection change on the existing group is not a new link.
      state.collection = true;
      await expect
        .poll(() => state.listOffsets.length)
        .toBeGreaterThan(requests);
      await expect(original.getByRole("cell").nth(3)).toHaveText("Enabled");
      await expect(dialog(page).locator("code")).toHaveText(command);
      const added: Chat = {
        id: "-100200",
        title: "Engineering group",
        active: true,
        collection: true,
        visibleAll: true,
        linkedAt: "2026-10-26T00:00:00.000Z",
      };
      state.extraGroups.push(added);
      await expect(dialog(page)).toContainText("Group linked.");
      await expect(dialog(page).locator("code")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(start).toBeFocused();
      await expect(start).toBeEnabled();
      await expect(groups.locator(".group-row")).toHaveCount(2);
      await expect(
        groups.locator("input, textarea, select, .card"),
      ).toHaveCount(0);
      const addedCard = groups
        .locator(".group-row")
        .filter({ hasText: "Engineering group" });
      await expectRowAction(
        addedCard,
        addedCard.getByRole("button", { name: "Edit Engineering group" }),
      );
      const spacing = await groups.evaluate((card) => {
        const bounds = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        return {
          bottom:
            bounds.bottom -
            (card.lastElementChild?.getBoundingClientRect().bottom ?? 0),
          expected:
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderBottomWidth),
        };
      });
      expect(spacing.bottom).toBeCloseTo(spacing.expected, 0);
      await shot(page, "multiple-groups-saved");
      await addedCard
        .getByRole("button", { name: "Edit Engineering group" })
        .click();
      await expect(editor(page)).toContainText("Group ID: -100200");
      await editor(page)
        .getByRole("button", { name: "Disable message collection" })
        .click();
      await expect.poll(() => state.pendingActions.length).toBe(1);
      expect(state.actionTargets.at(-1)).toBe(
        `/api/admin/workspaces/${first}/chats/-100200/action`,
      );
      added.collection = false;
      await state.pendingActions.shift()?.fulfill({ json: { ok: true } });
      await expect(
        editor(page).getByRole("button", { name: "Enable message collection" }),
      ).toBeEnabled();
      await expect(original.getByRole("cell").nth(3)).toHaveText("Enabled");
      await shot(page, "multiple-groups-editor");
      await editor(page).getByRole("button", { name: "Unlink group" }).click();
      await expect.poll(() => state.pendingActions.length).toBe(1);
      added.active = false;
      await state.pendingActions.shift()?.fulfill({ json: { ok: true } });
      await expect(editor(page)).toContainText("Inactive");
      await page.keyboard.press("Escape");
      await expect(original).toContainText("Linked");
      await expect(addedCard).toContainText("This group is inactive.");
      await shot(page, "multiple-groups-inactive");
      await start.click();
      await complete(state);
      await expect(dialog(page).locator("code")).toHaveText(command);
      added.active = true;
      added.linkedAt = "2026-10-26T01:00:00.000Z";
      await expect(dialog(page)).toContainText("Group linked.");
      await page.keyboard.press("Escape");
      await expect(start).toBeFocused();
      await expect(addedCard).not.toContainText("This group is inactive.");
      expect(state.actions).toEqual(["directed", "unlink"]);
    });
  }
  test(`group names wrap and unnamed groups retain their Edit action at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const state = await fixture(page);
    state.linked = true;
    state.title = "LongTelegramGroupName".repeat(6);
    await page.goto(`/admin/chats?workspace=${first}`);
    const card = page.locator(".group-row");
    let edit = card.getByRole("button", { name: `Edit ${state.title}` });
    await expectRowAction(card, edit);
    await shot(page, "long-group-name-card");
    await edit.click();
    await expect(
      editor(page).getByRole("heading", { name: state.title }),
    ).toBeVisible();
    await shot(page, "long-group-name-editor");
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    state.title = "";
    await page.reload();
    await expect(
      card.getByRole("cell", { name: "-100100", exact: true }),
    ).toBeVisible();
    edit = card.getByRole("button", { name: "Edit -100100" });
    await expectRowAction(card, edit);
    await edit.click();
    await expect(
      editor(page).getByRole("heading", { name: "-100100" }),
    ).toBeVisible();
    await editor(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(edit).toBeFocused();
    expect(state.actions).toEqual([]);
  });
  test(`group token errors, clipboard failure, expiry and workspace isolation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      });
    });
    const state = await fixture(page);
    await page.goto(`/admin/chats?workspace=${first}`);
    await page
      .getByRole("button", { name: "Link a group", exact: true })
      .click();
    await expect.poll(() => state.pending.length).toBe(1);
    await state.pending
      .shift()
      ?.fulfill({ status: 503, json: { error: "unavailable" } });
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Could not create",
    );
    await shot(page, "request-error");
    await dialog(page)
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await complete(state);
    await dialog(page)
      .getByRole("button", { name: "Copy Group-link command" })
      .click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Select the command",
    );
    await shot(page, "copy-error");
    state.expiresAt = new Date(0).toISOString();
    await dialog(page)
      .getByRole("button", { name: "Generate new command" })
      .click();
    await complete(state, `/link@fixture_bot ${"b".repeat(43)}`);
    await expect(dialog(page)).toContainText("This command expired.");
    await expect(
      dialog(page).getByRole("button", { name: "Copy Group-link command" }),
    ).toBeDisabled();
    await expect(dialog(page).locator("code")).toHaveCount(0);
    await shot(page, "expired");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Link a group", exact: true }),
    ).toBeFocused();
    const issued = state.issued.length;
    if (width < 900)
      await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page
      .locator(`[role="menuitemradio"][data-workspace-id="${second}"]`)
      .click();
    await expect(
      page.getByRole("dialog", { name: "Navigation", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "No group linked" }),
    ).toBeVisible();
    expect(state.issued).toHaveLength(issued);
    await expect(
      page.locator("code").filter({ hasText: /^\/link@/ }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Link a group", exact: true })
      .click();
    await expect
      .poll(() => state.issued.at(-1))
      .toBe(`/api/admin/workspaces/${second}/chats/link-token`);
    state.expiresAt = new Date(Date.now() + 600000).toISOString();
    await complete(state);
  });
  test(`group loading and failed-load recovery retain the page layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const state = await fixture(page);
    state.deferList = true;
    await page.goto(`/admin/chats?workspace=${first}`);
    await expect(
      page.getByRole("heading", { name: "Groups & Members", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Link a group", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "No group linked" }),
    ).toHaveCount(0);
    await shot(page, "loading");
    await expect.poll(() => state.lists.length).toBe(1);
    await state.lists
      .shift()
      ?.fulfill({ status: 503, json: { error: "Groups unavailable" } });
    await expect(page.getByRole("alert")).toContainText("Groups unavailable");
    await shot(page, "load-error");
    state.deferList = false;
    await page.getByRole("button", { name: "Retry loading groups" }).click();
    await expect(
      page.getByRole("heading", { name: "No group linked" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Link a group", exact: true }),
    ).toBeEnabled();
  });
}

test("groups beyond the first API page remain visible and can be relinked", async ({
  page,
}) => {
  const state = await fixture(page);
  state.linked = true;
  state.extraGroups = Array.from({ length: 100 }, (_, index) => ({
    id: String(-100200 - index),
    title: `Group ${index + 2}`,
    active: true,
    collection: false,
    visibleAll: false,
    linkedAt: state.linkedAt,
  }));
  await page.goto(`/admin/members?workspace=${first}`);
  await expect(page.locator(".group-row")).toHaveCount(101);
  expect(state.listOffsets).toEqual([0, 100]);
  await page.getByRole("button", { name: "Link a group", exact: true }).click();
  await complete(state);
  await expect(dialog(page).locator("code")).toHaveText(command);
  const last = state.extraGroups.at(-1);
  if (!last) throw new Error("Missing last group");
  last.linkedAt = "2026-10-26T01:00:00.000Z";
  await expect(dialog(page)).toContainText("Group linked.");
  await page.keyboard.press("Escape");
  await expect(page.locator(".group-row")).toHaveCount(101);
});
