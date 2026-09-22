import { useEffect, useState } from "react";
import { IconButton } from "./icon-button.tsx";

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
  const [before, setBefore] = useState<string>();
  const [auto, setAuto] = useState(true);
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
    const timer =
      auto && !before ? setInterval(() => void refresh(), 5000) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [request, query, auto, before, revision]);
  const page = result?.query === query ? result.page : undefined;
  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">DEEPX / TEAM OPERATIONS</p>
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
            setBefore(undefined);
            setRevision((value) => value + 1);
          }}
        >
          <label className="field">
            <span>Log level</span>
            <select
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
                setBefore(undefined);
              }}
            >
              <option value="">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </label>
          <label className="field">
            <span>Service</span>
            <select
              value={service}
              onChange={(event) => {
                setService(event.target.value);
                setBefore(undefined);
              }}
            >
              <option value="">All services</option>
              <option value="app">API</option>
              <option value="worker">Worker</option>
            </select>
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
          <label className="log-auto">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            Auto-refresh every 5 seconds
          </label>
          {(!auto || error) && (
            <button
              type="button"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh logs
            </button>
          )}
          <IconButton
            icon="latest"
            label="Latest logs"
            type="button"
            onClick={() => {
              setBefore(undefined);
              setRevision((value) => value + 1);
            }}
          />
        </div>
        <p className="muted" role="status">
          {loading
            ? "Loading logs…"
            : error
              ? "Logs unavailable."
              : result
                ? `Updated ${new Date(result.at).toLocaleTimeString()}. Newest entries first.`
                : "Waiting for logs."}
          {before && " Viewing older entries; automatic refresh is paused."}
        </p>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="card" aria-label="Runtime log entries">
        {page?.items.length === 0 && (
          <p>
            No logs match these filters. New service events will appear here.
          </p>
        )}
        {!!page?.items.length && (
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
        )}
        {page?.nextBefore && (
          <IconButton
            icon="older"
            label="Older logs"
            className="log-older"
            type="button"
            disabled={loading}
            onClick={() => setBefore(page.nextBefore)}
          />
        )}
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
