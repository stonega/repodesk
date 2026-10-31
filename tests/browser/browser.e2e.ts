import { expect, type Page, test } from "@playwright/test";
import type { PluginPage } from "../../src/agent/plugin-config.ts";
import type { BrowserPluginPage } from "../../src/browser/config.ts";
import type { PersonalBrowserPage } from "../../src/browser/member.ts";

const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
async function adminFixture(page: Page) {
  const data: BrowserPluginPage = {
    revision: 0,
    settings: { enabled: true, generation: 0, previewOrigins: [] },
    serviceConfigured: false,
  };
  const files: PluginPage["entries"] = [];
  let saveError = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/plugins") && route.request().method() === "PUT") {
      files.splice(
        0,
        files.length,
        ...route
          .request()
          .postDataJSON()
          .entries.map((entry: object) => ({ ...entry, fileStatus: "ready" })),
      );
    }
    if (path.endsWith("/plugins/browser")) {
      if (route.request().method() === "PUT") {
        if (saveError)
          return route.fulfill({
            status: 409,
            json: { error: "version_conflict" },
          });
        Object.assign(data, {
          revision: data.revision + 1,
          settings: route.request().postDataJSON().settings,
        });
      }
      return route.fulfill({ json: data });
    }
    return route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspace, name: "Browser workspace" }]
              : path.endsWith("/plugins")
                ? {
                    revision: 0,
                    source: "empty",
                    entries: files,
                    workspaces: [{ id: workspace, name: "Browser workspace" }],
                    audit: [],
                  }
                : { providers: [] },
    });
  });
  return {
    data,
    files,
    fail: () => {
      saveError = true;
    },
  };
}
async function personalFixture(page: Page) {
  const data: PersonalBrowserPage = {
    workspace: "My workspace",
    enabled: true,
    configured: true,
    revision: 1,
    generation: 1,
    controller: { kind: "chat", expiresAt: Date.now() + 600000 },
    origins: ["https://accounts.example.com"],
    requests: [
      {
        id: "070f4007-59d0-48f5-9354-a398342357c0",
        kind: "site",
        consumer: "chat",
        task: "Read my dashboard",
        origin: "https://accounts.example.com",
        description: "Allow this task to use this site for 30 minutes.",
        state: "waiting",
        expiresAt: Date.now() + 600000,
      },
    ],
    input: {
      id: "070f4007-59d0-48f5-9354-a398342357c1",
      task: "Sign into my dashboard",
      consumer: "chat",
      label: "Account password",
      kind: "password",
      origin: "https://accounts.example.com",
      state: "waiting",
      expiresAt: Date.now() + 600000,
    },
  };
  const calls: { path: string; operation?: Record<string, unknown> }[] = [];
  const preview = await page.screenshot({ type: "jpeg" }),
    artifactId = "070f4007-59d0-48f5-9354-a398342357cc";
  let viewGate = Promise.resolve(),
    operateUnavailable = false;
  let fail = false,
    pending = Promise.resolve();
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    const handlers = new Map<string, Set<() => void>>();
    const app = {
      initData: "synthetic-signed-launch",
      colorScheme: "light",
      themeParams: {},
      isActive: true,
      viewportStableHeight: innerHeight,
      ready() {},
      expand() {},
      BackButton: { hide() {} },
      MainButton: { hide() {} },
      onEvent(name: string, fn: () => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)?.add(fn);
      },
      offEvent(name: string, fn: () => void) {
        handlers.get(name)?.delete(fn);
      },
    };
    Object.assign(window, {
      Telegram: { WebApp: app },
      browserTheme: (value: string) => {
        app.colorScheme = value;
        for (const fn of handlers.get("themeChanged") ?? []) fn();
      },
    });
  });
  await page.route("**/mini-api/browser/*", async (route) => {
    const path =
        new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
      body = route.request().postDataJSON();
    calls.push({ path, operation: body.operation });
    if (fail)
      return route.fulfill({ status: 403, json: { error: "access_denied" } });
    if (path === "view") {
      await viewGate;
      return route.fulfill({ json: data });
    }
    if (path === "operate" && operateUnavailable)
      return route.fulfill({
        status: 503,
        json: { error: "browser_service_unavailable" },
      });
    if (
      path === "operate" &&
      body.operation.command === "observe" &&
      body.operation.view === "screenshot"
    )
      return route.fulfill({
        json: {
          status: "completed",
          reference: artifactId,
          page: {
            id: "070f4007-59d0-48f5-9354-a398342357cd",
            revision: 1,
            origin: "https://accounts.example.com",
          },
        },
      });
    if (path === "operate" && body.operation.command === "artifact")
      return route.fulfill({
        json: {
          status: "completed",
          artifact: {
            id: artifactId,
            mimeType: "image/jpeg",
            name: "browser.jpg",
            data: preview.toString("base64"),
          },
        },
      });
    await pending;
    if (path === "input" && data.input) data.input.state = "completed";
    if (path === "decide" && data.requests[0])
      data.requests[0].state = body.operation.approve ? "approved" : "denied";
    if (path === "operate" && body.operation.command === "takeover") {
      data.controller = { kind: "human", expiresAt: Date.now() + 120000 };
      data.generation++;
    }
    return route.fulfill({ json: { status: "completed" } });
  });
  return {
    data,
    calls,
    unavailable: (value: boolean) => {
      operateUnavailable = value;
    },
    pauseView: () => {
      let release = () => {};
      viewGate = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
    fail: () => {
      fail = true;
    },
    pause: () => {
      let release = () => {};
      pending = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
  };
}

async function personalShots(page: Page, state: string) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (t) =>
        (
          window as unknown as { browserTheme: (v: string) => void }
        ).browserTheme(t),
      theme,
    );
    await page.screenshot({
      path: test.info().outputPath(`${state}-${theme}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
}

for (const width of [1280, 390]) {
  test(`Browser saved summary, modal editor, default and explicit disable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await adminFixture(page);
    await page.goto(`/admin/plugins?workspace=${workspace}`);
    await page.getByRole("link").filter({ hasText: "Browser" }).first().click();
    const toggle = page.getByRole("switch", { name: "Enable Browser" });
    await expect(toggle).toBeChecked();
    const config = page.getByRole("region", { name: "Browser configuration" });
    await expect(config.locator("input,textarea,select")).toHaveCount(0);
    await expect(config).toContainText("Not configured");
    const previews = page.getByRole("region", { name: "Local preview access" });
    await expect(previews.locator("input,textarea,select")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`summary-${theme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.getByRole("button", { name: "Edit local previews" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit local previews" });
    await dialog
      .getByRole("textbox", { name: "Allowed origins" })
      .fill("http://127.0.0.1:5173");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(previews).toContainText("http://127.0.0.1:5173");
    await expect(previews.locator("textarea")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await expect(toggle).not.toBeChecked();
    expect(f.data.settings.enabled).toBe(false);
    f.fail();
    await toggle.click();
    await expect(page.getByRole("alert")).toContainText(
      "changed in another session",
    );
    await expect(toggle).not.toBeChecked();
  });
  test(`File plugin Browser access stays in its editor and saved summary at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await adminFixture(page);
    f.files.push({
      id: "browser-helper",
      path: "/extensions/helper.mjs",
      version: "1",
      enabled: true,
      execution: "read-only",
      tools: ["private_browser_helper"],
      workspaces: [workspace],
      fileStatus: "ready",
    });
    await page.goto(
      `/admin/plugins/file/browser-helper?workspace=${workspace}`,
    );
    const card = page.getByRole("region", { name: "Plugin browser-helper" });
    await expect(card.getByText("Not granted", { exact: true })).toBeVisible();
    await expect(card.locator("input,textarea,select")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit browser-helper" }).click();
    const dialog = page.getByRole("dialog");
    const checkbox = dialog.getByRole("checkbox", {
      name: /Allow this plugin to request/,
    });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.screenshot({
        path: test.info().outputPath(`permission-${theme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await dialog
      .getByRole("button", { name: "Save plugin", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(card).toContainText("Granted · member approvals required");
    await expect(card.locator("input,textarea,select")).toHaveCount(0);
  });
  test(`Personal Browser loading, unavailable, empty and expired states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await personalFixture(page),
      release = f.pauseView();
    const previousInput = f.data.input,
      previousRequests = f.data.requests;
    await page.goto(
      `/mini?tgWebAppStartParam=browser_${workspace.replaceAll("-", "")}`,
    );
    await expect(
      page.getByRole("heading", { name: "My browser" }),
    ).toBeVisible();
    await expect(page.getByText("Checking your browser…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "View browser" }),
    ).toBeDisabled();
    await personalShots(page, "loading");
    f.data.enabled = false;
    f.data.configured = false;
    f.data.requests = [];
    delete f.data.input;
    delete f.data.controller;
    release();
    await expect(
      page.getByText("Not configured", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/No requests. Ask the bot/)).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (t) =>
          (
            window as unknown as { browserTheme: (v: string) => void }
          ).browserTheme(t),
        theme,
      );
      await page.screenshot({
        path: test.info().outputPath(`empty-${theme}.png`),
        fullPage: true,
      });
    }
    f.data.enabled = true;
    f.data.configured = true;
    f.data.input = previousInput
      ? { ...previousInput, state: "expired" }
      : undefined;
    f.data.requests = previousRequests.map((request) => ({
      ...request,
      state: "expired",
    }));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page.getByText("Request expired. No value is shown here."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Apply securely" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(0);
    await personalShots(page, "expired");
    f.unavailable(true);
    await page.getByRole("button", { name: "View browser" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "host browser service is unavailable",
    );
    await personalShots(page, "unavailable");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText(
      "host browser service is unavailable",
    );
    f.unavailable(false);
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
  test(`Personal Browser screenshots bind manual controls and clear after revocation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await personalFixture(page);
    f.data.controller = { kind: "human", expiresAt: Date.now() + 120000 };
    delete f.data.input;
    f.data.requests = [];
    await page.goto(
      `/mini?tgWebAppStartParam=browser_${workspace.replaceAll("-", "")}`,
    );
    await expect(
      page.getByRole("button", { name: "Return control" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tab", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "View browser" }).click();
    await expect(
      page.getByRole("img", {
        name: "Private browser screenshot with input fields masked",
      }),
    ).toBeVisible();
    await personalShots(page, "control");
    await page.getByRole("button", { name: "Tab", exact: true }).click();
    await expect
      .poll(
        () => f.calls.filter((c) => c.operation?.command === "action").length,
      )
      .toBe(1);
    const command = f.calls.find(
      (c) => c.operation?.command === "action",
    )?.operation;
    expect(command?.page).toMatchObject({
      revision: 1,
      origin: "https://accounts.example.com",
    });
    await personalShots(page, "manual-controls");
    f.fail();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText(
      "no longer have access",
    );
    await expect(
      page.getByRole("img", {
        name: "Private browser screenshot with input fields masked",
      }),
    ).toHaveCount(0);
  });
  test(`Personal browser secure input, pending, approval and isolation recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const f = await personalFixture(page);
    await page.goto(
      `/mini?tgWebAppStartParam=browser_${workspace.replaceAll("-", "")}`,
    );
    await expect(
      page.getByRole("heading", { name: "My browser" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();
    const field = page.getByLabel("Password", { exact: true });
    await expect(field).toHaveAttribute("type", "password");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (t) =>
          (
            window as unknown as { browserTheme: (v: string) => void }
          ).browserTheme(t),
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({
        path: test.info().outputPath(`personal-${theme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    const release = f.pause();
    await field.fill("synthetic-password-fixture");
    await page.getByRole("button", { name: "Apply securely" }).click();
    await expect(field).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Submitting…" }),
    ).toBeDisabled();
    await personalShots(page, "pending");
    expect(f.calls.filter((c) => c.path === "input")).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain("synthetic-password-fixture");
    release();
    await expect(
      page
        .getByText("Input applied. Your task will continue.", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      page.getByText("Approved · waiting for the task"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Take control", exact: true })
      .click();
    await personalShots(page, "confirmation");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Return control" }),
    ).toBeVisible();
    f.fail();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText(
      "no longer have access",
    );
    await expect(
      page.getByText("accounts.example.com", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete profile" }),
    ).toHaveCount(0);
  });
}
