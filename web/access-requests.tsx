import { useCallback, useEffect, useState } from "react";
import type { AccessRequest } from "../src/domain.ts";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Requests = {
  version: number;
  items: AccessRequest[];
  requestUrl: string | null;
};

export function AccessRequests({
  id,
  request,
  onChange,
  refreshKey,
}: {
  id: string;
  request: Request;
  onChange: () => void;
  refreshKey?: unknown;
}) {
  const endpoint = `/api/admin/workspaces/${id}/access-requests`;
  const [data, setData] = useState<Requests>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<Requests>(endpoint));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void refreshKey;
    void load();
  }, [load, refreshKey]);
  const decide = async (
    entry: AccessRequest,
    decision: "approved" | "rejected",
  ) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await request(`${endpoint}/${entry.id}/decision`, "POST", {
        decision,
        version: data.version,
      });
      setStatus(`Access ${decision} for ${entry.name || entry.actor}.`);
      onChange();
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Access requests">
      <div className="row between">
        <h2>Access requests{data ? ` (${data.items.length})` : ""}</h2>
        {error && (
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Reload access requests
          </button>
        )}
      </div>
      <p>
        Approve to add the user as a member and allow bot access. Admin
        permissions are managed separately.
      </p>
      {data?.requestUrl && (
        <label className="field">
          Share this link with people who need access
          <input
            aria-label="Request access link"
            readOnly
            value={data.requestUrl}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {loading && !data && <p role="status">Loading access requests…</p>}
      {data?.items.length === 0 && (
        <p className="muted">No pending access requests.</p>
      )}
      {data?.items.map((entry) => (
        <article key={entry.id} className="card">
          <h3>
            {entry.name ||
              (entry.username
                ? `@${entry.username}`
                : `Telegram user ${entry.actor}`)}
          </h3>
          <p>
            Telegram ID: {entry.actor}
            {entry.username ? ` · @${entry.username}` : ""}
          </p>
          <p className="muted">
            Requested {new Date(entry.requestedAt).toLocaleString()}
          </p>
          <div className="row">
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void decide(entry, "approved")}
            >
              Approve access
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || loading}
              onClick={() => void decide(entry, "rejected")}
            >
              Reject request
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
