import { expect, type Page, test } from "@playwright/test";
import type { ModelUsageAnalyticsResponse } from "../../src/usage/model-usage.ts";
import { chooseOption } from "./dropdown-helpers.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";

function sampleAnalytics(
  filters: {
    range?: string;
    source?: string;
    model?: string;
    status?: string;
  } = {},
): ModelUsageAnalyticsResponse {
  const allItems: ModelUsageAnalyticsResponse["items"] = [
    {
      id: "run:run-1:att-1",
      recordedAt: "2026-11-21T07:20:00.000Z",
      sourceKind: "chat",
      sourceKindLabel: "Chat",
      sourceId: "run-1",
      sourceLabel: "Group · Engineering",
      sourcePath: "/admin/runs/run-1",
      actor: "202",
      actorLabel: "@alice",
      providerId: "prov-1",
      providerName: "OpenAI Prod",
      model: "gpt-4.1-mini",
      status: "settled",
      stopReason: "stop",
      inputTokens: 4200,
      cacheReadTokens: 8600,
      cacheWriteTokens: 0,
      outputTokens: 950,
      reasoningTokens: 0,
      totalTokens: 13750,
      estimatedInputTokens: 12500,
      tokenBreakdownKnown: true,
      cacheHitRate: 8600 / 12800,
      reservedUsd: 0.012,
      actualUsd: 0.0052,
      accountedUsd: 0.0052,
      pricingUnknown: false,
      latencyMs: 1120,
      toolCalls: 2,
      metadata: { runId: "run-1", chatScope: "group" },
    },
    {
      id: "coding:task-9:att-9",
      recordedAt: "2026-11-21T06:40:00.000Z",
      sourceKind: "coding_task",
      sourceKindLabel: "Codex task",
      sourceId: "task-9",
      sourceLabel: "Codex · acme/api",
      sourcePath: "/admin/plugins/codex",
      actor: "101",
      actorLabel: "@owner",
      providerId: "prov-1",
      providerName: "OpenAI Prod",
      model: "gpt-4.1",
      status: "settled",
      stopReason: "stop",
      inputTokens: 9000,
      cacheReadTokens: 14000,
      cacheWriteTokens: 1000,
      outputTokens: 3200,
      reasoningTokens: 640,
      totalTokens: 27200,
      estimatedInputTokens: null,
      tokenBreakdownKnown: true,
      cacheHitRate: 14000 / 24000,
      reservedUsd: 0,
      actualUsd: 0.041,
      accountedUsd: 0.041,
      pricingUnknown: false,
      latencyMs: 6420,
      toolCalls: 0,
      metadata: { taskId: "task-9", repository: "acme/api" },
    },
    {
      id: "review:rev-42:att-42",
      recordedAt: "2026-11-20T18:10:00.000Z",
      sourceKind: "review_bot",
      sourceKindLabel: "Review Bot",
      sourceId: "rev-42",
      sourceLabel: "Review Bot · acme/api #42",
      sourcePath: "/admin/plugins/review-bot",
      actor: "202",
      actorLabel: "@alice",
      providerId: "prov-1",
      providerName: "OpenAI Prod",
      model: "gpt-4.1",
      status: "settled",
      stopReason: "stop",
      inputTokens: 3500,
      cacheReadTokens: 4500,
      cacheWriteTokens: 0,
      outputTokens: 1100,
      reasoningTokens: 0,
      totalTokens: 9100,
      estimatedInputTokens: null,
      tokenBreakdownKnown: true,
      cacheHitRate: 4500 / 8000,
      reservedUsd: 0,
      actualUsd: 0.018,
      accountedUsd: 0.018,
      pricingUnknown: false,
      latencyMs: 3800,
      toolCalls: 0,
      metadata: { reviewTaskId: "rev-42", prNumber: 42 },
    },
    {
      id: "run:run-1:att-compact",
      recordedAt: "2026-11-20T14:00:00.000Z",
      sourceKind: "compaction",
      sourceKindLabel: "Compaction",
      sourceId: "run-1",
      sourceLabel: "Context compaction",
      sourcePath: "/admin/runs/run-1",
      actor: "202",
      actorLabel: "@alice",
      providerId: "prov-1",
      providerName: "OpenAI Prod",
      model: "gpt-4.1-mini",
      status: "settled",
      stopReason: "stop",
      inputTokens: 5200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 600,
      reasoningTokens: 0,
      totalTokens: 5800,
      estimatedInputTokens: 5400,
      tokenBreakdownKnown: true,
      cacheHitRate: 0,
      reservedUsd: 0.003,
      actualUsd: 0.0021,
      accountedUsd: 0.0021,
      pricingUnknown: false,
      latencyMs: 740,
      toolCalls: 0,
      metadata: { runId: "run-1", purpose: "compaction" },
    },
  ];

  const items = allItems.filter((item) => {
    if (filters.source && item.sourceKind !== filters.source) return false;
    if (filters.model && item.model !== filters.model) return false;
    if (filters.status && item.status !== filters.status) return false;
    return true;
  });

  const sum = (fn: (i: (typeof items)[number]) => number) =>
    items.reduce((acc, i) => acc + fn(i), 0);
  const inputTokens = sum((i) => i.inputTokens);
  const cacheReadTokens = sum((i) => i.cacheReadTokens);
  const cacheWriteTokens = sum((i) => i.cacheWriteTokens);
  const outputTokens = sum((i) => i.outputTokens);
  const reasoningTokens = sum((i) => i.reasoningTokens);
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = sum((i) => i.totalTokens);
  const accountedUsd = sum((i) => i.accountedUsd);

  const groupBy = (
    keyFn: (i: (typeof items)[number]) => {
      key: string;
      label: string;
      sublabel?: string;
    },
  ) => {
    const map = new Map<string, (typeof items)[number][]>();
    const meta = new Map<string, { label: string; sublabel?: string }>();
    for (const item of items) {
      const m = keyFn(item);
      meta.set(m.key, { label: m.label, sublabel: m.sublabel });
      const list = map.get(m.key) ?? [];
      list.push(item);
      map.set(m.key, list);
    }
    return [...map.entries()]
      .map(([key, list]) => {
        const gIn = list.reduce((a, b) => a + b.inputTokens, 0);
        const gCr = list.reduce((a, b) => a + b.cacheReadTokens, 0);
        const gCw = list.reduce((a, b) => a + b.cacheWriteTokens, 0);
        const gOut = list.reduce((a, b) => a + b.outputTokens, 0);
        const gReas = list.reduce((a, b) => a + b.reasoningTokens, 0);
        const gTot = list.reduce((a, b) => a + b.totalTokens, 0);
        const gUsd = list.reduce((a, b) => a + b.accountedUsd, 0);
        const gAllIn = gIn + gCr + gCw;
        return {
          key,
          label: meta.get(key)?.label ?? key,
          ...(meta.get(key)?.sublabel
            ? { sublabel: meta.get(key)?.sublabel }
            : {}),
          calls: list.length,
          settledCalls: list.filter((i) => i.status === "settled").length,
          inputTokens: gIn,
          cacheReadTokens: gCr,
          cacheWriteTokens: gCw,
          outputTokens: gOut,
          reasoningTokens: gReas,
          totalTokens: gTot,
          accountedUsd: gUsd,
          cacheHitRate: gAllIn > 0 ? gCr / gAllIn : null,
          avgLatencyMs: Math.round(
            list.reduce((a, b) => a + (b.latencyMs ?? 0), 0) / list.length,
          ),
          shareOfTokens: totalTokens > 0 ? gTot / totalTokens : 0,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  };

  return {
    range: (filters.range as ModelUsageAnalyticsResponse["range"]) || "30d",
    granularity: filters.range === "24h" ? "hour" : "day",
    from: "2026-10-22T00:00:00.000Z",
    to: "2026-11-21T08:00:00.000Z",
    budget: {
      monthlyLimitUsd: 25,
      monthAccountedUsd: 0.0663,
      utilizationRate: 0.0663 / 25,
    },
    summary: {
      calls: items.length,
      settledCalls: items.length,
      reservedCalls: 0,
      unknownCalls: 0,
      failedCalls: 0,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalInputTokens,
      totalTokens,
      cacheHitRate:
        totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : null,
      estimatedCacheSavingsUsd: 0.0124,
      accountedUsd,
      settledUsd: accountedUsd,
      reservedUsd: 0,
      unpricedCalls: 0,
      breakdownKnownCalls: items.length,
      avgTokensPerCall: items.length
        ? Math.round(totalTokens / items.length)
        : 0,
      avgLatencyMs: items.length ? 3020 : null,
      p95LatencyMs: items.length ? 6420 : null,
      totalToolCalls: sum((i) => i.toolCalls),
      estimatorSampleCount: items.filter((i) => i.estimatedInputTokens !== null)
        .length,
      avgActualToEstimatedRatio: items.some(
        (i) => i.estimatedInputTokens !== null,
      )
        ? 0.99
        : null,
      stopReasons: items.length
        ? [{ reason: "stop", count: items.length }]
        : [],
    },
    timeseries: [
      {
        bucket: "2026-11-19T00:00:00.000Z",
        label: "11-19",
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        accountedUsd: 0,
        cacheHitRate: null,
      },
      {
        bucket: "2026-11-20T00:00:00.000Z",
        label: "11-20",
        calls: items.filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .length,
        inputTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .reduce((a, b) => a + b.inputTokens, 0),
        cacheReadTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .reduce((a, b) => a + b.cacheReadTokens, 0),
        cacheWriteTokens: 0,
        outputTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .reduce((a, b) => a + b.outputTokens, 0),
        reasoningTokens: 0,
        totalTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .reduce((a, b) => a + b.totalTokens, 0),
        accountedUsd: items
          .filter((i) => i.recordedAt.startsWith("2026-11-20"))
          .reduce((a, b) => a + b.accountedUsd, 0),
        cacheHitRate: 0.34,
      },
      {
        bucket: "2026-11-21T00:00:00.000Z",
        label: "11-21",
        calls: items.filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .length,
        inputTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.inputTokens, 0),
        cacheReadTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.cacheReadTokens, 0),
        cacheWriteTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.cacheWriteTokens, 0),
        outputTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.outputTokens, 0),
        reasoningTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.reasoningTokens, 0),
        totalTokens: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.totalTokens, 0),
        accountedUsd: items
          .filter((i) => i.recordedAt.startsWith("2026-11-21"))
          .reduce((a, b) => a + b.accountedUsd, 0),
        cacheHitRate: 0.61,
      },
    ],
    bySource: groupBy((i) => ({ key: i.sourceKind, label: i.sourceKindLabel })),
    byModel: groupBy((i) => ({
      key: i.model,
      label: i.model,
      sublabel: i.providerName,
    })),
    byActor: groupBy((i) => ({ key: i.actor, label: i.actorLabel })),
    filters: {
      models: ["gpt-4.1", "gpt-4.1-mini"],
      sources: [
        { key: "chat", label: "Chat" },
        { key: "coding_task", label: "Codex task" },
        { key: "compaction", label: "Compaction" },
        { key: "review_bot", label: "Review Bot" },
      ],
    },
    items,
    total: items.length,
    offset: 0,
    limit: 50,
  };
}

