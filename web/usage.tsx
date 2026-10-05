import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { Run } from "../src/domain.ts";
import { IconButton } from "./icon-button.tsx";
import { Skeleton, SkeletonCells } from "./skeleton.tsx";

interface UsagePage {
  budget: number;
  totalUsd: number;
  total: number;
  offset: number;
  items: (Run["attempts"][number] & { runId: string; model: string })[];
}

const pageSize = 100;
const money = (value: number) =>
  value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;
const statuses = {
  settled: "Settled",
  reserved: "Reserved",
  unknown: "Unresolved",
};

export function Usage({
  id,
  request,
}: {
  id: string;
  request: <T>(path: string) => Promise<T>;
}) {
  const [params, setParams] = useSearchParams();
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const [revision, setRevision] = useState(0);
  const path = `/api/admin/workspaces/${id}/usage?offset=${offset}`;
  const key = `${path}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    data?: UsagePage;
    error?: string;
  }>();
  const loading = result?.key !== key;
  const data = loading ? undefined : result?.data;
  const error = loading ? undefined : result?.error;
  useEffect(() => {
    let live = true;
    request<UsagePage>(path).then(
      (data) => {
        if (live) setResult({ key, data });
      },
      (error: Error) => {
        if (live) setResult({ key, error: error.message });
      },
    );
    return () => {
      live = false;
    };
  }, [path, key, request]);
  function goTo(nextOffset: number) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (nextOffset) next.set("offset", String(nextOffset));
      else next.delete("offset");
      return next;
    });
  }
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">REPODESK / TEAM OPERATIONS</p>
        <div className="page-title-row">
          <h1>Usage &amp; budget</h1>
        </div>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      <section className="card" aria-busy={loading}>
        <div className="usage-summary">
          <div>
            <span className="muted">Recorded spend</span>
            <h2>
              {data ? (
                money(data.totalUsd)
              ) : error ? (
                "—"
              ) : (
                <Skeleton width="7rem" />
              )}
            </h2>
          </div>
          <div>
            <span className="muted">Monthly limit</span>
            <strong>
              {data ? (
                money(data.budget)
              ) : error ? (
                "—"
              ) : (
                <Skeleton width="6rem" />
              )}
            </strong>
          </div>
        </div>
        <p className="muted" id="usage-note">
          Recorded spend includes unresolved reservations. All amounts are in
          USD.
        </p>
        <section
          className="usage-table-scroll"
          aria-label="Usage records"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontal table region must be keyboard scrollable.
          tabIndex={0}
        >
          <table className="usage-table" aria-describedby="usage-note">
            <caption className="sr-only">Usage history</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Model / Run</th>
                <th scope="col">Status</th>
                <th scope="col" className="usage-money">
                  Reserved
                </th>
                <th scope="col" className="usage-money">
                  Actual
                </th>
              </tr>
            </thead>
            <tbody>
              {!data && !error && <SkeletonCells columns={5} />}
              {data?.items.map((item) => (
                <tr key={`${item.runId}:${item.id}`}>
                  <td>
                    <time dateTime={item.at}>
                      {new Date(item.at).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    <strong>{item.model}</strong>
                    <span
                      className="usage-run mono"
                      title={`Run ID: ${item.runId}`}
                    >
                      {item.runId}
                    </span>
                  </td>
                  <td>
                    <span className={`pill usage-${item.status}`}>
                      {statuses[item.status]}
                    </span>
                  </td>
                  <td className="usage-money">{money(item.reserved)}</td>
                  <td className="usage-money">
                    {item.actual === undefined ? (
                      <span>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">Not yet reported</span>
                      </span>
                    ) : (
                      money(item.actual)
                    )}
                  </td>
                </tr>
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="usage-empty">
                    {data.total === 0
                      ? "No usage recorded yet."
                      : "No records on this page. Go to the previous page to view usage."}
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
                onClick={() => goTo(Math.max(0, offset - pageSize))}
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
                onClick={() => goTo(offset + pageSize)}
              />
            </div>
          </div>
        )}
      </section>
    </>
  );
}
