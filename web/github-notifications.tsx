import { useEffect, useState } from "react";
import type {
  GitHubSubscription,
  NotificationEvent,
  NotificationInput,
  NotificationPage,
} from "../src/github/notifications.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const explain = (e: unknown) => {
  const code = e instanceof Error ? e.message : String(e);
  return (
    (
      {
        version_conflict:
          "This subscription changed. Close the editor and reload saved subscriptions before trying again.",
        github_repository_not_connected:
          "Connect and select this repository before subscribing.",
        github_user_access_denied:
          "You no longer have access to this repository.",
        github_notification_connection_revoked:
          "Refresh or reconnect the GitHub installation before resuming this subscription.",
        github_user_access_unavailable:
          "GitHub permissions are unavailable. Sync your GitHub account in Telegram and try again.",
        notification_repository_required: "Choose a repository.",
        telegram_identity_required:
          "Link your Telegram identity from Account before managing personal subscriptions.",
      } as Record<string, string>
    )[code] ?? "Could not update notifications. Please try again."
  );
};
export function GitHubNotificationSettings({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github/notifications`;
  const [page, setPage] = useState<NotificationPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    saved?: GitHubSubscription;
    repository: string;
    events: NotificationEvent[];
  }>();
  const [removing, setRemoving] = useState<GitHubSubscription>();
  const [hookOpen, setHookOpen] = useState(false);
  const [hookSecret, setHookSecret] = useState("");
  const [generated, setGenerated] = useState<string>();
  const notify = useToast();
  const load = async () => {
    setError("");
    try {
      setPage(await request<NotificationPage>(endpoint));
    } catch (e) {
      setError(explain(e));
    }
  };
  useEffect(() => {
    let active = true;
    void request<NotificationPage>(endpoint)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((e) => {
        if (active) setError(explain(e));
      });
    return () => {
      active = false;
    };
  }, [request, endpoint]);
  const save = async (input: NotificationInput) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setPage(await request<NotificationPage>(endpoint, "POST", input));
      setEditing(undefined);
      setRemoving(undefined);
      notify(
        input.action === "delete"
          ? "Subscription deleted."
          : "Notification subscription saved.",
      );
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const dialog = editing || removing || hookOpen;
  return (
    <>
      <PluginDetailHeading title="GitHub notifications" backTo={backTo} />
      <section
        className="card notification-card"
        aria-label="Personal repository notifications"
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Subscriptions</h2>
            <p className="muted">
              New PRs and issues go to your private Telegram chat.
            </p>
          </div>
          <IconButton
            icon="add"
            label="New subscription"
            showLabel
            disabled={!page?.canManage || !page.repositories.length || busy}
            onClick={() => {
              setError("");
              setEditing({
                repository: "",
                events: ["pull_request", "issues"],
              });
            }}
          />
        </div>
        {!page && <SkeletonRows label="Notification subscriptions" rows={2} />}
        {page && !page.canManage && (
          <p>
            Link your Telegram identity from Account to manage your personal
            subscriptions. You must be an active workspace member.
          </p>
        )}
        {page?.canManage && !page.repositories.length && (
          <p>
            No repositories are available. Connect GitHub and check your
            repository access.
          </p>
        )}
        {page?.canManage && !page.subscriptions.length && (
          <p>
            No subscriptions yet. Choose New or ask the bot to notify you about
            a connected repository.
          </p>
        )}
        {page?.subscriptions.map((s) => (
          <article
            className="notification-subscription"
            key={s.id}
            aria-label={s.repository}
          >
            <div className="notification-summary">
              <strong>{s.repository}</strong>
              <span>
                {s.events
                  .map((e) => (e === "issues" ? "New issues" : "New PRs"))
                  .join(" · ")}
              </span>
              <span className="muted">
                {!s.enabled
                  ? "Paused"
                  : s.available
                    ? "Enabled"
                    : "Access unavailable"}
                {s.lastDelivery
                  ? ` · Last delivery: ${s.lastDelivery.replaceAll("_", " ")}`
                  : ""}
              </span>
            </div>
            <div className="actions">
              <IconButton
                icon="edit"
                label={`Edit ${s.repository}`}
                disabled={busy}
                onClick={() => {
                  setError("");
                  setEditing({
                    saved: s,
                    repository: String(s.repositoryId),
                    events: [...s.events],
                  });
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void save({
                    action: s.enabled ? "pause" : "resume",
                    repository: s.id,
                    revision: s.revision,
                  })
                }
              >
                {s.enabled ? "Pause" : "Resume"}
              </button>
              <IconButton
                icon="delete"
                label={`Delete ${s.repository}`}
                disabled={busy}
                onClick={() => {
                  setError("");
                  setRemoving(s);
                }}
              />
            </div>
          </article>
        ))}
      </section>
      <section className="card" aria-label="GitHub notification delivery">
        <div className="plugin-card-heading">
          <h2>Delivery</h2>
          {page?.canConfigureWebhook && (
            <IconButton
              icon="edit"
              label="Edit webhook secret"
              disabled={busy}
              onClick={() => {
                setError("");
                setHookSecret("");
                setGenerated(undefined);
                setHookOpen(true);
              }}
            />
          )}
        </div>
        {page?.webhookUrl && (
          <p className="notification-webhook-url">
            Webhook URL: <code>{page.webhookUrl}</code>
          </p>
        )}
        <p>
          Notifications run independently of Review Bot and Codex. Draft PRs are
          included and labeled. Only events opened after subscribing are sent.
        </p>
        {page && (
          <p>
            Webhook secret:{" "}
            {page.webhookConfigured ? "Configured" : "Not configured"}.
          </p>
        )}
        <p>
          In your GitHub App settings, enable webhook delivery to RepoDesk’s
          public HTTPS address and subscribe to Issues and Pull requests.
          Existing Apps need Issues added. A saved secret does not verify GitHub
          delivery.
        </p>
      </section>
      {editing && (
        <Modal
          title={editing.saved ? "Edit subscription" : "New subscription"}
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
              if (!editing.events.length) {
                setError("Select at least one event.");
                return;
              }
              void save({
                action: "subscribe",
                repository: editing.repository,
                events: editing.events,
                revision: editing.saved?.revision,
              });
            }}
          >
            <label htmlFor="notification-repository">
              Repository
              <Select
                id="notification-repository"
                value={editing.repository}
                disabled={busy || !!editing.saved}
                required
                onChange={(e) =>
                  setEditing({ ...editing, repository: e.target.value })
                }
              >
                <option value="">Choose a repository</option>
                {page?.repositories.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.full_name}
                  </option>
                ))}
                {editing.saved &&
                  !page?.repositories.some(
                    (r) => r.id === editing.saved?.repositoryId,
                  ) && (
                    <option value={String(editing.saved.repositoryId)}>
                      {editing.saved.repository}
                    </option>
                  )}
              </Select>
            </label>
            <fieldset disabled={busy}>
              <legend>Notify me about</legend>
              {(["pull_request", "issues"] as const).map((event) => (
                <label className="plugin-check" key={event}>
                  <input
                    type="checkbox"
                    checked={editing.events.includes(event)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        events: e.target.checked
                          ? [...editing.events, event]
                          : editing.events.filter((v) => v !== event),
                      })
                    }
                  />
                  {event === "issues" ? "New issues" : "New PRs"}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              Destination: your private Telegram chat. Saving enables this
              subscription.
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
          title="Delete subscription"
          busy={busy}
          onClose={() => {
            setRemoving(undefined);
            setError("");
          }}
        >
          <p>
            Stop notifications for {removing.repository} and delete this
            subscription?
          </p>
          {error && <p role="alert">{error}</p>}
          <ModalActions>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save({
                  action: "delete",
                  repository: removing.id,
                  revision: removing.revision,
                })
              }
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </ModalActions>
        </Modal>
      )}
      {hookOpen && (
        <Modal
          title="Edit webhook secret"
          busy={busy}
          onClose={() => {
            setHookOpen(false);
            setHookSecret("");
            setGenerated(undefined);
            setError("");
          }}
        >
          {generated ? (
            <>
              <p>
                Save this secret in your GitHub App’s webhook settings. It is
                shown only here and is shared with Review Bot and your other
                workspaces.
              </p>
              <code className="notification-webhook-url">{generated}</code>
              <ModalActions>
                <button
                  type="button"
                  onClick={() => {
                    setHookOpen(false);
                    setGenerated(undefined);
                  }}
                >
                  Done
                </button>
              </ModalActions>
            </>
          ) : (
            <form
              className="record-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  const result = await request<{ secret: string }>(
                    `${endpoint}/webhook`,
                    "POST",
                    { secret: hookSecret.trim() || undefined },
                  );
                  setGenerated(result.secret);
                  setHookSecret("");
                  setPage((p) => (p ? { ...p, webhookConfigured: true } : p));
                } catch (e) {
                  setError(explain(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                Changing this shared secret also requires updating GitHub.
                Saving here does not update GitHub.
              </p>
              <label>
                Secret (leave blank to generate)
                <input
                  type="password"
                  autoComplete="new-password"
                  value={hookSecret}
                  minLength={32}
                  maxLength={8192}
                  disabled={busy}
                  onChange={(e) => setHookSecret(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
              <ModalActions>
                <button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save secret"}
                </button>
              </ModalActions>
            </form>
          )}
        </Modal>
      )}
      {error && !dialog && (
        <ErrorToast message={error}>
          <button type="button" onClick={() => void load()} disabled={busy}>
            Retry
          </button>
        </ErrorToast>
      )}
    </>
  );
}
