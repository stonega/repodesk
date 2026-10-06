import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessRequest } from "../src/domain.ts";
import { IconButton } from "./icon-button.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { useToast } from "./toast.tsx";

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
  const notify = useToast();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setCopyStatus(null);
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
  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current);
    },
    [],
  );
  const decide = async (
    entry: AccessRequest,
    decision: "approved" | "rejected",
  ) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setCopyStatus(null);
    try {
      await request(`${endpoint}/${entry.id}/decision`, "POST", {
        decision,
        version: data.version,
      });
      notify(`Access ${decision} for ${entry.name || entry.actor}.`);
      onChange();
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async () => {
    if (!data?.requestUrl) return;
    if (copyResetTimer.current !== null) {
      clearTimeout(copyResetTimer.current);
      copyResetTimer.current = null;
    }
    try {
      await navigator.clipboard.writeText(data.requestUrl);
      setCopyStatus("copied");
      copyResetTimer.current = setTimeout(() => {
        setCopyStatus(null);
        copyResetTimer.current = null;
      }, 1000);
    } catch {
      setCopyStatus("failed");
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
        <div className="card access-link-card">
          <div className="access-link-details">
            <h3>Share this link with people who need access</h3>
            <p className="access-link-url">{data.requestUrl}</p>
          </div>
          <IconButton
            icon={copyStatus === "copied" ? "done" : "copy"}
            label={
              copyStatus === "copied"
                ? "Copied access link"
                : "Copy access link"
            }
            onClick={() => void copyLink()}
          />
        </div>
      )}
      {copyStatus === "failed" && (
        <p className="notice" role="alert">
          Could not copy the link. Select the URL above to copy it.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {loading && !data && !error && (
        <SkeletonRows label="Access requests" rows={2} />
      )}
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
