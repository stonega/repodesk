import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CodeTruthPage } from "../../src/code-truth/config.ts";
import type { CodingPage } from "../../src/coding/config.ts";
import { settingsSchema } from "../../src/domain.ts";
import type { ReviewPage } from "../../src/review-bot/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const name = `example/${"long-repository-name-".repeat(4)}`;
const repositories = Array.from({ length: 7 }, (_, index) => ({
  id: index + 1,
  full_name: index === 0 ? name : `example/repository-${index + 1}`,
  permissions: { pull: true, push: true, admin: index === 0 },
}));

async function fixture(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => {
    localStorage.setItem("repodesk.theme", value);
  }, theme);
  const coding: CodingPage = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
      repositories: [
        { repositoryId: 1, baseBranch: "main", maintainers: ["101"] },
      ],
    },
    repositories,
    members: [{ id: "101", active: true, username: "maintainer" }],
    tasks: [],
    providerApiKeyConfigured: true,
    legacyActionsConfiguration: false,
  };
  const review: ReviewPage = {
    revision: 1,
    settings: {
      enabled: true,
      repositories: [
        {
          repositoryId: 1,
          reviewer: "101",
          autoReview: true,
          acceptRequests: true,
          allowFixes: false,
        },
      ],
    },
    repositories: [
      {
        id: 1,
        full_name: name,
        maintainers: [{ id: "101", name: "Maintainer" }],
      },
    ],
    tasks: [],
    webhookUrl: "https://example.com/github/webhook/operator",
    webhookConfigured: true,
  };
  const truth: CodeTruthPage = {
    revision: 1,
    settings: {
      enabled: true,
      repositories: [
        {
          id: "source",
          repositoryUrl: `https://github.com/${name}.git`,
          networks: { main: "main", testnet: "testnet-develop" },
          workspaces: [workspaceId],
        },
      ],
    },
    serviceConfigured: true,
    workspaces: [{ id: workspaceId, name: "Repository cards" }],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe("GET");
    const json =
      path === "/api/setup/status"
        ? { initialized: true }
        : path === "/api/admin/auth/session"
          ? {
              admin: { id: "operator", username: "fixture", operator: true },
              csrf: "test",
            }
          : path === "/api/admin/workspaces"
            ? [{ id: workspaceId, name: "Repository cards" }]
            : path.endsWith("/members")
              ? {
                  version: 1,
                  total: 1,
                  items: [
                    {
                      id: "101",
                      name: "Maintainer",
                      role: "member",
                      active: true,
                      github: {
                        id: 42,
                        login: "example",
                        status: "connected",
                        connectionRevision: 1,
                        syncedAt: "2026-10-08T09:54:57Z",
                        repositories,
                      },
                    },
                  ],
                }
              : path.endsWith("/access-requests")
                ? {
                    version: 1,
                    items: [],
                    requestUrl: "https://t.me/fixture_bot",
                  }
                : path.endsWith("/overview")
                  ? {
                      version: 1,
                      settings: settingsSchema.parse({
                        name: "Repository cards",
                        timezone: "UTC",
                      }),
                      counts: {
                        members: 1,
                        runs: 0,
                        workflows: 0,
                        codingTasks: 0,
                      },
                      connections: {
                        bot: { configured: false },
                        github: {
                          connected: true,
                          account: "example",
                          repositories: 7,
                        },
                      },
                    }
                  : path.endsWith("/github")
                    ? {
                        configured: true,
                        revision: 1,
                        pending: false,
                        installations: [],
                        connection: {
                          revision: 1,
                          installationId: 501,
                          account: "example",
                          connectedBy: "fixture",
                          repositories,
                        },
                      }
                    : path.endsWith("/plugins/coding")
                      ? coding
                      : path.endsWith("/plugins/review-bot")
                        ? review
                        : path.endsWith("/plugins/code-truth")
                          ? truth
                          : {};
    await route.fulfill({ json });
  });
}

async function appearance(card: Locator) {
  return card.evaluate((element) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector(".repository-card-name");
    if (!heading) throw new Error("Repository card name is missing");
    const title = getComputedStyle(heading);
    return {
      surface: style.backgroundColor,
      border: style.borderTop,
      radius: style.borderRadius,
      size: title.fontSize,
      weight: title.fontWeight,
    };
  });
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`repository cards share their style and retain saved details at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page, theme);
      await page.goto(`/admin/members?workspace=${workspaceId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const preview = page.getByRole("list", { name: "Repository access" });
      await expect(preview.getByRole("article")).toHaveCount(5);
      const reference = await appearance(preview.getByRole("article").first());
      await preview.getByRole("article").first().scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/repodesk-repository-cards-members-${width}-${theme}.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Show all 7 repositories for example" })
        .click();
      const memberDialog = page.getByRole("dialog", {
        name: "example repositories",
      });
      await expect(memberDialog.getByRole("article")).toHaveCount(7);
      expect(
        await appearance(memberDialog.getByRole("article").first()),
      ).toEqual(reference);
      await page.screenshot({
        path: `/tmp/repodesk-repository-cards-member-modal-${width}-${theme}.png`,
      });
      await page.keyboard.press("Escape");
      await page.goto(`/admin/overview?workspace=${workspaceId}`);
      await page.getByRole("button", { name: "Manage GitHub" }).click();
      const github = page.getByRole("dialog", { name: "Manage GitHub" });
      await expect(github.getByRole("article")).toHaveCount(5);
      expect(await appearance(github.getByRole("article").first())).toEqual(
        reference,
      );
      await github.getByRole("button", { name: "2 more" }).click();
      await expect(github.getByRole("article")).toHaveCount(7);
      await page.screenshot({
        path: `/tmp/repodesk-repository-cards-github-${width}-${theme}.png`,
      });
      await page.keyboard.press("Escape");

      for (const [route, label, detail, edit, editor] of [
        [
          "codex",
          name,
          "Maintainers: 101",
          "Edit coding repository 1",
          "Edit coding repository",
        ],
        [
          "review-bot",
          name,
          "Automatic review owner",
          `Edit ${name}`,
          "Edit Review Bot repository",
        ],
        [
          "code-truth",
          "Repository 1",
          "testnet → testnet-develop",
          "Edit repository 1",
          "Edit repository source",
        ],
      ] as const) {
        await page.goto(`/admin/plugins/${route}?workspace=${workspaceId}`);
        const card = page.getByRole("article", { name: label, exact: true });
        await expect(card).toContainText(detail);
        await expect(card.locator("input, select, textarea")).toHaveCount(0);
        expect(await appearance(card)).toEqual(reference);
        const link = card.getByRole("link");
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        expect(
          await link.evaluate(
            (element) =>
              element.getBoundingClientRect().width >= 44 &&
              element.getBoundingClientRect().height >= 44,
          ),
        ).toBe(true);
        await card.scrollIntoViewIfNeeded();
        expect(
          await card.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `/tmp/repodesk-repository-cards-${route}-${width}-${theme}.png`,
          fullPage: true,
        });
        await card.getByRole("button", { name: edit, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: editor, exact: true });
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        await expect(card).toContainText(detail);
      }
    });
  }
}
