import { summarizeRun } from "../src/admin/run-statistics.ts";
import type { Run } from "../src/domain.ts";
import { Skeleton } from "./skeleton.tsx";

const number = (value: number) => value.toLocaleString();
const money = (value: number) =>
  value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;

export function RunStatistics({
  run,
  statistics,
  conversation = false,
  loading,
}: {
  run?: Run;
  statistics?: ReturnType<typeof summarizeRun>;
  conversation?: boolean;
  loading: boolean;
}) {
  const stats = statistics ?? (run ? summarizeRun(run) : undefined);
  const metrics = [
    {
      label: "Messages",
      value: stats && number(stats.messages),
      detail: conversation
        ? "Requests and assistant replies"
        : "Request, replies and tool results",
    },
    {
      label: "Tool calls",
      value: stats && number(stats.toolCalls),
      detail: "Includes pending and blocked calls",
    },
    {
      label: "Model attempts",
      value: stats && number(stats.attempts),
      detail: "Includes follow-up and compaction",
    },
    {
      label: "Total tokens",
      value: stats?.tokens && number(stats.totalTokens),
      detail: stats?.tokens
        ? `${number(stats.input)} input · ${number(stats.tokens.output)} output`
        : stats
          ? "Usage not reported"
          : "Input and output tokens",
      note:
        stats && stats.tokenAttempts < stats.attempts
          ? `${stats.tokenAttempts} of ${stats.attempts} attempts reported`
          : undefined,
    },
    {
      label: "Cache hit rate",
      value:
        stats?.cacheHitRate !== undefined
          ? new Intl.NumberFormat(undefined, {
              style: "percent",
              maximumFractionDigits: 1,
            }).format(stats.cacheHitRate)
          : undefined,
      detail: stats?.tokens
        ? `${number(stats.tokens.cacheRead)} read · ${number(stats.tokens.cacheWrite)} written`
        : stats
          ? "Usage not reported"
          : "Cached reads and writes",
      note: "Cached reads / total input tokens",
    },
    {
      label: "Recorded spend",
      value: stats?.cost !== undefined ? money(stats.cost) : undefined,
      detail:
        stats && stats.costAttempts < stats.attempts
          ? `USD · ${stats.costAttempts} of ${stats.attempts} attempts reported`
          : "USD · actual charges",
    },
  ];
  return (
    <section
      className="card run-statistics"
      aria-label={conversation ? "Thread statistics" : "Run statistics"}
      aria-busy={loading}
    >
      <dl className="run-statistics-grid">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>
              <strong>
                {!stats && loading ? (
                  <Skeleton width="5rem" />
                ) : (
                  (metric.value ?? "—")
                )}
              </strong>
              <small>{metric.detail}</small>
              {metric.note && <small>{metric.note}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
