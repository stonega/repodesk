import { useState } from "react";
import type {
  ModelUsageGroupSummary,
  ModelUsageSeriesPoint,
  UsageSourceKind,
} from "../src/usage/model-usage.ts";

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString();
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export const SOURCE_COLORS: Record<UsageSourceKind, string> = {
  chat: "#3b82f6",
  workflow: "#8b5cf6",
  mission: "#ec4899",
  compaction: "#f59e0b",
  followup: "#06b6d4",
  research_subagent: "#14b8a6",
  memory_extract: "#84cc16",
  memory_consolidate: "#22c55e",
  skill_extract: "#a855f7",
  self_check: "#64748b",
  coding_task: "#f97316",
  coding_conversation: "#fb923c",
  review_bot: "#6366f1",
};

export const TOKEN_COLORS = {
  input: "#3b82f6",
  cacheRead: "#10b981",
  cacheWrite: "#06b6d4",
  output: "#f59e0b",
  reasoning: "#8b5cf6",
};

export function sourceColor(kind: string): string {
  return SOURCE_COLORS[kind as UsageSourceKind] ?? "#64748b";
}

function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function TokenTimelineChart({
  series,
  granularity,
}: {
  series: ModelUsageSeriesPoint[];
  granularity: "hour" | "day";
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 640;
  const height = 228;
  const pad = { top: 14, right: 12, bottom: 28, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxTotal = niceMax(Math.max(...series.map((p) => p.totalTokens), 0));
  const count = Math.max(series.length, 1);
  const slotW = plotW / count;
  const barW = Math.max(3, Math.min(26, slotW * 0.72));
  const labelEvery = Math.max(1, Math.ceil(count / 8));
  const active = activeIndex !== null ? series[activeIndex] : undefined;

  return (
    <div className="mu-chart-wrap">
      <div className="mu-chart-legend">
        <span className="mu-legend-item">
          <i className="mu-dot" style={{ background: TOKEN_COLORS.input }} />{" "}
          Uncached input
        </span>
        <span className="mu-legend-item">
          <i
            className="mu-dot"
            style={{ background: TOKEN_COLORS.cacheRead }}
          />{" "}
          Cache read
        </span>
        <span className="mu-legend-item">
          <i
            className="mu-dot"
            style={{ background: TOKEN_COLORS.cacheWrite }}
          />{" "}
          Cache write
        </span>
        <span className="mu-legend-item">
          <i className="mu-dot" style={{ background: TOKEN_COLORS.output }} />{" "}
          Output
        </span>
      </div>
      <svg
        className="mu-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Stacked token usage over time by ${granularity}`}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = pad.top + plotH * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                className="mu-grid-line"
              />
              <text
                x={pad.left - 8}
                y={y + 4}
                textAnchor="end"
                className="mu-axis-text"
              >
                {formatCompactTokens(Math.round(maxTotal * ratio))}
              </text>
            </g>
          );
        })}

        {series.map((point, index) => {
          const xCenter = pad.left + slotW * index + slotW / 2;
          const x = xCenter - barW / 2;
          const breakdownSum =
            point.inputTokens +
            point.cacheReadTokens +
            point.cacheWriteTokens +
            point.outputTokens;
          // If legacy Codex records only report totalTokens without breakdown,
          // attribute the residual to input so the total bar height stays faithful.
          const unattributed = Math.max(0, point.totalTokens - breakdownSum);
          const segments = [
            {
              key: "input",
              value: point.inputTokens + unattributed,
              color: TOKEN_COLORS.input,
            },
            {
              key: "cacheRead",
              value: point.cacheReadTokens,
              color: TOKEN_COLORS.cacheRead,
            },
            {
              key: "cacheWrite",
              value: point.cacheWriteTokens,
              color: TOKEN_COLORS.cacheWrite,
            },
            {
              key: "output",
              value: point.outputTokens,
              color: TOKEN_COLORS.output,
            },
          ];
          let currentY = pad.top + plotH;
          const isHovered = activeIndex === index;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG bar groups represent chart data points with keyboard focus.
            <g
              key={point.bucket}
              role="button"
              className="mu-bar-group"
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveIndex(index);
                }
              }}
              tabIndex={0}
              aria-label={`${point.label}: ${point.totalTokens.toLocaleString()} tokens, ${point.calls} calls`}
            >
              <rect
                x={pad.left + slotW * index}
                y={pad.top}
                width={slotW}
                height={plotH}
                className={isHovered ? "mu-hover-band active" : "mu-hover-band"}
              />
              {segments.map((seg, segIdx) => {
                if (seg.value <= 0) return null;
                const segH = Math.max(1, (seg.value / maxTotal) * plotH);
                currentY -= segH;
                return (
                  <rect
                    key={seg.key}
                    x={x}
                    y={currentY}
                    width={barW}
                    height={segH}
                    fill={seg.color}
                    rx={segIdx === segments.length - 1 ? 2 : 0}
                  />
                );
              })}
              {(index % labelEvery === 0 || index === series.length - 1) && (
                <text
                  x={xCenter}
                  y={height - 8}
                  textAnchor="middle"
                  className="mu-axis-text"
                >
                  {point.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mu-chart-readout" aria-live="polite">
        {active ? (
          <>
            <strong>{active.label} UTC</strong>
            <span>{active.totalTokens.toLocaleString()} total</span>
            <span>In {formatCompactTokens(active.inputTokens)}</span>
            <span>
              Cache read {formatCompactTokens(active.cacheReadTokens)}
            </span>
            {active.cacheWriteTokens > 0 && (
              <span>
                Cache write {formatCompactTokens(active.cacheWriteTokens)}
              </span>
            )}
            <span>Out {formatCompactTokens(active.outputTokens)}</span>
            <span>{active.calls} calls</span>
            <span>{formatUsd(active.accountedUsd)}</span>
          </>
        ) : (
          <span className="muted">
            Hover or focus any bar to inspect exact token breakdown per{" "}
            {granularity}.
          </span>
        )}
      </div>
    </div>
  );
}

export function SpendAndCacheChart({
  series,
  granularity,
}: {
  series: ModelUsageSeriesPoint[];
  granularity: "hour" | "day";
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 640;
  const height = 228;
  const pad = { top: 14, right: 44, bottom: 28, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxSpend = niceMax(
    Math.max(...series.map((p) => p.accountedUsd), 0.0001),
  );
  const count = Math.max(series.length, 1);
  const slotW = plotW / count;
  const barW = Math.max(3, Math.min(22, slotW * 0.62));
  const labelEvery = Math.max(1, Math.ceil(count / 8));
  const active = activeIndex !== null ? series[activeIndex] : undefined;

  const cachePoints = series
    .map((p, index) => {
      if (p.cacheHitRate === null) return null;
      const x = pad.left + slotW * index + slotW / 2;
      const y =
        pad.top + plotH * (1 - Math.min(1, Math.max(0, p.cacheHitRate)));
      return { x, y, index, rate: p.cacheHitRate };
    })
    .filter((pt): pt is NonNullable<typeof pt> => pt !== null);

  const polyline = cachePoints.map((pt) => `${pt.x},${pt.y}`).join(" ");

  return (
    <div className="mu-chart-wrap">
      <div className="mu-chart-legend">
        <span className="mu-legend-item">
          <i className="mu-dot" style={{ background: "#6366f1" }} /> Spend (USD)
        </span>
        <span className="mu-legend-item">
          <i className="mu-dot" style={{ background: "#10b981" }} /> Cache hit
          rate (%)
        </span>
      </div>
      <svg
        className="mu-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Spend and prompt cache hit rate by ${granularity}`}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = pad.top + plotH * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                className="mu-grid-line"
              />
              <text
                x={pad.left - 8}
                y={y + 4}
                textAnchor="end"
                className="mu-axis-text"
              >
                {formatUsd(maxSpend * ratio)}
              </text>
              <text
                x={width - pad.right + 6}
                y={y + 4}
                textAnchor="start"
                className="mu-axis-text"
              >
                {Math.round(ratio * 100)}%
              </text>
            </g>
          );
        })}

        {series.map((point, index) => {
          const xCenter = pad.left + slotW * index + slotW / 2;
          const barH =
            point.accountedUsd > 0
              ? Math.max(2, (point.accountedUsd / maxSpend) * plotH)
              : 0;
          const isHovered = activeIndex === index;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG bar groups represent chart data points with keyboard focus.
            <g
              key={point.bucket}
              role="button"
              className="mu-bar-group"
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveIndex(index);
                }
              }}
              tabIndex={0}
              aria-label={`${point.label}: ${formatUsd(point.accountedUsd)}, cache hit ${formatPercent(point.cacheHitRate)}`}
            >
              <rect
                x={pad.left + slotW * index}
                y={pad.top}
                width={slotW}
                height={plotH}
                className={isHovered ? "mu-hover-band active" : "mu-hover-band"}
              />
              {barH > 0 && (
                <rect
                  x={xCenter - barW / 2}
                  y={pad.top + plotH - barH}
                  width={barW}
                  height={barH}
                  fill="#6366f1"
                  fillOpacity={isHovered ? 0.95 : 0.72}
                  rx={2}
                />
              )}
              {(index % labelEvery === 0 || index === series.length - 1) && (
                <text
                  x={xCenter}
                  y={height - 8}
                  textAnchor="middle"
                  className="mu-axis-text"
                >
                  {point.label}
                </text>
              )}
            </g>
          );
        })}

        {cachePoints.length > 1 && (
          <polyline
            fill="none"
            stroke="#10b981"
            strokeWidth="2.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polyline}
            pointerEvents="none"
          />
        )}
        {cachePoints.map((pt) => (
          <circle
            key={pt.index}
            cx={pt.x}
            cy={pt.y}
            r={activeIndex === pt.index ? 4.5 : 3}
            fill="#10b981"
            stroke="var(--ui-surface)"
            strokeWidth="1.5"
            pointerEvents="none"
          />
        ))}
      </svg>
      <div className="mu-chart-readout" aria-live="polite">
        {active ? (
          <>
            <strong>{active.label} UTC</strong>
            <span>Spend {formatUsd(active.accountedUsd)}</span>
            <span>Cache hit {formatPercent(active.cacheHitRate)}</span>
            <span>{active.calls} calls</span>
          </>
        ) : (
          <span className="muted">
            Bars show USD spend (left axis); green line tracks prompt cache hit
            rate (right axis).
          </span>
        )}
      </div>
    </div>
  );
}

