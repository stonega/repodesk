import { SkeletonCells } from "./skeleton.tsx";

const labels: Record<string, string> = {
  id: "ID",
  actor: "Requested by",
  at: "Time",
  chatId: "Telegram chat ID",
  topicId: "Topic ID",
  skillId: "Skill",
  skillPins: "Skill versions",
  workflowId: "Workflow ID",
  runId: "Run ID",
  remoteId: "Telegram message ID",
  providerState: "Provider retention",
  actualUsd: "Actual cost (USD)",
  budgetUsd: "Run budget (USD)",
  reserved: "Reserved cost (USD)",
  actual: "Actual cost (USD)",
  tools: "Tools",
  transcript: "Conversation checkpoints",
  url: "Link",
  body: "Content",
  provenance: "Source",
  spec: "Configuration",
  payload: "Proposal details",
  dependents: "Dependent workflows",
  allowed: "Allowed users",
  revoked: "Users losing access",
  maxWords: "Maximum words",
};
export function detailLabel(key: string): string {
  return (
    labels[key] ??
    key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/^./, (c) => c.toUpperCase())
  );
}

export function DataTable({
  rows,
  columns,
  label,
}: {
  rows: Record<string, unknown>[] | undefined;
  columns: { key: string; label: string }[];
  label: string;
}) {
  if (rows && !rows.length)
    return <p className="muted">No {label.toLowerCase()}.</p>;
  return (
    <section
      className="data-table-scroll"
      aria-label={label}
      aria-busy={!rows}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Allows keyboard scrolling of overflowing tables.
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!rows ? (
            <SkeletonCells columns={columns.length} />
          ) : (
            rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Read-only ordered API rows may not carry IDs.
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key}>
                    <DataDetails value={row[column.key]} name={column.key} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

/** Render structured API results as readable details, including unknown tool fields. */
export function DataDetails({
  value,
  name = "",
  depth = 0,
}: {
  value: unknown;
  name?: string;
  depth?: number;
}) {
  if (value === undefined || value === null)
    return <span className="muted">Not available</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") {
    const currency = /Usd$|^(reserved|actual)$/.test(name);
    return (
      <span>
        {currency
          ? new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 6,
            }).format(value)
          : value.toLocaleString()}
      </span>
    );
  }
  if (typeof value === "string") {
    if (!value) return <span className="muted">None</span>;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)))
      return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
    if (depth < 12 && /^[[{]/.test(value.trim())) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object")
          return <DataDetails value={parsed} name={name} depth={depth + 1} />;
      } catch {
        /* User-authored text is displayed literally. */
      }
    }
    if (/^(url|link)$/.test(name) && /^https?:\/\//.test(value))
      return (
        <a href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      );
    return (
      <span className="detail-text">
        {[
          "status",
          "state",
          "kind",
          "scope",
          "frequency",
          "decision",
          "providerState",
        ].includes(name)
          ? detailLabel(value)
          : value}
      </span>
    );
  }
  if (depth >= 16)
    return (
      <span className="muted">Additional nested details are unavailable.</span>
    );
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">None</span>;
    return (
      <ul className="detail-list">
        {value.map((item, index) => (
          // Records can lack identifiers or have duplicate IDs; this list is read-only.
          // biome-ignore lint/suspicious/noArrayIndexKey: Ordered immutable API result.
          <li key={index}>
            <DataDetails value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    if (!entries.length) return <span className="muted">None</span>;
    return (
      <dl className="data-details">
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{detailLabel(key)}</dt>
            <dd>
              <DataDetails value={item} name={key} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="muted">Not available</span>;
}
