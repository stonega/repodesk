import { expect, type Page, type Route, test } from "@playwright/test";
import type {
  ThreadDetail,
  ThreadSummary,
} from "../../src/admin/thread-history.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const threadId = "ec6c2304-061b-4271-9988-c71e56dce8ed";
const runId = "5f6f6dbf-25df-4a05-8d75-f2669c35572f";
const missingId = "93a458e2-f3a4-4b5b-8b21-51453078a7be";
const base = `/api/admin/workspaces/${workspaceId}`;
const listUrl = `/admin/threads?workspace=${workspaceId}&offset=0`;
const detailUrl = `/admin/threads/${threadId}?workspace=${workspaceId}&listOffset=0`;
const alice = { id: "101", name: "Alice Stone", username: "alice" };
const bob = { id: "202", name: "Bob Chen", username: "bob" };
const thread: ThreadSummary = {
  id: threadId,
  kind: "group",
  title: "Investigate the repository build",
  preview: "Can we check the deployment too?",
  at: "2026-10-17T10:00:00Z",
  updatedAt: "2026-10-17T10:02:00Z",
  status: "running",
  requestCount: 3,
  user: alice,
  group: {
    id: "-100100",
    title: "RepoDesk Engineering — platform discussions",
  },
  topicId: 7,
  participants: [alice, bob],
  participantCount: 2,
};
const statistics: ThreadDetail["statistics"] = {
  messages: 5,
  toolCalls: 2,
  attempts: 3,
  tokenAttempts: 2,
  costAttempts: 2,
  tokens: { input: 200, output: 100, cacheRead: 600, cacheWrite: 200 },
  input: 1000,
  totalTokens: 1100,
  cacheHitRate: 0.6,
  cost: 0.02,
};
const turns: ThreadDetail["items"] = [
  {
    id: runId,
    user: alice,
    task: "Investigate the repository build",
    result: "The build needs a dependency update.",
    status: "succeeded",
    at: thread.at,
    model: "fixture",
  },
  {
    id: "92d45021-6d33-427f-b530-c0ca2d632e27",
    user: bob,
    task: "Which dependency should we update?",
    result: "Update the build helper to the pinned version.",
    status: "succeeded",
    at: "2026-10-17T10:01:00Z",
    model: "fixture",
  },
  {
    id: "843c9608-3049-4e1f-b39c-a1d72551b4bc",
    user: alice,
    task: "Can we check the deployment too?",
    status: "running",
    at: thread.updatedAt,
    model: "fixture",
  },
];