export function SourceDonutChart({
  groups,
  totalTokens,
  totalCalls,
  selectedSource,
  onSelectSource,
}: {
  groups: ModelUsageGroupSummary[];
  totalTokens: number;
  totalCalls: number;
  selectedSource?: string;
  onSelectSource: (source: UsageSourceKind | "") => void;
}) {
  const size = 152;
  const stroke = 22;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="mu-donut-layout">
      <div className="mu-donut-figure">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label="Token share by usage source"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--ui-border)"
            strokeWidth={stroke}
          />
          {totalTokens > 0 &&
            groups.map((group) => {
              const fraction = group.totalTokens / totalTokens;
              if (fraction <= 0) return null;
              const dash = Math.max(2, fraction * circumference);
              const dashOffset = -offset;
              offset += dash;
              const isSelected = selectedSource === group.key;
              return (
                <circle
                  key={group.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={sourceColor(group.key)}
                  strokeWidth={isSelected ? stroke + 4 : stroke}
                  strokeDasharray={`${dash} ${circumference}`}
                  strokeDashoffset={dashOffset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                >
                  <title>{`${group.label}: ${group.totalTokens.toLocaleString()} tokens (${formatPercent(group.shareOfTokens)})`}</title>
                </circle>
              );
            })}
          <text
            x={size / 2}
            y={size / 2 - 4}
            textAnchor="middle"
            className="mu-donut-total"
          >
            {formatCompactTokens(totalTokens)}
          </text>
          <text
            x={size / 2}
            y={size / 2 + 16}
            textAnchor="middle"
            className="mu-donut-sub"
          >
            {totalCalls.toLocaleString()} calls
          </text>
        </svg>
      </div>
      <ul className="mu-breakdown-list">
        {groups.map((group) => {
          const isSelected = selectedSource === group.key;
          return (
            <li key={group.key}>
              <button
                type="button"
                className={`mu-breakdown-row${isSelected ? " active" : ""}`}
                onClick={() =>
                  onSelectSource(
                    isSelected ? "" : (group.key as UsageSourceKind),
                  )
                }
              >
                <span className="mu-breakdown-name">
                  <i
                    className="mu-dot"
                    style={{ background: sourceColor(group.key) }}
                  />
                  <strong>{group.label}</strong>
                </span>
                <span className="mu-breakdown-metrics">
                  <strong>{formatCompactTokens(group.totalTokens)}</strong>
                  <small className="mu-sub-note">
                    {formatPercent(group.shareOfTokens)} · {group.calls} calls ·{" "}
                    {formatUsd(group.accountedUsd)}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ModelStackedBars({
  groups,
  selectedModel,
  onSelectModel,
}: {
  groups: ModelUsageGroupSummary[];
  selectedModel?: string;
  onSelectModel: (model: string) => void;
}) {
  const maxTokens = Math.max(...groups.map((g) => g.totalTokens), 1);
  return (
    <ul className="mu-model-bars">
      {groups.map((group) => {
        const isSelected = selectedModel === group.key;
        const widthPct = Math.max(2, (group.totalTokens / maxTokens) * 100);
        const breakdownSum =
          group.inputTokens +
          group.cacheReadTokens +
          group.cacheWriteTokens +
          group.outputTokens;
        const denom = Math.max(group.totalTokens, breakdownSum, 1);
        const unattributed = Math.max(0, group.totalTokens - breakdownSum);
        const inPct = ((group.inputTokens + unattributed) / denom) * 100;
        const crPct = (group.cacheReadTokens / denom) * 100;
        const cwPct = (group.cacheWriteTokens / denom) * 100;
        const outPct = (group.outputTokens / denom) * 100;
        return (
          <li key={group.key}>
            <button
              type="button"
              className={`mu-model-row${isSelected ? " active" : ""}`}
              onClick={() => onSelectModel(isSelected ? "" : group.key)}
            >
              <div className="mu-model-head">
                <span className="mu-model-title">
                  <strong className="mono">{group.label}</strong>
                  {group.sublabel && (
                    <span className="muted">{group.sublabel}</span>
                  )}
                </span>
                <span className="mu-model-stats">
                  <strong>{formatCompactTokens(group.totalTokens)}</strong>
                  <span className="muted">{formatUsd(group.accountedUsd)}</span>
                </span>
              </div>
              <div className="mu-bar-track" aria-hidden="true">
                <div className="mu-bar-fill" style={{ width: `${widthPct}%` }}>
                  {inPct > 0 && (
                    <span
                      className="mu-bar-seg"
                      style={{
                        width: `${inPct}%`,
                        background: TOKEN_COLORS.input,
                      }}
                    />
                  )}
                  {crPct > 0 && (
                    <span
                      className="mu-bar-seg"
                      style={{
                        width: `${crPct}%`,
                        background: TOKEN_COLORS.cacheRead,
                      }}
                    />
                  )}
                  {cwPct > 0 && (
                    <span
                      className="mu-bar-seg"
                      style={{
                        width: `${cwPct}%`,
                        background: TOKEN_COLORS.cacheWrite,
                      }}
                    />
                  )}
                  {outPct > 0 && (
                    <span
                      className="mu-bar-seg"
                      style={{
                        width: `${outPct}%`,
                        background: TOKEN_COLORS.output,
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="mu-model-foot muted">
                <span>{group.calls.toLocaleString()} calls</span>
                <span>Cache {formatPercent(group.cacheHitRate)}</span>
                <span>Avg latency {formatLatency(group.avgLatencyMs)}</span>
                <span>{formatPercent(group.shareOfTokens)} share</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ActorBreakdownBars({
  groups,
}: {
  groups: ModelUsageGroupSummary[];
}) {
  const maxTokens = Math.max(...groups.map((g) => g.totalTokens), 1);
  return (
    <ul className="mu-actor-bars">
      {groups.map((group) => {
        const widthPct = Math.max(2, (group.totalTokens / maxTokens) * 100);
        return (
          <li key={group.key} className="mu-actor-row">
            <div className="mu-model-head">
              <strong>{group.label}</strong>
              <span className="mu-model-stats">
                <strong>{formatCompactTokens(group.totalTokens)}</strong>
                <span className="muted">{formatUsd(group.accountedUsd)}</span>
              </span>
            </div>
            <div className="mu-bar-track" aria-hidden="true">
              <div
                className="mu-bar-fill"
                style={{ width: `${widthPct}%`, background: "#3b82f6" }}
              />
            </div>
            <div className="mu-model-foot muted">
              <span>{group.calls.toLocaleString()} calls</span>
              <span>In {formatCompactTokens(group.inputTokens)}</span>
              <span>Cache {formatCompactTokens(group.cacheReadTokens)}</span>
              <span>Out {formatCompactTokens(group.outputTokens)}</span>
              <span>{formatPercent(group.shareOfTokens)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TokenCompositionBar({
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens,
  reasoningTokens,
  totalTokens,
}: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}) {
  const breakdownSum =
    inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  const unattributed = Math.max(0, totalTokens - breakdownSum);
  const denom = Math.max(totalTokens, breakdownSum, 1);
  const segments = [
    {
      label: "Uncached input",
      value: inputTokens,
      color: TOKEN_COLORS.input,
    },
    {
      label: "Cache read",
      value: cacheReadTokens,
      color: TOKEN_COLORS.cacheRead,
    },
    {
      label: "Cache write",
      value: cacheWriteTokens,
      color: TOKEN_COLORS.cacheWrite,
    },
    {
      label: "Output",
      value: outputTokens,
      color: TOKEN_COLORS.output,
    },
    ...(unattributed > 0
      ? [
          {
            label: "Total-only (legacy)",
            value: unattributed,
            color: "#94a3b8",
          },
        ]
      : []),
  ];

  return (
    <div className="mu-composition">
      <div
        className="mu-composition-bar"
        role="img"
        aria-label="Token composition proportion bar"
      >
        {totalTokens > 0 &&
          segments.map((seg) =>
            seg.value > 0 ? (
              <span
                key={seg.label}
                className="mu-bar-seg"
                style={{
                  width: `${(seg.value / denom) * 100}%`,
                  background: seg.color,
                }}
                title={`${seg.label}: ${seg.value.toLocaleString()} (${formatPercent(seg.value / denom)})`}
              />
            ) : null,
          )}
      </div>
      <dl className="mu-composition-list">
        {segments.map((seg) => (
          <div key={seg.label}>
            <dt>
              <i className="mu-dot" style={{ background: seg.color }} />
              {seg.label}
            </dt>
            <dd>
              <strong>{seg.value.toLocaleString()}</strong>
              <small className="mu-sub-note">
                {formatPercent(totalTokens > 0 ? seg.value / denom : 0)}
              </small>
            </dd>
          </div>
        ))}
        {reasoningTokens > 0 && (
          <div>
            <dt>
              <i
                className="mu-dot"
                style={{ background: TOKEN_COLORS.reasoning }}
              />
              Reasoning (subset of output)
            </dt>
            <dd>
              <strong>{reasoningTokens.toLocaleString()}</strong>
              <small className="mu-sub-note">
                {formatPercent(
                  outputTokens > 0 ? reasoningTokens / outputTokens : 0,
                )}
              </small>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
