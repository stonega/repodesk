import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessRequest } from "../src/domain.ts";
import { IconButton } from "./icon-button.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

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
  const [refreshAt, setRefreshAt] = useState<number>();
  const [seconds, setSeconds] = useState(10);
  const latestLoad = useRef(0);
  const memberVersion = useRef<number | undefined>(undefined);
  const changed = useRef(onChange);
  changed.current = onChange;
  const load = useCallback(async () => {
    const sequence = ++latestLoad.current;
    setLoading(true);
    setError("");
    try {
      const next = await request<Requests>(endpoint);
      if (sequence !== latestLoad.current) return;
      setData(next);
      setCopyStatus(null);
      setRefreshAt(Date.now() + 10_000);
      setSeconds(10);
      if (
        memberVersion.current !== undefined &&
        memberVersion.current !== next.version
      )
        changed.current();
      memberVersion.current = next.version;
    } catch (error) {
      if (sequence === latestLoad.current) setError((error as Error).message);
    } finally {
      if (sequence === latestLoad.current) setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void endpoint;
    setData(undefined);
    setRefreshAt(undefined);
    memberVersion.current = undefined;
    return () => {
      latestLoad.current++;
    };
  }, [endpoint]);
  useEffect(() => {
    void refreshKey;
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (!data?.requestUrl || !refreshAt || error || loading || busy) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((refreshAt - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) {
        clearInterval(timer);
        void load();
      }
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [data?.requestUrl, refreshAt, error, loading, busy, load]);
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
      </div>
      <p>
        Invite links add members automatically. Requests sent without an invite
        still need approval. Admin permissions are managed separately.
      </p>
      {data?.requestUrl && (
        <div className="card access-link-card">
          <div className="access-link-details">
            <h3>Share this link with someone who needs access</h3>
            <p className="access-link-url">{data.requestUrl}</p>
            <p className="muted">
              One Telegram account per link. No approval required. Copied links
              remain valid for 24 hours.
            </p>
            <p
              className="muted"
              role="timer"
              aria-label="Invite link refresh"
              aria-live="off"
            >
              {error
                ? "Link refresh paused."
                : loading
                  ? "Updating link…"
                  : `New link in ${seconds}s`}
            </p>
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
      <ErrorToast
        message={
          copyStatus === "failed"
            ? "Could not copy the link. Select the URL to copy it."
            : error
        }
      >
        {error && (
          <button
            type="button"
            aria-label="Reload access requests"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Retry
          </button>
        )}
      </ErrorToast>
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
