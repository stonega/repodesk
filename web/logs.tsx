import { useEffect, useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { LogRefresh } from "./log-refresh.tsx";
import { Pagination } from "./pagination.tsx";
import { Select } from "./select.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast } from "./toast.tsx";

type LogEntry = {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  service: "app" | "worker";
  event: string;
  message: string;
  code?: string;
  run_id?: string;
  retry_delay_ms?: number;
};
type LogPage = {
  items: LogEntry[];
  nextBefore?: string;
  retentionDays: number;
  maxEntries: number;
};

export function RuntimeLogs({
  request,
}: {
  request: (path: string) => Promise<LogPage>;
}) {
  const [level, setLevel] = useState("");
  const [service, setService] = useState("");
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const [cursors, setCursors] = useState<{ before: string; offset: number }[]>(
    [],
  );
  const before = cursors.at(-1)?.before;
  const offset = cursors.at(-1)?.offset ?? 0;
  const [refreshInterval, setRefreshInterval] = useState(60000);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    page: LogPage;
    at: string;
  }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const params = new URLSearchParams({ limit: "50" });
  if (level) params.set("level", level);
  if (service) params.set("service", service);
  if (queryText) params.set("q", queryText);
  if (before) params.set("before", before);
  const query = params.toString();
  useEffect(() => {
    void revision;
    let live = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      setLoading(true);
      setError("");
      try {
        const page = await request(`/api/admin/operator/logs?${query}`);
        if (live) {
          setResult({ query, page, at: new Date().toISOString() });
          setError("");
        }
      } catch (cause) {
        if (live) {
          setResult(undefined);
          setError((cause as Error).message);
        }
      } finally {
        fetching = false;
        if (live) setLoading(false);
      }
    };
    void refresh();
    return () => {
      live = false;
    };
  }, [request, query, revision]);
  useEffect(() => {
    if (!refreshInterval || before || loading) return;
    const timer = setInterval(
      () => setRevision((value) => value + 1),
      refreshInterval,
    );
    return () => clearInterval(timer);
  }, [refreshInterval, before, loading]);
  const page = result?.query === query ? result.page : undefined;
  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">REPODESK / TEAM OPERATIONS</p>
        <h1>Runtime logs</h1>
        <p className="muted">
          API, worker and Telegram reception events. Credentials and message
          contents are excluded.
        </p>
      </header>
      <section className="card" aria-label="Log controls">
        <form
          className="log-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQueryText(search.trim());
            setCursors([]);
            setRevision((value) => value + 1);
          }}
        >
          <label className="field" htmlFor="logs-level">
            <span>Log level</span>
            <Select
              id="logs-level"
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
                setCursors([]);
              }}
            >
              <option value="">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </Select>
          </label>
          <label className="field" htmlFor="logs-service">
            <span>Service</span>
            <Select
              id="logs-service"
              value={service}
              onChange={(event) => {
                setService(event.target.value);
                setCursors([]);
              }}
            >
              <option value="">All services</option>
              <option value="app">API</option>
              <option value="worker">Worker</option>
            </Select>
          </label>
          <label className="field">
            <span>Search event, error code or run ID</span>
            <input
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="e.g. polling or run_failed"
            />
          </label>
          <IconButton icon="search" label="Search logs" type="submit" />
        </form>
        <div className="row">
          <LogRefresh
            interval={refreshInterval}
            loading={loading}
            onIntervalChange={setRefreshInterval}
            onRefresh={() => setRevision((value) => value + 1)}
          />
          <IconButton
            icon="latest"
            label="Latest logs"
            type="button"
            onClick={() => {
              setCursors([]);
              setRevision((value) => value + 1);
            }}
          />
        </div>
        <p className="muted" role="status">
          {error
            ? "Logs unavailable."
            : result
              ? `Updated ${new Date(result.at).toLocaleTimeString()}. Newest entries first.`
              : ""}
          {!!refreshInterval &&
            before &&
            " Viewing older entries; automatic refresh is paused."}
        </p>
      </section>
      <ErrorToast message={error}>
        <button
          type="button"
          aria-label="Retry loading logs"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Retry
        </button>
      </ErrorToast>
      <section
        className="card"
        aria-label="Runtime log entries"
        aria-busy={!page && !error}
      >
        {!page && !error && <SkeletonRows label="Runtime log entries" />}
        {page?.items.length === 0 && (
          <p>
            {before
              ? "No logs on this page. Use Previous page to return to newer entries."
              : "No logs match these filters. New service events will appear here."}
          </p>
        )}
        {!!page?.items.length && (
          <section
            className="log-table-scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the table horizontally.
            tabIndex={0}
            aria-label="Runtime events table"
          >
            <table className="log-table">
              <caption className="muted">Recent runtime events</caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Service</th>
                  <th>Event & details</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <time dateTime={entry.at}>
                        {new Date(entry.at).toLocaleString()}
                      </time>
                    </td>
                    <td>
                      <span className={`log-level log-${entry.level}`}>
                        {entry.level === "warn" ? "warning" : entry.level}
                      </span>
                    </td>
                    <td>{entry.service === "app" ? "API" : "Worker"}</td>
                    <td>
                      <code>{entry.event}</code>
                      <div>{entry.message}</div>
                      {entry.code && (
                        <div className="mono">Code: {entry.code}</div>
                      )}
                      {entry.retry_delay_ms != null && (
                        <div>
                          Retry delay: {Math.round(entry.retry_delay_ms / 1000)}{" "}
                          seconds
                        </div>
                      )}
                      {entry.run_id && (
                        <div className="mono">Run: {entry.run_id}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <Pagination
          className="log-pagination"
          loading={loading || (!page && !error)}
          previousDisabled={!before}
          nextDisabled={!page?.nextBefore}
          onPrevious={() => setCursors((value) => value.slice(0, -1))}
          onNext={() => {
            if (!page?.nextBefore) return;
            const cursor = {
              before: page.nextBefore,
              offset: offset + page.items.length,
            };
            setCursors((value) => [...value, cursor]);
          }}
        >
          {page
            ? page.items.length
              ? `${offset + 1}–${offset + page.items.length}`
              : "No events"
            : "Page unavailable"}
        </Pagination>
      </section>
      <p className="muted">
        Events are retained for 7 days, with cleanup limiting history to 10,000
        entries. Capture begins with this update; earlier container output is
        not imported.
      </p>
      <details>
        <summary>View container logs in the terminal</summary>
        <pre>podman compose logs --tail=100 -f app worker</pre>
        <p className="muted">
          Container logs also include startup failures that occur before
          database logging is available.
        </p>
      </details>
    </>
  );
}