async function mountModelUsageFixture(
  page: Page,
  options: { empty?: boolean; failOnce?: boolean } = {},
) {
  let failedOnce = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/setup/status") {
      return route.fulfill({ json: { initialized: true, active: true } });
    }
    if (path === "/api/admin/auth/session") {
      return route.fulfill({
        json: {
          csrf: "csrf-token",
          admin: {
            id: "admin-1",
            username: "owner",
            telegramId: "101",
            operator: true,
          },
        },
      });
    }
    if (path === "/api/admin/workspaces") {
      return route.fulfill({ json: [{ id: workspaceId, name: "Acme Team" }] });
    }
    if (path === "/api/admin/updates") {
      return route.fulfill({
        json: { current: "0.1.51", latest: "0.1.51", available: false },
      });
    }
    if (path === "/api/setup/progress") {
      return route.fulfill({ json: { active: true } });
    }
    if (path === `/api/admin/workspaces/${workspaceId}/model-usage`) {
      if (options.failOnce && !failedOnce) {
        failedOnce = true;
        return route.fulfill({
          status: 500,
          json: { error: "usage_query_failed" },
        });
      }
      if (options.empty) {
        return route.fulfill({
          json: sampleAnalytics({ source: "workflow" }),
        });
      }
      return route.fulfill({
        json: sampleAnalytics({
          range: url.searchParams.get("range") ?? "30d",
          source: url.searchParams.get("source") ?? "",
          model: url.searchParams.get("model") ?? "",
          status: url.searchParams.get("status") ?? "",
        }),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

test("Model usage renders charts, source attribution, filters, detail modal, and fits desktop and mobile in light and dark themes", async ({
  page,
}) => {
  await mountModelUsageFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/admin/model-usage?workspace=${workspaceId}`);

  await expect(
    page.getByRole("heading", { name: "Model usage", exact: true }),
  ).toBeVisible();
  // Routine pages must have no manual refresh button.
  await expect(
    page.getByRole("button", { name: /refresh|reload/i }),
  ).toHaveCount(0);

  // Verify KPI cards & SVG charts render (55,850 tokens -> 55.9K).
  await expect(
    page.locator(".mu-kpi strong").filter({ hasText: "55.9K" }),
  ).toBeVisible();
  await expect(page.getByText("0.99×", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Stacked token usage over time/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Spend and prompt cache hit rate/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Token share by usage source/i }),
  ).toBeVisible();

  // Verify every source appears in the ledger with origin labels.
  const table = page.locator(".mu-ledger-table");
  await expect(table.getByText("Group · Engineering")).toBeVisible();
  await expect(table.getByText("Codex · acme/api")).toBeVisible();
  await expect(table.getByText("Review Bot · acme/api #42")).toBeVisible();
  await expect(table.getByText("Context compaction")).toBeVisible();

  await page.screenshot({
    path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/model-usage-desktop-light.png`,
    fullPage: true,
  });

  // Open record provenance detail modal.
  await table.getByRole("button", { name: "View" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Model usage record" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("12,500")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // Filter by source via dropdown and clear filter.
  await chooseOption(page.getByLabel("Filter by source"), "coding_task");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByText("Codex · acme/api")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(4);

  // Switch time range to 24h (hourly granularity).
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(page.getByText("Per hour", { exact: true })).toBeVisible();

  // Dark theme & mobile width (390px) with zero horizontal page overflow.
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.screenshot({
    path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/model-usage-desktop-dark.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: `${process.env.BROWSER_SCREENSHOT_DIR ?? "test-results"}/model-usage-mobile-dark.png`,
    fullPage: true,
  });
});

test("Model usage handles error retry and empty state cleanly", async ({
  page,
}) => {
  await mountModelUsageFixture(page, { failOnce: true, empty: true });
  await page.goto(`/admin/model-usage?workspace=${workspaceId}`);

  await expect(page.getByRole("alert")).toContainText("usage_query_failed");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByText("No model usage recorded in this period."),
  ).toBeVisible();
});
