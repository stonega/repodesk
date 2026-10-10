import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "../src/domain.ts";
import type { UpdateView } from "../src/updates/releases.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { ReleaseNotes } from "./release-notes.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const errors: Record<string, string> = {
  release_changed:
    "The release changed. Close this dialog and review the latest notes before updating.",
  release_check_unavailable:
    "Could not verify the release with GitHub. Try again shortly.",
  updater_unavailable:
    "The host updater is offline. Start its service before updating.",
  update_queue_unknown:
    "The update request could not be confirmed. Check the host updater before retrying.",
};
export function ApplicationUpdate({
  session,
  request,
}: {
  session?: Session;
  request: Request;
}) {
  const [view, setView] = useState<UpdateView>();
  const [selected, setSelected] = useState<UpdateView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const target = document.getElementById("app-update");
  useEffect(() => {
    setView(undefined);
    setSelected(undefined);
    if (!session) return;
    let live = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const value = await request<UpdateView>("/api/admin/updates");
        if (live) setView(value);
      } catch {
        /* Background checks do not interrupt ordinary work. */
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [request, session]);
  // Preserve the reviewed release while polling updates only its attempt state.
  const attempt =
    view?.release?.fingerprint === selected?.release?.fingerprint
      ? view?.attempt
      : selected?.attempt;
  const start = async () => {
    const release = selected?.release;
    if (!release || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await request<UpdateView>(
        "/api/admin/operator/updates",
        "POST",
        {
          releaseId: release.id,
          fingerprint: release.fingerprint,
          ...(attempt?.state === "failed" ? { retry: true } : {}),
        },
      );
      setView(value);
      setSelected(value);
    } catch (e) {
      const message = (e as Error).message;
      setError(errors[message] ?? message);
      // Reconcile a lost response without repeating the external write.
      try {
        setView(await request<UpdateView>("/api/admin/updates"));
      } catch {
        /* Keep the reviewed notes. */
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {target &&
        view?.available &&
        createPortal(
          <IconButton
            icon="latest"
            label={`Update available: ${view.release?.tag}`}
            className="app-update-indicator"
            onClick={() => {
              setSelected(view);
              setError("");
            }}
          />,
          target,
        )}
      {selected?.release && (
        <Modal
          title="Update RepoDesk"
          onClose={() => setSelected(undefined)}
          busy={busy}
        >
          <div className="update-summary">
            <div>
              <span className="muted">Installed</span>
              <strong>v{selected.currentVersion}</strong>
            </div>
            <div>
              <span className="muted">Available</span>
              <strong>{selected.release.tag}</strong>
            </div>
          </div>
          <div className="update-release-heading">
            <h3>{selected.release.name}</h3>
            <p className="muted">
              Published{" "}
              {new Date(selected.release.publishedAt).toLocaleDateString()}
            </p>
          </div>
          <section aria-label="Changelog" className="release-notes">
            <h3>Changelog</h3>
            <div className="release-notes-text">
              {selected.release.notes ? (
                <ReleaseNotes
                  text={selected.release.notes}
                  url={selected.release.url}
                />
              ) : (
                "No changelog was included with this release."
              )}
            </div>
          </section>
          <section aria-label="Update notes">
            <h3>Update notes</h3>
            <p>
              The deployment checks this release, backs up the database, and
              applies migrations before restarting RepoDesk. Expect a brief
              interruption. Active coding work waits for a safe checkpoint.
            </p>
          </section>
          <p>
            <a href={selected.release.url} target="_blank" rel="noreferrer">
              View release on GitHub
            </a>
          </p>
          {selected.error && (
            <p role="status" className="muted">
              {selected.error}
            </p>
          )}
          {!session?.admin.operator ? (
            <p className="muted">
              Ask a deployment administrator to install this update.
            </p>
          ) : (
            !selected.configured && (
              <p className="muted">
                One-click updates need the host updater installed on this
                server.{" "}
                <a
                  href={`https://github.com/${selected.repository}/blob/main/docs/implementation/updates.md`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the update setup guide.
                </a>
              </p>
            )
          )}
          {selected.configured && !view?.updaterReady && (
            <p className="muted">
              The host updater is offline. Start its service before updating.{" "}
              <a
                href={`https://github.com/${selected.repository}/blob/main/docs/implementation/updates.md`}
                target="_blank"
                rel="noreferrer"
              >
                Read the setup guide.
              </a>
            </p>
          )}
          {attempt && (
            <p role="status">
              {attempt.state === "queued" || attempt.state === "running"
                ? "Update queued or running. The host verifies, builds and installs the selected release."
                : attempt.state === "succeeded"
                  ? "Update completed. Reload to check the installed version."
                  : attempt.state === "failed"
                    ? attempt.error === "insufficient_disk_space"
                      ? "The server does not have enough free disk space to install this update. Ask the deployment administrator to free space before retrying."
                      : attempt.error === "verification_failed"
                        ? "Verification has not passed for this release. Check GitHub Verify before retrying."
                        : attempt.error === "release_changed"
                          ? "The release changed before installation. Close this dialog and review the latest release."
                          : "The update failed. Review the host update logs and resolve the cause before retrying."
                    : "The update was interrupted or its outcome is unconfirmed. Check the host before starting another update."}
            </p>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <ModalActions>
            {session?.admin.operator &&
              selected.configured &&
              (!attempt || attempt.state === "failed") && (
                <button
                  type="button"
                  disabled={busy || !!selected.error || !view?.updaterReady}
                  onClick={() => void start()}
                >
                  {busy
                    ? "Starting update…"
                    : attempt?.state === "failed"
                      ? "Retry update"
                      : "Update now"}
                </button>
              )}
            {attempt?.state === "succeeded" && (
              <button type="button" onClick={() => window.location.reload()}>
                Reload RepoDesk
              </button>
            )}
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
