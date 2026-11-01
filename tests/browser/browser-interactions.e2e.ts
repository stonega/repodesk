import { expect, type Page, test } from "@playwright/test";
import { HeadedBrowser } from "../../src/browser/host-page.ts";

const origin = "https://routine.example";
async function fixture(page: Page) {
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") submissions++;
    await route.fulfill({
      contentType: "text/html",
      body: `
      <form action="/send" method="POST">
        <input id="query" name="query"><input id="password" type="password">
        <textarea id="draft"></textarea><button id="send" type="submit">Send</button>
      </form>
      <a id="next" href="/next" onclick="fetch('/send',{method:'POST'})">Next</a>
      <a id="delete" href="/delete">Delete</a>
      <button id="unknown" type="button">Unknown action</button>
    `,
    });
  });
  await page.goto(`${origin}/account`);
  const native = new HeadedBrowser({
    home: "/unused",
    executable: "/unused",
    env: {},
    proxy: { server: "", username: "", password: "" },
  });
  // Attach the deterministic test page to the actual interaction engine. Headed
  // launch/display/network isolation are covered by the separate host smoke.
  Object.assign(native, { context: page.context() });
  (native as unknown as { addPage(page: Page): void }).addPage(page);
  native.setPolicy({
    origins: [origin],
    previewOrigins: [],
    routineOrigins: [origin],
    interact: false,
  });
  return { native, submissions: () => submissions };
}

test("remembered websites allow native navigation, ordinary fills and focus without executing link handlers", async ({
  page,
}) => {
  const { native, submissions } = await fixture(page);
  const fill = { action: "fill" as const, selector: "#query", text: "report" };
  const review = await native.execute({ command: "review", input: fill });
  expect(review.approvalRequired).toBe(false);
  await native.execute({ command: "action", input: fill, page: review.page });
  await expect(page.locator("#query")).toHaveValue("report");
  await native.execute({
    command: "action",
    input: { action: "press", key: "Tab" },
  });
  await expect(page.locator("#password")).toBeFocused();
  const click = { action: "click" as const, selector: "#next" };
  expect(
    (await native.execute({ command: "review", input: click }))
      .approvalRequired,
  ).toBe(false);
  await native.execute({ command: "action", input: click });
  await expect(page).toHaveURL(`${origin}/next`);
  expect(submissions()).toBe(0);
});

test("submissions, uncertain controls, sensitive fields and explicit external effects remain gated", async ({
  page,
}) => {
  const { native, submissions } = await fixture(page);
  const submission = { action: "click" as const, selector: "#send" };
  const actions = [
    submission,
    { action: "click" as const, selector: "#unknown" },
    { action: "click" as const, selector: "#delete" },
    { action: "press" as const, key: "Enter" as const },
    { action: "pointer" as const, x: 10, y: 10 },
    { action: "fill" as const, selector: "#password", text: "never-applied" },
    {
      action: "fill" as const,
      selector: "#draft",
      text: "auto-saved change",
      requireApproval: true as const,
    },
  ];
  for (const input of actions) {
    expect(
      (await native.execute({ command: "review", input })).approvalRequired,
    ).toBe(true);
    await expect(native.execute({ command: "action", input })).rejects.toThrow(
      "browser_action_approval_required",
    );
  }
  expect(submissions()).toBe(0);
  await expect(page.locator("#password")).toHaveValue("");
  await expect(page.locator("#draft")).toHaveValue("");
  const review = await native.execute({
    command: "review",
    input: submission,
  });
  native.setPolicy({ origins: [origin], previewOrigins: [], interact: true });
  await native.execute({
    command: "action",
    input: submission,
    page: review.page,
  });
  expect(submissions()).toBe(1);
});

test("revocation and page changes fence previously inspected routine actions", async ({
  page,
}) => {
  const { native } = await fixture(page);
  const input = { action: "fill" as const, selector: "#query", text: "stale" };
  const review = await native.execute({ command: "review", input });
  await page.goto(`${origin}/changed`);
  await expect(
    native.execute({ command: "action", input, page: review.page }),
  ).rejects.toThrow("browser_page_changed");
  native.setPolicy({ origins: [origin], previewOrigins: [], interact: false });
  expect(
    (await native.execute({ command: "review", input })).approvalRequired,
  ).toBe(true);
  await expect(native.execute({ command: "action", input })).rejects.toThrow(
    "browser_action_approval_required",
  );
  await expect(page.locator("#query")).toHaveValue("");
});