async function fixture(
  page: Page,
  options: {
    mode?: "member" | "operator";
    list?: (route: Route) => Promise<void>;
    detail?: (route: Route) => Promise<void>;
  } = {},
) {
  const mode = options.mode ?? "operator";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${base}/threads` && options.list) return options.list(route);
    if (path === `${base}/threads/${threadId}` && options.detail)
      return options.detail(route);
    if (path === `${base}/threads/${missingId}`)
      return route.fulfill({ status: 404, json: { error: "not_found" } });
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: {
                id: "operator",
                username: "fixture",
                operator: true,
                ...(mode === "member" ? { telegramId: "101" } : {}),
              },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Thread fixture" }]
            : path === `${base}/threads`
              ? { mode, total: 1, offset: 0, limit: 25, items: [thread] }
              : path === `${base}/threads/${threadId}`
                ? {
                    mode,
                    thread,
                    statistics,
                    total: 3,
                    offset: 0,
                    limit: 25,
                    items: turns,
                  }
                : path === `${base}/runs/${runId}`
                  ? {
                      mode,
                      threadId,
                      run: {
                        id: runId,
                        actor: "101",
                        at: thread.at,
                        model: "fixture",
                        status: "succeeded",
                        task: turns[0]?.task,
                        result: turns[0]?.result,
                        instructions: [],
                        skillPins: [],
                        transcript: [],
                        tools: {},
                        attempts: [],
                        deliveries: [],
                      },
                    }
                  : {};
    await route.fulfill({ json });
  });
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/threads-${name}.png`,
    fullPage: true,
  });
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`threads show continuous chats, Telegram identities and individual diagnostics at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      let detailRequests = 0;
      await fixture(page, {
        mode: width === 1280 ? "member" : "operator",
        detail: async (route) => {
          detailRequests++;
          await route.fulfill({
            json: {
              mode: "operator",
              thread,
              statistics,
              total: 3,
              offset: 0,
              limit: 25,
              items: turns,
            },
          });
        },
      });
      await page.goto(listUrl);
      const card = page.locator(".thread-card");
      await expect(card).toHaveCount(1);
      for (const value of [
        thread.group?.title ?? "",
        "ID -100100",
        "Topic 7",
        "Alice Stone",
        "@alice",
        "ID 101",
        "Bob Chen",
        "@bob",
        "3 requests",
      ])
        await expect(card).toContainText(value);
      await expect(
        page.getByText(turns[1]?.task ?? "", { exact: true }),
      ).toHaveCount(0);
      expect(detailRequests).toBe(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await screenshot(page, `list-${width}-${theme}`);
      await card.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(detailUrl);
      const conversation = page.getByRole("region", {
        name: "Conversation",
        exact: true,
      });
      await expect(conversation.locator(".thread-turn")).toHaveCount(3);
      await expect(conversation.locator(".thread-turn .prose")).toHaveText([
        turns[0]?.task ?? "",
        turns[0]?.result ?? "",
        turns[1]?.task ?? "",
        turns[1]?.result ?? "",
        turns[2]?.task ?? "",
      ]);
      await expect(conversation).toContainText("Working on a reply…");
      const identity = page.getByRole("region", {
        name: "Telegram conversation",
      });
      await expect(
        identity.getByRole("link", { name: "@alice" }),
      ).toHaveAttribute("href", "https://t.me/alice");
      const stats = page.getByRole("region", { name: "Thread statistics" });
      await expect(stats).toContainText("1,100");
      await expect(stats).toContainText("60%");
      await expect(stats).toContainText("2 of 3 attempts reported");
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await screenshot(page, `detail-${width}-${theme}`);
      await conversation
        .getByRole("link", { name: "Run details", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("region", { name: "Run statistics" }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Back to thread", exact: true })
        .click();
      await expect(conversation.locator(".thread-turn")).toHaveCount(3);
      await page.reload();
      await expect(conversation.locator(".thread-turn")).toHaveCount(3);
      await page.getByRole("link", { name: "Back to Threads" }).click();
      await expect(page).toHaveURL(listUrl);
      await page.goBack();
      await expect(conversation.locator(".thread-turn")).toHaveCount(3);
    });
  }

  test(`thread list pagination survives detail, run and back navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const offsets: number[] = [];
    await fixture(page, {
      list: async (route) => {
        const params = new URL(route.request().url()).searchParams;
        expect(params.get("limit")).toBe("25");
        const offset = Number(params.get("offset"));
        offsets.push(offset);
        await route.fulfill({
          json: {
            mode: "operator",
            total: 26,
            offset,
            limit: 25,
            items:
              offset === 0
                ? Array.from({ length: 25 }, (_, i) => ({
                    ...thread,
                    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
                  }))
                : [thread],
          },
        });
      },
    });
    await page.goto(listUrl);
    await expect(page.locator(".thread-card")).toHaveCount(25);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".thread-card")).toHaveCount(1);
    await expect(
      page.getByRole("navigation", { name: "Pagination" }),
    ).toContainText("26–26 of 26");
    await page.locator(".thread-card").click();
    await page.getByRole("link", { name: "Run details" }).first().click();
    await page
      .getByRole("link", { name: "Back to thread", exact: true })
      .click();
    await page.getByRole("link", { name: "Back to Threads" }).click();
    await expect(page).toHaveURL(
      `/admin/threads?workspace=${workspaceId}&offset=25`,
    );
    await expect(
      page.getByRole("navigation", { name: "Pagination" }),
    ).toContainText("26–26 of 26");
    await page.reload();
    await expect(page.locator(".thread-card")).toHaveCount(1);
    expect(offsets).toEqual([0, 25, 25, 25]);
  });

  test(`thread list keeps labels through loading, retry, empty and out-of-range pages at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let held: Route | undefined;
    let ready = false;
    await fixture(page, {
      list: async (route) => {
        if (!ready) {
          held = route;
          return;
        }
        const offset = Number(
          new URL(route.request().url()).searchParams.get("offset"),
        );
        await route.fulfill({
          json: {
            mode: "operator",
            total: offset ? 3 : 0,
            offset,
            limit: 25,
            items: [],
          },
        });
      },
    });
    await page.goto(listUrl);
    await expect(
      page.getByRole("heading", { name: "Threads", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Threads", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => !!held).toBe(true);
    await screenshot(page, `list-loading-${width}`);
    await held?.fulfill({
      status: 503,
      json: { error: "temporarily_unavailable" },
    });
    await expect(page.getByRole("alert")).toContainText(
      "temporarily_unavailable",
    );
    await screenshot(page, `list-error-${width}`);
    ready = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("No conversations yet.")).toBeVisible();
    await screenshot(page, `list-empty-${width}`);
    await page.goto(`/admin/threads?workspace=${workspaceId}&offset=100`);
    await expect(
      page.getByText("No threads on this page.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Previous page" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });

  test(`thread details load independently, recover and discard a missing thread's previous messages at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let held: Route | undefined;
    let ready = false;
    await fixture(page, {
      detail: async (route) => {
        if (!ready) {
          held = route;
          return;
        }
        await route.fulfill({
          json: {
            mode: "operator",
            thread,
            statistics,
            total: 3,
            offset: 0,
            limit: 25,
            items: turns,
          },
        });
      },
    });
    await page.goto(detailUrl);
    await expect(
      page.getByRole("heading", { name: "Telegram conversation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Thread statistics" }),
    ).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => !!held).toBe(true);
    await screenshot(page, `detail-loading-${width}`);
    await held?.fulfill({
      status: 503,
      json: { error: "temporarily_unavailable" },
    });
    await expect(page.getByRole("alert")).toContainText(
      "temporarily_unavailable",
    );
    await screenshot(page, `detail-error-${width}`);
    ready = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".thread-turn")).toHaveCount(3);
    await page.evaluate((href) => {
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/admin/threads/${missingId}?workspace=${workspaceId}`);
    await expect(page.getByRole("alert")).toContainText(
      "This thread is unavailable in this workspace",
    );
    await expect(page.locator(".thread-turn")).toHaveCount(0);
    await expect(page.getByText(alice.name, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Back to Threads" }),
    ).toBeVisible();
  });
}

test("thread request pages preserve chronology and totals while keeping parent pagination", async ({
  page,
}) => {
  const all = Array.from({ length: 27 }, (_, index) => ({
    ...turns[0],
    id:
      index === 25
        ? runId
        : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    task: `Request ${index + 1}`,
  }));
  await fixture(page, {
    detail: async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const offset = Number(params.get("offset"));
      expect(params.get("limit")).toBe("25");
      await route.fulfill({
        json: {
          mode: "operator",
          thread: { ...thread, requestCount: 27 },
          statistics: { ...statistics, messages: 54 },
          total: 27,
          offset,
          limit: 25,
          items: all.slice(offset, offset + 25),
        },
      });
    },
  });
  await page.goto(detailUrl.replace("listOffset=0", "listOffset=25"));
  await expect(page.locator(".thread-turn")).toHaveCount(25);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.locator(".thread-turn")).toHaveCount(2);
  await expect(page.locator(".thread-turn > .prose")).toHaveText([
    "Request 26",
    "Request 27",
  ]);
  await expect(
    page.getByRole("region", { name: "Thread statistics" }),
  ).toContainText("54");
  await page.getByRole("link", { name: "Run details" }).first().click();
  await page.getByRole("link", { name: "Back to thread", exact: true }).click();
  await expect(page.locator(".thread-turn > .prose")).toHaveText([
    "Request 26",
    "Request 27",
  ]);
  await expect(page).toHaveURL(
    `/admin/threads/${threadId}?workspace=${workspaceId}&offset=25&listOffset=25`,
  );
});

test("legacy run-list links redirect to Threads and unknown Telegram profiles retain their IDs", async ({
  page,
}) => {
  await fixture(page, {
    list: async (route) =>
      route.fulfill({
        json: {
          mode: "operator",
          total: 1,
          offset: 25,
          limit: 25,
          items: [
            {
              ...thread,
              kind: "standalone",
              group: undefined,
              user: { id: "303" },
              participants: [{ id: "303" }],
              participantCount: 1,
            },
          ],
        },
      }),
  });
  await page.goto(`/admin/runs?workspace=${workspaceId}&offset=25`);
  await expect(page).toHaveURL(
    `/admin/threads?workspace=${workspaceId}&offset=25`,
  );
  await expect(page.locator(".thread-card")).toContainText("Private chat");
  await expect(page.locator(".thread-card")).toContainText("Telegram user");
  await expect(page.locator(".thread-card")).toContainText("ID 303");
  await expect(page.locator(".thread-card")).toContainText(
    "Standalone request",
  );
});
