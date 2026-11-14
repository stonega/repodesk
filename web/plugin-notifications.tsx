import { useEffect, useState } from "react";
import type { PluginNotificationPage } from "../src/plugins/notifications.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const explain = (e: unknown) =>
  e instanceof Error && e.message.startsWith("version_conflict")
    ? "This subscription changed. Close the editor and reload before trying again."
    : "Could not update plugin notifications. Check the plugin's current grants and your Telegram identity.";
export function PluginNotifications({
  request,
  workspaceId,
  repositoryId,
}: {
  request: Request;
  workspaceId: string;
  repositoryId: number;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugin-packages/${repositoryId}/notifications`;
  const [page, setPage] = useState<PluginNotificationPage>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string[]>();
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const load = async () => {
    setError("");
    try {
      setPage(await request<PluginNotificationPage>(endpoint));
    } catch (e) {
      setError(explain(e));
    }
  };
  useEffect(() => {
    let current = true;
    void request<PluginNotificationPage>(endpoint)
      .then((p) => {
        if (current) setPage(p);
      })
      .catch((e) => {
        if (current) setError(explain(e));
      });
    return () => {
      current = false;
    };
  }, [endpoint, request]);
  const save = async (action: string, events?: string[]) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setPage(
        await request<PluginNotificationPage>(endpoint, "POST", {
          action,
          events,
          revision: page?.subscription?.revision,
          generation: page?.generation,
        }),
      );
      setEditing(undefined);
      setRemoving(false);
      notify(
        action === "delete"
          ? "Plugin notification subscription deleted."
          : "Plugin notification subscription saved.",
      );
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const s = page?.subscription;
  return (
    <section
      className="card notification-card"
      aria-label="Plugin notifications"
    >
      <div className="plugin-card-heading">
        <div>
          <h2>Notifications</h2>
          <p className="muted">
            Declared plugin events can notify your private Telegram chat.
          </p>
        </div>
        <IconButton
          icon={s ? "edit" : "add"}
          label={
            s
              ? "Edit plugin notification subscription"
              : "New plugin notification subscription"
          }
          showLabel
          disabled={!page?.canManage || !page.events.length || busy}
          onClick={() => {
            setError("");
            setEditing(
              s
                ? s.events.filter((name) =>
                    page?.events.some((event) => event.name === name),
                  )
                : (page?.events.map((e) => e.name) ?? []),
            );
          }}
        />
      </div>
      {!page && (
        <SkeletonRows label="Plugin notification subscriptions" rows={2} />
      )}
      {page && !page.canManage && (
        <p>
          Link your Telegram identity from Account to manage your own
          subscription.
        </p>
      )}
      {page && !page.available && (
        <p>
          The plugin is disabled, its notification grant is missing, or this
          subscription belongs to an older version. Review the current plugin
          before explicitly resuming.
        </p>
      )}
      {page && !s && <p>No personal subscription yet.</p>}
      {s && (
        <>
          <div className="notification-summary">
            <strong>
              {!s.enabled
                ? "Paused"
                : page?.available
                  ? "Enabled"
                  : "Unavailable"}
            </strong>
            <span>
              {page?.events
                .filter((e) => s.events.includes(e.name))
                .map((e) => e.title)
                .join(" · ") || "Previous event selection"}
            </span>
            <span className="muted">
              Destination: your private Telegram chat.
            </span>
          </div>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void save(s.enabled && page?.available ? "pause" : "resume")
              }
            >
              {s.enabled && page?.available ? "Pause" : "Resume"}
            </button>
            <IconButton
              icon="delete"
              label="Delete plugin notification subscription"
              disabled={busy}
              onClick={() => {
                setError("");
                setRemoving(true);
              }}
            />
          </div>
        </>
      )}
      <p className="muted">
        Events are checked when a plugin tool runs in your private conversation.
        This subscription does not start a background checker.
      </p>
      {editing && (
        <Modal
          title={
            s
              ? "Edit plugin notification subscription"
              : "New plugin notification subscription"
          }
          busy={busy}
          onClose={() => {
            setEditing(undefined);
            setError("");
          }}
        >
          <form
            className="record-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.length) {
                setError("Select at least one event.");
                return;
              }
              void save("subscribe", editing);
            }}
          >
            <fieldset disabled={busy}>
              <legend>Notify me about</legend>
              {page?.events.map((event) => (
                <label className="plugin-check" key={event.name}>
                  <input
                    type="checkbox"
                    checked={editing.includes(event.name)}
                    onChange={(e) =>
                      setEditing(
                        e.target.checked
                          ? [...editing, event.name]
                          : editing.filter((n) => n !== event.name),
                      )
                    }
                  />
                  <span>
                    {event.title}
                    <span className="muted"> · {event.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p>
              Saving enables notifications from this installed version for your
              private chat.
            </p>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <ModalActions>
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Delete plugin notification subscription"
          busy={busy}
          onClose={() => {
            setRemoving(false);
            setError("");
          }}
        >
          <p>Delete your subscription and stop pending plugin notifications?</p>
          {error && <p role="alert">{error}</p>}
          <ModalActions>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save("delete")}
            >
              Delete
            </button>
          </ModalActions>
        </Modal>
      )}
      {error && !editing && !removing && (
        <ErrorToast message={error}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Retry
          </button>
        </ErrorToast>
      )}
    </section>
  );
}
