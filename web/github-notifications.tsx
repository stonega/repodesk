import { useEffect, useState } from "react";
import type {
  AutoNotificationRepository,
  GitHubSubscription,
  NotificationEvent,
  NotificationInput,
  NotificationPage,
} from "../src/github/notifications.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const explain = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  const code = message.startsWith("version_conflict")
    ? "version_conflict"
    : message;
  return (
    (
      {
        version_conflict:
          "These notification settings changed. Close the editor and reload before trying again.",
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
  const [settingsDraft, setSettingsDraft] = useState<{
    autoNotifyMaintainers: boolean;
    revision: number;
  }>();
  const [editing, setEditing] = useState<{
    saved?: GitHubSubscription;
    autoRepository?: AutoNotificationRepository;
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
  const saveSettings = async (input: {
    autoNotifyMaintainers: boolean;
    revision: number;
  }) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setPage(
        await request<NotificationPage>(`${endpoint}/settings`, "PUT", input),
      );
      setSettingsDraft(undefined);
      notify("Maintainer notification settings saved.");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const dialog = settingsDraft || editing || removing || hookOpen;
  return (
    <>
      <PluginDetailHeading title="GitHub notifications" backTo={backTo} />
      <section
        className="card notification-card"
        aria-label="Automatic maintainer notifications"
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Repository maintainers</h2>
            <p className="muted">
              Automatically alert verified Maintain and Admin members in private
              Telegram when a PR or issue opens.
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit maintainer notifications"
            disabled={!page || busy}
            onClick={() => {
              if (!page) return;
              setError("");
              setSettingsDraft({ ...page.settings });
            }}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Status</dt>
            <dd>
              {!page ? (
                <Skeleton width="min(6rem, 100%)" />
              ) : page.settings.autoNotifyMaintainers ? (
                "Enabled"
              ) : (
                "Disabled"
              )}
            </dd>
          </div>
          <div>
            <dt>Recipients</dt>
            <dd>Verified GitHub Maintain and Admin members</dd>
          </div>
          <div>
            <dt>Events</dt>
            <dd>New PRs · New issues (self-opened items skipped)</dd>
          </div>
        </dl>
      </section>
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
        {page?.canManage &&
          !page.subscriptions.length &&
          !page.autoRepositories.length && (
            <p>
              No subscriptions yet. Choose New or ask the bot to notify you
              about a connected repository.
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
        {page?.autoRepositories.map((r) => (
          <article
            className="notification-subscription"
            key={`auto-${r.id}`}
            aria-label={r.full_name}
          >
            <div className="notification-summary">
              <strong>{r.full_name}</strong>
              <span>New PRs · New issues</span>
              <span className="muted">
                Automatic (Maintainer)
                {r.lastDelivery
                  ? ` · Last delivery: ${r.lastDelivery.replaceAll("_", " ")}`
                  : ""}
              </span>
            </div>
            <div className="actions">
              <IconButton
                icon="edit"
                label={`Edit ${r.full_name}`}
                disabled={busy}
                onClick={() => {
                  setError("");
                  setEditing({
                    autoRepository: r,
                    repository: String(r.id),
                    events: ["pull_request", "issues"],
                  });
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void save({
                    action: "pause",
                    repository: String(r.id),
                  })
                }
              >
                Pause
              </button>
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
          included and labeled. Personal subscriptions cover events opened after
          subscribing; automatic maintainer alerts skip items opened by the same
          maintainer.
        </p>
        {page && (
          <p>
            Webhook secret:{" "}
            {page.webhookConfigured ? "Configured" : "Not configured"}.
          </p>
        )}
        <p>
          In your GitHub App settings, enable webhook delivery to Telo’s public
          HTTPS address and subscribe to Issues and Pull requests. Existing Apps
          need Issues added. A saved secret does not verify GitHub delivery.
        </p>
      </section>
      {settingsDraft && (
        <Modal
          title="Edit maintainer notifications"
          busy={busy}
          onClose={() => {
            setSettingsDraft(undefined);
            setError("");
          }}
        >
          <form
            className="record-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings(settingsDraft);
            }}
          >
            <label className="plugin-check">
              <input
                type="checkbox"
                checked={settingsDraft.autoNotifyMaintainers}
                disabled={busy}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    autoNotifyMaintainers: e.target.checked,
                  })
                }
              />
              Automatically notify repository maintainers
            </label>
            <p className="muted">
              Sends private Telegram alerts for new PRs and issues to active
              members with fresh GitHub Maintain or Admin access. Self-opened
              items are skipped. Members can pause or customize individual
              repositories in Subscriptions.
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
      {editing && (
        <Modal
          title={
            editing.saved || editing.autoRepository
              ? "Edit subscription"
              : "New subscription"
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
                disabled={busy || !!editing.saved || !!editing.autoRepository}
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
                {editing.autoRepository &&
                  !page?.repositories.some(
                    (r) => r.id === editing.autoRepository?.id,
                  ) && (
                    <option value={String(editing.autoRepository.id)}>
                      {editing.autoRepository.full_name}
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
          {page?.settings.autoNotifyMaintainers && (
            <p className="muted">
              If you are a repository maintainer, automatic maintainer alerts
              will resume for this repository. Use Pause to stay muted.
            </p>
          )}
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
