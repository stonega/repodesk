import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessRequest } from "../src/domain.ts";
import { Modal, ModalActions } from "./modal.tsx";
import { ServiceUrl } from "./service-url.tsx";
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
  inviteOpen,
  onCloseInvite,
}: {
  id: string;
  request: Request;
  onChange: () => void;
  refreshKey?: unknown;
  inviteOpen: boolean;
  onCloseInvite: () => void;
}) {
  const endpoint = `/api/admin/workspaces/${id}/access-requests`;
  const [data, setData] = useState<Requests>();
  const [error, setError] = useState("");
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshAt, setRefreshAt] = useState<number>();
  const [remainingMs, setRemainingMs] = useState(10_000);
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
      setRefreshAt(Date.now() + 10_000);
      setRemainingMs(10_000);
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
      const remaining = Math.max(0, refreshAt - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) {
        clearInterval(timer);
        void load();
      }
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [data?.requestUrl, refreshAt, error, loading, busy, load]);
  const decide = async (
    entry: AccessRequest,
    decision: "approved" | "rejected",
  ) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
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
  const refreshLabel = error
    ? "Link refresh paused."
    : loading
      ? "Updating link…"
      : `New link in ${Math.ceil(remainingMs / 1000)}s`;
  return (
    <>
      <section
        className="card access-requests-card"
        aria-label="Access requests"
        aria-busy={loading}
      >
        <h2>Access requests{data ? ` (${data.items.length})` : ""}</h2>
        <p>
          Requests sent without an invite need approval. Admin permissions are
          managed separately.
        </p>
        <ErrorToast message={inviteOpen ? "" : error}>
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
      {inviteOpen && (
        <Modal title="Add member" onClose={onCloseInvite}>
          <div className="group-link-details">
            <p>
              Share this link with someone who needs access. Opening it in
              Telegram adds them to this workspace as a regular member, without
              approval. Admin permissions are managed separately.
            </p>
            <dl className="service-urls">
              <ServiceUrl
                label="Access link"
                labelSuffix={
                  data?.requestUrl ? (
                    <span
                      className={`access-link-timer${error || busy ? " is-paused" : ""}`}
                      role="timer"
                      aria-label="Invite link refresh"
                      aria-live="off"
                      title={refreshLabel}
                    >
                      <svg
                        className={
                          loading && !error ? "icon-spinning" : undefined
                        }
                        width="18"
                        height="18"
                        viewBox="0 0 20 20"
                        fill="none"
                        strokeWidth="2"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <circle
                          className="access-link-timer-track"
                          cx="10"
                          cy="10"
                          r="8"
                        />
                        <circle
                          className="access-link-timer-progress"
                          cx="10"
                          cy="10"
                          r="8"
                          pathLength="100"
                          strokeDasharray={
                            loading && !error ? "25 75" : "100 100"
                          }
                          strokeDashoffset={
                            loading && !error ? 0 : 100 - remainingMs / 100
                          }
                          transform="rotate(-90 10 10)"
                        />
                      </svg>
                      <span className="sr-only">{refreshLabel}</span>
                    </span>
                  ) : undefined
                }
                value={data?.requestUrl ?? undefined}
                loading={loading}
                copyFailureText="Could not copy the link. Select the URL to copy it."
              />
            </dl>
            {loading && !data && (
              <p className="muted" role="status">
                Loading invite link…
              </p>
            )}
            {!loading && data && !data.requestUrl && !error && (
              <p role="status">
                Connect your Telegram bot before inviting members.
              </p>
            )}
            <p className="muted">
              One Telegram account per link. No approval required. Copied links
              remain valid for 24 hours.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <ModalActions>
              {error && (
                <button
                  type="button"
                  className="secondary"
                  aria-label="Reload access requests"
                  disabled={busy || loading}
                  onClick={() => void load()}
                >
                  Retry
                </button>
              )}
            </ModalActions>
          </div>
        </Modal>
      )}
    </>
  );
}
