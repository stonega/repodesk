import { expect, type Page, type Route, test } from "@playwright/test";

const first = "b6e6d846-06b0-46ee-ac0c-47b617d17dcc";
const second = "48cfa12b-ae0b-4eb0-a8ee-b5cc10eb89ae";
const command = `/link@fixture_bot ${"a".repeat(43)}`;
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Link a group" });
async function fixture(page: Page) {
  const state = {
    linked: false,
    collection: false,
    visibleAll: false,
    deferList: false,
    failList: false,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    pending: [] as Route[],
    lists: [] as Route[],
    issued: [] as string[],
    actions: [] as string[],
    pendingActions: [] as Route[],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chats/-100100/action")) {
      expect(path).toBe(`/api/admin/workspaces/${first}/chats/-100100/action`);
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
      state.actions.push(route.request().postDataJSON().action);
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
      await route.fulfill({
        json: {
          items: state.linked
            ? [
                {
                  id: "-100100",
                  title: "Fixture group",
                  active: true,
                  visibleAll: state.visibleAll,
                  collection: state.collection,
                },
              ]
            : [],
          total: state.linked ? 1 : 0,
          offset: 0,
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
  const overflow = await page
    .locator(
      ".group-link-details, .group-link-details > *, .modal-fields, .group-access-card, .group-access-card > *",
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
      const card = page.locator(".group-access-card");
      const collection = card.getByRole("button").nth(1);
      await expect(card.getByRole("button")).toHaveCount(3);
      await expect(
        card.getByRole("button", {
          name: /Consent to collection|Directed messages only/,
        }),
      ).toHaveCount(0);
      await expect(card.locator("input, select, textarea")).toHaveCount(0);
      for (const enabled of [false, true]) {
        const label = enabled
          ? "Disable message collection"
          : "Enable message collection";
        const status = `Collection: ${enabled ? "enabled" : "directed only"}`;
        const action = enabled ? "directed" : "collect";
        await expect(collection).toHaveText(label);
        await expect(card).toContainText(status);
        await shot(
          page,
          enabled ? "collection-enabled" : "collection-disabled",
        );
        await collection.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => state.pendingActions.length).toBe(1);
        expect(state.actions.at(-1)).toBe(action);
        await expect(collection).toHaveText("Working…");
        await expect(collection).toBeDisabled();
        await page.keyboard.press("Enter");
        expect(state.pendingActions).toHaveLength(1);
        await expect(card).toContainText(status);
        await shot(page, `collection-${action}-pending`);
        await state.pendingActions.shift()?.fulfill({
          status: 503,
          json: { error: "Collection update failed" },
        });
        await expect(page.getByRole("alert")).toContainText(
          "Collection update failed",
        );
        await expect(collection).toHaveText(label);
        await expect(collection).toBeEnabled();
        await expect(card).toContainText(status);
        await shot(page, `collection-${action}-error`);
        await collection.click();
        await expect.poll(() => state.pendingActions.length).toBe(1);
        state.collection = !enabled;
        state.deferList = true;
        await state.pendingActions.shift()?.fulfill({ json: { ok: true } });
        await expect.poll(() => state.lists.length).toBe(1);
        await expect(collection).toBeDisabled();
        await expect(card).toContainText(status);
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
        await card
          .getByRole("button", { name: "Recheck bot visibility" })
          .focus();
        await page.keyboard.press("Tab");
        await expect(collection).toBeFocused();
        await expect(card.getByRole("button")).toHaveCount(3);
        await expect(page.getByRole("alert")).toHaveCount(0);
        await page.reload();
        await expect(collection).toHaveText(
          enabled ? "Enable message collection" : "Disable message collection",
        );
      }
      expect(state.actions).toEqual([
        "collect",
        "collect",
        "directed",
        "directed",
      ]);
      const spacing = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const first = element.firstElementChild;
        const last = element.lastElementChild;
        if (!first || !last) throw new Error("Saved group content is missing");
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
        page.locator("main input, main select, main textarea"),
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
      await expect(dialog(page)).toContainText("Group linked.");
      await expect(dialog(page).locator("code")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(start).toBeDisabled();
      await expect(
        page.getByRole("heading", { name: "Fixture group" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Recheck bot visibility" }),
      ).toBeFocused();
      await expect(
        page.locator("main input, main select, main textarea"),
      ).toHaveCount(0);
      await shot(page, "linked");
    });
  }
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
    await expect(page.locator("code")).toHaveCount(0);
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
      page.getByRole("heading", { name: "Group access", exact: true }),
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
