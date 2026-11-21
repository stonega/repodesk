import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  ModelUsageAnalyticsResponse,
  ModelUsageLedgerItem,
  UsageRange,
  UsageSourceKind,
} from "../../src/usage/model-usage.ts";
import { api, Page } from "../admin-shared.tsx";
import { DataDetails } from "../data-details.tsx";
import { IconButton } from "../icon-button.tsx";
import { Modal } from "../modal.tsx";
import { Select } from "../select.tsx";
import { Skeleton, SkeletonCells } from "../skeleton.tsx";
import { ErrorToast } from "../toast.tsx";
import {
  ActorBreakdownBars,
  formatCompactTokens,
  formatLatency,
  formatPercent,
  formatUsd,
  ModelStackedBars,
  SourceDonutChart,
  SpendAndCacheChart,
  sourceColor,
  TokenCompositionBar,
  TokenTimelineChart,
} from "../usage-charts.tsx";

const RANGES: { key: UsageRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "all", label: "All" },
];

const STATUS_LABELS: Record<string, string> = {
  settled: "Settled",
  reserved: "Reserved",
  unknown: "Unresolved",
  failed: "Failed",
};

const pageSize = 50;

export function ModelUsagePage({
  id,
  request = api,
}: {
  id: string;
  request?: <T>(path: string) => Promise<T>;
}) {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range") as UsageRange | null;
  const range: UsageRange =
    rangeParam && RANGES.some((r) => r.key === rangeParam) ? rangeParam : "30d";
  const source = (params.get("source") ?? "") as UsageSourceKind | "";
  const model = params.get("model") ?? "";
  const status = params.get("status") ?? "";
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const [revision, setRevision] = useState(0);
  const [inspecting, setInspecting] = useState<ModelUsageLedgerItem>();

  const query = new URLSearchParams();
  query.set("range", range);
  if (source) query.set("source", source);
  if (model) query.set("model", model);
  if (status) query.set("status", status);
  if (offset > 0) query.set("offset", String(offset));
  query.set("limit", String(pageSize));

  const path = `/api/admin/workspaces/${id}/model-usage?${query.toString()}`;
  const key = `${path}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    data?: ModelUsageAnalyticsResponse;
    error?: string;
  }>();
  const loading = result?.key !== key;
  const data = loading ? undefined : result?.data;
  const error = loading ? undefined : result?.error;

  useEffect(() => {
    let live = true;
    request<ModelUsageAnalyticsResponse>(path).then(
      (payload) => {
        if (live) setResult({ key, data: payload });
      },
      (err: Error) => {
        if (live) setResult({ key, error: err.message });
      },
    );
    return () => {
      live = false;
    };
  }, [path, key, request]);

  function updateFilter(patch: Record<string, string>) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!("offset" in patch)) next.delete("offset");
      return next;
    });
  }

  const hasFilters = !!(source || model || status);
  const summary = data?.summary;
  const inputOutputRatio =
    summary && summary.outputTokens > 0
      ? `${(summary.totalInputTokens / summary.outputTokens).toFixed(1)} : 1`
      : "—";

  return (
    <Page
      title="Model usage"
      description="Detailed token consumption, prompt-cache efficiency, latency, and USD cost attributed to every source across chat, workflows, missions, memory, self-check, Codex, and Review Bot."
    >
      <ErrorToast message={error ?? ""}>
        <button
          type="button"
          className="toast-retry"
          disabled={loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          Retry
        </button>
      </ErrorToast>

      {/* Filters & Time Range Bar */}
      <section className="card mu-filters-card" aria-label="Usage filters">
        <div className="mu-filters-bar">
          <fieldset className="mu-range-group">
            <legend className="sr-only">Time range</legend>
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={
                  range === item.key ? "mu-range-btn active" : "mu-range-btn"
                }
                aria-pressed={range === item.key}
                onClick={() => updateFilter({ range: item.key })}
              >
                {item.label}
              </button>
            ))}
          </fieldset>
          <div className="mu-filter-selects">
            <div className="mu-filter-field">
              <label htmlFor="mu-filter-source" className="sr-only">
                Filter by source
              </label>
              <Select
                id="mu-filter-source"
                aria-label="Filter by source"
                value={source}
                onChange={(event) =>
                  updateFilter({ source: event.target.value })
                }
              >
                <option value="">All sources</option>
                {(data?.filters.sources ?? []).map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mu-filter-field">
              <label htmlFor="mu-filter-model" className="sr-only">
                Filter by model
              </label>
              <Select
                id="mu-filter-model"
                aria-label="Filter by model"
                value={model}
                onChange={(event) =>
                  updateFilter({ model: event.target.value })
                }
              >
                <option value="">All models</option>
                {(data?.filters.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mu-filter-field">
              <label htmlFor="mu-filter-status" className="sr-only">
                Filter by status
              </label>
              <Select
                id="mu-filter-status"
                aria-label="Filter by status"
                value={status}
                onChange={(event) =>
                  updateFilter({ status: event.target.value })
                }
              >
                <option value="">All statuses</option>
                <option value="settled">Settled</option>
                <option value="reserved">Reserved</option>
                <option value="unknown">Unresolved</option>
                <option value="failed">Failed</option>
              </Select>
            </div>
            {hasFilters && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  updateFilter({ source: "", model: "", status: "" })
                }
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      </section>

      {/* KPI Summary Grid */}
      <section
        className="card"
        aria-label="Model usage summary"
        aria-busy={loading}
      >
        <dl className="mu-kpi-grid">
          <div className="mu-kpi">
            <dt>Total tokens</dt>
            <dd>
              <strong>
                {summary ? (
                  formatCompactTokens(summary.totalTokens)
                ) : loading ? (
                  <Skeleton width="5.5rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? `${formatCompactTokens(summary.totalInputTokens)} in · ${formatCompactTokens(summary.outputTokens)} out`
                  : "Input and output tokens"}
              </small>
              {summary && summary.reasoningTokens > 0 && (
                <small className="mu-kpi-note">
                  {formatCompactTokens(summary.reasoningTokens)} reasoning
                </small>
              )}
            </dd>
          </div>
          <div className="mu-kpi">
            <dt>Prompt cache hit rate</dt>
            <dd>
              <strong>
                {summary ? (
                  formatPercent(summary.cacheHitRate)
                ) : loading ? (
                  <Skeleton width="4.5rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? `${formatCompactTokens(summary.cacheReadTokens)} read · ${formatCompactTokens(summary.cacheWriteTokens)} write`
                  : "Cache reads / total input"}
              </small>
              {summary && summary.estimatedCacheSavingsUsd > 0 && (
                <small className="mu-kpi-note">
                  Est. {formatUsd(summary.estimatedCacheSavingsUsd)} saved
                </small>
              )}
            </dd>
          </div>
          <div className="mu-kpi">
            <dt>Accounted spend</dt>
            <dd>
              <strong>
                {summary ? (
                  formatUsd(summary.accountedUsd)
                ) : loading ? (
                  <Skeleton width="5rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? `${formatUsd(summary.settledUsd)} settled · ${formatUsd(summary.reservedUsd)} pending`
                  : "USD across selected range"}
              </small>
              {data?.budget.monthlyLimitUsd !== null &&
                data?.budget.monthlyLimitUsd !== undefined && (
                  <div className="mu-budget-mini">
                    <div className="mu-bar-track" aria-hidden="true">
                      <div
                        className="mu-bar-fill"
                        style={{
                          width: `${Math.min(100, (data.budget.utilizationRate ?? 0) * 100)}%`,
                          background:
                            (data.budget.utilizationRate ?? 0) >= 0.85
                              ? "#ef4444"
                              : "#3b82f6",
                        }}
                      />
                    </div>
                    <small className="mu-kpi-note">
                      Month: {formatUsd(data.budget.monthAccountedUsd)} /{" "}
                      {formatUsd(data.budget.monthlyLimitUsd)}
                    </small>
                  </div>
                )}
            </dd>
          </div>
          <div className="mu-kpi">
            <dt>Model calls</dt>
            <dd>
              <strong>
                {summary ? (
                  summary.calls.toLocaleString()
                ) : loading ? (
                  <Skeleton width="4rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? `${summary.settledCalls} settled · ${formatCompactTokens(summary.avgTokensPerCall)} avg/call`
                  : "All recorded invocations"}
              </small>
              {summary &&
                (summary.unknownCalls > 0 || summary.failedCalls > 0) && (
                  <small className="mu-kpi-note">
                    {summary.unknownCalls} unresolved · {summary.failedCalls}{" "}
                    failed
                  </small>
                )}
            </dd>
          </div>
          <div className="mu-kpi">
            <dt>Latency &amp; tools</dt>
            <dd>
              <strong>
                {summary ? (
                  formatLatency(summary.avgLatencyMs)
                ) : loading ? (
                  <Skeleton width="4.5rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? `P95 ${formatLatency(summary.p95LatencyMs)} · ${summary.totalToolCalls.toLocaleString()} tool calls`
                  : "Average response duration"}
              </small>
            </dd>
          </div>
          <div className="mu-kpi">
            <dt>Estimator accuracy</dt>
            <dd>
              <strong>
                {summary ? (
                  summary.avgActualToEstimatedRatio !== null ? (
                    `${summary.avgActualToEstimatedRatio.toFixed(2)}×`
                  ) : (
                    "—"
                  )
                ) : loading ? (
                  <Skeleton width="4rem" />
                ) : (
                  "—"
                )}
              </strong>
              <small className="mu-kpi-note">
                {summary
                  ? summary.estimatorSampleCount > 0
                    ? `Actual / est. input (${summary.estimatorSampleCount} calls)`
                    : "Populates on new model calls"
                  : "Token estimator calibration"}
              </small>
            </dd>
          </div>
        </dl>
      </section>

      {/* Time-Series Charts */}
      <div className="mu-charts-grid">
        <section
          className="card"
          aria-label="Token usage over time"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Token usage over time</h2>
            <span className="pill">
              {data ? `Per ${data.granularity}` : range}
            </span>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="220px" />
          ) : data && data.timeseries.length > 0 ? (
            <TokenTimelineChart
              series={data.timeseries}
              granularity={data.granularity}
            />
          ) : (
            <p className="muted">No token activity in this period.</p>
          )}
        </section>

        <section
          className="card"
          aria-label="Spend and cache efficiency trend"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Spend &amp; cache hit rate</h2>
            <span className="pill">USD · %</span>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="220px" />
          ) : data && data.timeseries.length > 0 ? (
            <SpendAndCacheChart
              series={data.timeseries}
              granularity={data.granularity}
            />
          ) : (
            <p className="muted">No spend or cache data in this period.</p>
          )}
        </section>
      </div>

      {/* Attribution Charts: By Source & By Model */}
      <div className="mu-charts-grid">
        <section
          className="card"
          aria-label="Usage by source"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Usage by source</h2>
            <span className="muted">Click a source to filter</span>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="180px" />
          ) : data && data.bySource.length > 0 ? (
            <SourceDonutChart
              groups={data.bySource}
              totalTokens={data.summary.totalTokens}
              totalCalls={data.summary.calls}
              selectedSource={source}
              onSelectSource={(next) => updateFilter({ source: next })}
            />
          ) : (
            <p className="muted">No source records in this period.</p>
          )}
        </section>

        <section
          className="card"
          aria-label="Usage by model and provider"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Usage by model</h2>
            <span className="muted">Click a model to filter</span>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="180px" />
          ) : data && data.byModel.length > 0 ? (
            <ModelStackedBars
              groups={data.byModel}
              selectedModel={model}
              onSelectModel={(next) => updateFilter({ model: next })}
            />
          ) : (
            <p className="muted">No model records in this period.</p>
          )}
        </section>
      </div>

      {/* Token Composition & Actor Breakdown */}
      <div className="mu-charts-grid">
        <section
          className="card"
          aria-label="Token composition and diagnostics"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Token composition &amp; coverage</h2>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="160px" />
          ) : summary && summary.calls > 0 ? (
            <>
              <TokenCompositionBar
                inputTokens={summary.inputTokens}
                cacheReadTokens={summary.cacheReadTokens}
                cacheWriteTokens={summary.cacheWriteTokens}
                outputTokens={summary.outputTokens}
                reasoningTokens={summary.reasoningTokens}
                totalTokens={summary.totalTokens}
              />
              <dl className="mu-diagnostics-strip">
                <div>
                  <dt>Input : Output</dt>
                  <dd>{inputOutputRatio}</dd>
                </div>
                <div>
                  <dt>Breakdown coverage</dt>
                  <dd>
                    {summary.breakdownKnownCalls} / {summary.calls} calls
                  </dd>
                </div>
                <div>
                  <dt>Priced calls</dt>
                  <dd>
                    {summary.calls - summary.unpricedCalls} / {summary.calls}
                  </dd>
                </div>
              </dl>
              {summary.stopReasons.length > 0 && (
                <div className="mu-stop-reasons">
                  <span className="muted">Stop reasons:</span>
                  {summary.stopReasons.map((sr) => (
                    <span key={sr.reason} className="pill">
                      {sr.reason}: {sr.count}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="muted">No token composition data in this period.</p>
          )}
        </section>

        <section
          className="card"
          aria-label="Usage by actor"
          aria-busy={loading}
        >
          <div className="card-heading">
            <h2>Usage by actor</h2>
            <span className="muted">Top 20 contributors</span>
          </div>
          {loading && !data ? (
            <Skeleton width="100%" height="160px" />
          ) : data && data.byActor.length > 0 ? (
            <ActorBreakdownBars groups={data.byActor} />
          ) : (
            <p className="muted">No actor activity in this period.</p>
          )}
        </section>
      </div>

      {/* Detailed Source-Attributed Ledger */}
      <section
        className="card mu-ledger-card"
        aria-label="Detailed usage ledger"
        aria-busy={loading}
      >
        <div className="mu-card-head">
          <h2 className="mu-card-title">Detailed usage ledger</h2>
          <span className="muted">
            Every record includes its originating source
          </span>
        </div>
        <section
          className="data-table-scroll"
          aria-label="Model usage records"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Horizontal table region must be keyboard scrollable.
          tabIndex={0}
        >
          <table className="mu-ledger-table">
            <caption className="sr-only">
              Source-attributed model usage ledger
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Source</th>
                <th scope="col">Model &amp; Provider</th>
                <th scope="col">Actor</th>
                <th scope="col" className="usage-money">
                  Tokens
                </th>
                <th scope="col" className="usage-money">
                  Cache
                </th>
                <th scope="col" className="usage-money">
                  Latency
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="usage-money">
                  Cost
                </th>
                <th scope="col" className="actions-cell">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && <SkeletonCells columns={10} />}
              {data?.items.map((item) => (
                <tr key={item.id}>
                  <td className="mu-nowrap">
                    <time dateTime={item.recordedAt}>
                      {new Date(item.recordedAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    <div className="mu-source-cell">
                      <span
                        className="pill mu-source-pill"
                        style={{
                          borderColor: sourceColor(item.sourceKind),
                          color: sourceColor(item.sourceKind),
                        }}
                      >
                        {item.sourceKindLabel}
                      </span>
                      {item.sourcePath ? (
                        <Link
                          to={`${item.sourcePath}?workspace=${encodeURIComponent(id)}`}
                          className="mu-source-link"
                        >
                          {item.sourceLabel}
                        </Link>
                      ) : (
                        <span className="mu-source-label">
                          {item.sourceLabel}
                        </span>
                      )}
                      <span
                        className="usage-run mono"
                        title={`Source ID: ${item.sourceId}`}
                      >
                        {item.sourceId}
                      </span>
                    </div>
                  </td>
                  <td className="mu-nowrap">
                    <strong className="mono">{item.model}</strong>
                    <span className="usage-run">{item.providerName}</span>
                  </td>
                  <td className="mu-nowrap">{item.actorLabel}</td>
                  <td className="usage-money">
                    <strong>{item.totalTokens.toLocaleString()}</strong>
                    <span className="usage-run">
                      {item.tokenBreakdownKnown
                        ? `${formatCompactTokens(item.inputTokens)} in · ${formatCompactTokens(item.cacheReadTokens)} cache · ${formatCompactTokens(item.outputTokens)} out`
                        : "Total only"}
                    </span>
                  </td>
                  <td className="usage-money">
                    {formatPercent(item.cacheHitRate)}
                  </td>
                  <td className="usage-money">
                    {formatLatency(item.latencyMs)}
                  </td>
                  <td>
                    <span className={`pill usage-${item.status}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="usage-money">
                    {item.pricingUnknown && item.actualUsd === null
                      ? "$0.00"
                      : formatUsd(item.accountedUsd)}
                  </td>
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setInspecting(item)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={10} className="usage-empty">
                    {hasFilters
                      ? "No model usage matches the selected filters."
                      : "No model usage recorded in this period."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {data && (
          <div className="usage-pagination">
            <span className="muted" role="status">
              {data.items.length
                ? `${data.offset + 1}–${data.offset + data.items.length} of ${data.total} records`
                : `0 of ${data.total} records`}
            </span>
            <div className="row">
              <IconButton
                icon="previous"
                label="Previous page"
                disabled={offset === 0}
                onClick={() =>
                  updateFilter({
                    offset:
                      offset - pageSize > 0 ? String(offset - pageSize) : "",
                  })
                }
              />
              <span className="muted">
                Page {Math.floor(offset / pageSize) + 1} of{" "}
                {Math.max(
                  1,
                  Math.ceil(Math.max(data.total, offset + 1) / pageSize),
                )}
              </span>
              <IconButton
                icon="next"
                label="Next page"
                disabled={offset + pageSize >= data.total}
                onClick={() =>
                  updateFilter({ offset: String(offset + pageSize) })
                }
              />
            </div>
          </div>
        )}
      </section>

      {/* Event Provenance Detail Modal */}
      {inspecting && (
        <Modal
          title="Model usage record"
          cancelLabel="Close"
          onClose={() => setInspecting(undefined)}
        >
          <DataDetails
            value={{
              recordedAt: new Date(inspecting.recordedAt).toLocaleString(),
              source: `${inspecting.sourceKindLabel} — ${inspecting.sourceLabel}`,
              sourceId: inspecting.sourceId,
              model: inspecting.model,
              provider: inspecting.providerName,
              actor: inspecting.actorLabel,
              status: STATUS_LABELS[inspecting.status] ?? inspecting.status,
              stopReason: inspecting.stopReason ?? "—",
              totalTokens: inspecting.totalTokens.toLocaleString(),
              uncachedInputTokens: inspecting.inputTokens.toLocaleString(),
              cacheReadTokens: inspecting.cacheReadTokens.toLocaleString(),
              cacheWriteTokens: inspecting.cacheWriteTokens.toLocaleString(),
              outputTokens: inspecting.outputTokens.toLocaleString(),
              ...(inspecting.reasoningTokens > 0
                ? {
                    reasoningTokens:
                      inspecting.reasoningTokens.toLocaleString(),
                  }
                : {}),
              cacheHitRate: formatPercent(inspecting.cacheHitRate),
              estimatedInputTokens:
                inspecting.estimatedInputTokens !== null
                  ? inspecting.estimatedInputTokens.toLocaleString()
                  : "—",
              latency: formatLatency(inspecting.latencyMs),
              toolCalls: inspecting.toolCalls,
              reservedUsd: formatUsd(inspecting.reservedUsd),
              actualUsd:
                inspecting.actualUsd !== null
                  ? formatUsd(inspecting.actualUsd)
                  : "Not reported",
              accountedUsd: formatUsd(inspecting.accountedUsd),
              pricingKnown: inspecting.pricingUnknown ? "Unknown" : "Known",
              metadata: inspecting.metadata,
            }}
          />
        </Modal>
      )}
    </Page>
  );
}
