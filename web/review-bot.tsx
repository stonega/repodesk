import { type FormEvent, useEffect, useState } from "react";
import type { ModelSelection, ProviderCatalog } from "../src/models/config.ts";
import type {
  ReviewPage,
  ReviewSettings,
  ReviewTask,
} from "../src/review-bot/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { ModelPicker } from "./model-providers.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const explain = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith("version_conflict.")
    ? "version_conflict"
    : message;
  return (
    {
      review_repository_required:
        "Enable Codex and connect GitHub to this workspace.",
      review_webhook_required: "Configure the GitHub webhook first.",
      review_repository_already_configured:
        "This repository already has Review Bot enabled in another workspace.",
      coding_direct_execution_disabled:
        "Enable Direct execution in Codex before accepting fixes.",
      version_conflict:
        "These settings changed. Reload the saved settings and try again.",
    }[code] ?? message
  );
};

export function ReviewBot({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/review-bot`;
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [modelEditing, setModelEditing] = useState<{
    settings: ReviewSettings;
    revision: number;
  }>();
  const [modelDraft, setModelDraft] = useState<ModelSelection>();
  useEffect(() => {
    let active = true;
    void request<ProviderCatalog>("/api/admin/operator/model-providers")
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request]);
  const [page, setPage] = useState<ReviewPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hookOpen, setHookOpen] = useState(false);
  const [hookSecret, setHookSecret] = useState("");
  const [generated, setGenerated] = useState<{ secret: string; url: string }>();
  const [stopping, setStopping] = useState<ReviewTask>();
  const notify = useToast();
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setStopping(undefined);
    setError("");
    setGenerated(undefined);
    setHookSecret("");
    setHookOpen(false);
    request<ReviewPage>(endpoint)
      .then((data) => {
        if (active) {
          setPage(data);
        }
      })
      .catch((e) => {
        if (active) setError(explain(e));
      });
    const timer = setInterval(() => {
      void request<ReviewPage>(endpoint)
        .then((data) => {
          if (active) setPage(data);
        })
        .catch(() => {});
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [endpoint, request]);
  const save = async (settings: ReviewSettings, revision: number) => {
    if (!page || busy) return false;
    setBusy(true);
    setError("");
    try {
      const data = await request<ReviewPage>(endpoint, "PUT", {
        revision,
        settings,
      });
      setPage(data);
      notify("Review Bot settings saved.");
      return true;
    } catch (e) {
      setError(explain(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setPage(await request<ReviewPage>(endpoint));
      setModelEditing(undefined);
      setModelDraft(undefined);
      setError("");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const configureHook = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setGenerated(
        await request<{ secret: string; url: string }>(
          `${endpoint}/webhook`,
          "POST",
          hookSecret.trim() ? { secret: hookSecret.trim() } : {},
        ),
      );
      setPage(await request<ReviewPage>(endpoint));
      setHookSecret("");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PluginDetailHeading title="Review Bot" backTo={backTo}>
        <PluginToggle
          name="Review Bot"
          enabled={page?.settings.enabled}
          disabled={busy || !page}
          onChange={(enabled) => {
            if (page) void save({ ...page.settings, enabled }, page.revision);
          }}
        />
      </PluginDetailHeading>
      <p className="muted">
        Automatic PR reviews and tagged requests, using your configured Codex
        runner.
      </p>
      {error && !modelEditing && !hookOpen && !stopping && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Retry loading saved settings"
            disabled={busy}
            onClick={() => void reload()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card"
        aria-label="Review Bot configuration"
        aria-busy={!page && !error}
      >
        <div className="plugin-card-heading">
          <h2>Configuration</h2>
          <IconButton
            icon="edit"
            label="Edit Review Bot configuration"
            disabled={!page || busy}
            onClick={() => {
              if (!page) return;
              setError("");
              setModelDraft(page.settings.model);
              setModelEditing({
                settings: page.settings,
                revision: page.revision,
              });
            }}
          />
        </div>
        <p className="muted">
          Repository access is managed in GitHub. Automatic reviews use the
          connected GitHub App; tagged requests check the requester’s verified
          GitHub permissions. Requested fixes use Codex.
        </p>
        <dl className="plugin-summary">
          <div>
            <dt>Provider</dt>
            <dd>
              {!page ? (
                <Skeleton width="min(8rem, 100%)" />
              ) : page.settings.model ? (
                (catalog?.providers?.find(
                  (p) => p.id === page.settings.model?.providerId,
                )?.name ?? "Saved provider")
              ) : (
                "Use Codex provider"
              )}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {page ? (
                (page.settings.model?.model ?? "Use Codex model")
              ) : (
                <Skeleton width="min(8rem, 100%)" />
              )}
            </dd>
          </div>
          {(
            [
              ["Automatic reviews", "autoReview"],
              ["Tagged requests", "acceptRequests"],
              ["Requested fixes", "allowFixes"],
            ] as const
          ).map(([label, key]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {page ? (
                  page.settings[key] ? (
                    "Enabled"
                  ) : (
                    "Disabled"
                  )
                ) : (
                  <Skeleton width="min(8rem, 100%)" />
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      {modelEditing && (
        <Modal
          title="Edit Review Bot configuration"
          busy={busy}
          onClose={() => {
            setModelEditing(undefined);
            setError("");
          }}
        >
          <form
            className="record-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await save(
                  { ...modelEditing.settings, model: modelDraft },
                  modelEditing.revision,
                )
              )
                setModelEditing(undefined);
            }}
          >
            <label className="plugin-check">
              <input
                type="checkbox"
                checked={!modelDraft}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.checked) setModelDraft(undefined);
                  else
                    setModelDraft({
                      providerId: catalog?.providers?.[0]?.id ?? "",
                      model: "",
                    });
                }}
              />
              <span>Use the Codex model</span>
            </label>
            {modelDraft && (
              <ModelPicker
                request={request}
                value={modelDraft}
                onChange={setModelDraft}
                disabled={busy}
              />
            )}
            <p className="muted">
              Choose a Responses-compatible model from a saved provider. Manage
              providers in Model settings.
            </p>
            {(
              [
                ["Automatically review open PRs and new commits", "autoReview"],
                ["Accept tagged requests", "acceptRequests"],
                [
                  "Allow explicitly requested fixes to the same PR",
                  "allowFixes",
                ],
              ] as const
            ).map(([label, key]) => (
              <label className="form-check" key={key}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={modelEditing.settings[key]}
                  onChange={(event) =>
                    setModelEditing({
                      ...modelEditing,
                      settings: {
                        ...modelEditing.settings,
                        [key]: event.target.checked,
                      },
                    })
                  }
                />
                {label}
              </label>
            ))}
            <p className="muted">
              These settings apply to this workspace’s connected GitHub
              repositories. Fixes require GitHub write access and Codex Direct
              execution.
            </p>
            {error && (
              <p className="notice" role="alert">
                {error}
                {error.includes("settings changed") && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void reload()}
                  >
                    Reload saved settings
                  </button>
                )}
              </p>
            )}
            <ModalActions>
              <button
                type="submit"
                disabled={busy || (!!modelDraft && !modelDraft.model)}
              >
                {busy ? "Saving…" : "Save configuration"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
      <section className="card">
        <div className="plugin-card-heading">
          <h2>GitHub webhook</h2>
          <IconButton
            icon="edit"
            label="Edit GitHub webhook"
            disabled={busy || !page}
            onClick={() => {
              setError("");
              setHookOpen(true);
              setGenerated(undefined);
            }}
          />
        </div>
        <p>
          Enable webhook delivery in your GitHub App settings. Subscribe to Pull
          request, Issue comment and Pull request review comment events.
        </p>
        {page ? (
          <>
            <dl className="data-details">
              <div>
                <dt>Webhook URL</dt>
                <dd>
                  <code>{page.webhookUrl}</code>
                </dd>
              </div>
              <div>
                <dt>Webhook secret</dt>
                <dd>
                  {page.webhookConfigured ? "Configured" : "Not configured"}
                </dd>
              </div>
            </dl>
            <p className="muted">
              {page.webhookConfigured
                ? "Webhook secret configured. Delivery must also be enabled in GitHub."
                : "Configure a secret, then paste it into the GitHub App webhook settings."}
            </p>
            {page.botHandle && (
              <p>
                Tag <code>@{page.botHandle}</code> with <code>review</code>,{" "}
                <code>fix this</code>, <code>status</code> or{" "}
                <code>cancel</code>.
              </p>
            )}
          </>
        ) : (
          <SkeletonRows label="GitHub webhook configuration" />
        )}
      </section>
      <section className="card">
        <h2>Recent activity</h2>
        {!page ? (
          <SkeletonRows label="Review Bot activity" />
        ) : !page.tasks.length ? (
          <p className="muted">Reviews and tagged requests will appear here.</p>
        ) : (
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <a
                        href={`https://github.com/${task.payload.repository}/pull/${task.number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {task.payload.repository} #{task.number}
                      </a>
                    </td>
                    <td>{task.automatic ? "Automatic review" : task.mode}</td>
                    <td>
                      {task.cancelRequested &&
                      !["completed", "failed", "cancelled", "unknown"].includes(
                        task.state,
                      )
                        ? "Stopping…"
                        : task.state.replaceAll("_", " ")}
                    </td>
                    <td>
                      {task.result?.question ??
                        task.result?.summary ??
                        task.error ??
                        "—"}
                    </td>
                    <td>
                      {![
                        "completed",
                        "failed",
                        "cancelled",
                        "unknown",
                      ].includes(task.state) && (
                        <IconButton
                          icon="stop"
                          label={`Stop PR #${task.number} task`}
                          disabled={busy || task.cancelRequested}
                          onClick={() => {
                            setError("");
                            setStopping(task);
                          }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {hookOpen && (
        <Modal
          title="Configure GitHub webhook"
          onClose={() => {
            setError("");
            setHookOpen(false);
            setGenerated(undefined);
            setHookSecret("");
          }}
          busy={busy}
          cancelLabel={generated ? "Done" : "Cancel"}
        >
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {generated ? (
            <>
              <p>
                Paste this secret and URL into the GitHub App webhook settings.
                The secret is shown only here.
              </p>
              <div className="field">
                <label htmlFor="generated-review-secret">Webhook secret</label>
                <input
                  id="generated-review-secret"
                  readOnly
                  value={generated.secret}
                />
              </div>
              <div className="field">
                <label htmlFor="generated-review-url">Webhook URL</label>
                <input
                  id="generated-review-url"
                  readOnly
                  value={generated.url}
                />
              </div>
              <ModalActions>
                <span className="muted">
                  Enable the subscribed events in GitHub.
                </span>
              </ModalActions>
            </>
          ) : (
            <form onSubmit={(e) => void configureHook(e)}>
              <p>
                This secret applies to this GitHub App across your workspaces.
                Updating it replaces the previous secret; update GitHub to
                resume deliveries.
              </p>
              <div className="field">
                <label htmlFor="review-hook-secret">
                  Existing GitHub webhook secret (optional)
                </label>
                <input
                  id="review-hook-secret"
                  type="password"
                  autoComplete="off"
                  minLength={32}
                  value={hookSecret}
                  onChange={(event) => setHookSecret(event.target.value)}
                />
                <p className="muted">Leave blank to generate a new secret.</p>
              </div>
              <ModalActions>
                <button type="submit">
                  {busy ? "Saving…" : "Save webhook secret"}
                </button>
              </ModalActions>
            </form>
          )}
        </Modal>
      )}
      {stopping && (
        <Modal
          title="Stop Review Bot task"
          onClose={() => {
            setError("");
            setStopping(undefined);
          }}
          busy={busy}
        >
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <p>
            Stop work on PR #{stopping.number}? GitHub operations already
            underway may finish.
          </p>
          <ModalActions>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request<ReviewPage>(
                  `${endpoint}/${stopping.id}/cancel`,
                  "POST",
                  {},
                )
                  .then((data) => {
                    setPage(data);
                    setStopping(undefined);
                  })
                  .catch((e) => setError(explain(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Stop task
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
