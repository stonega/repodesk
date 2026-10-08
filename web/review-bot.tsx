import { type FormEvent, useEffect, useState } from "react";
import type {
  ReviewPage,
  ReviewSettings,
  ReviewTask,
} from "../src/review-bot/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { RepositorySelect } from "./repository-select.tsx";
import { Select } from "./select.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const explain = (error: unknown) =>
  ({
    review_repository_required:
      "Enable Codex and select at least one configured repository.",
    review_reviewer_required:
      "Choose an active Codex maintainer for automatic reviews.",
    review_webhook_required: "Configure the GitHub webhook first.",
    review_repository_already_configured:
      "This repository already has Review Bot enabled in another workspace.",
    coding_direct_execution_disabled:
      "Enable Direct execution for this repository in Codex before accepting fixes.",
    version_conflict:
      "These settings changed. Reload the saved settings and try again.",
  })[String((error as Error).message)] ?? (error as Error).message;

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
  const [page, setPage] = useState<ReviewPage>();
  const [draft, setDraft] = useState<ReviewSettings>();
  const [draftRevision, setDraftRevision] = useState(0);
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
    setDraft(undefined);
    setError("");
    setGenerated(undefined);
    setHookSecret("");
    setHookOpen(false);
    request<ReviewPage>(endpoint)
      .then((data) => {
        if (active) {
          setPage(data);
          setDraft(data.settings);
          setDraftRevision(data.revision);
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
  const save = async (settings: ReviewSettings) => {
    if (!page || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await request<ReviewPage>(endpoint, "PUT", {
        revision: draftRevision,
        settings,
      });
      setPage(data);
      setDraft(data.settings);
      setDraftRevision(data.revision);
      notify("Review Bot settings saved.");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (
    index: number,
    value: Partial<ReviewSettings["repositories"][number]>,
  ) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            repositories: d.repositories.map((r, i) =>
              i === index ? { ...r, ...value } : r,
            ),
          }
        : d,
    );
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
          disabled={busy || !draft}
          onChange={(enabled) => {
            if (draft) void save({ ...draft, enabled });
          }}
        />
      </PluginDetailHeading>
      <p className="muted">
        Automatic PR reviews and tagged requests, using your configured Codex
        runner.
      </p>
      {error && !hookOpen && !stopping && (
        <ErrorToast message={error}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void request<ReviewPage>(endpoint)
                .then((data) => {
                  setPage(data);
                  setDraft(data.settings);
                  setDraftRevision(data.revision);
                  setError("");
                })
                .catch((e) => setError(explain(e)));
            }}
          >
            Reload saved settings
          </button>
        </ErrorToast>
      )}
      <section className="card">
        <h2>GitHub webhook</h2>
        <p>
          Enable webhook delivery in your GitHub App settings. Subscribe to Pull
          request, Issue comment and Pull request review comment events.
        </p>
        {page ? (
          <>
            <div className="field">
              <label htmlFor="review-webhook-url">Webhook URL</label>
              <input id="review-webhook-url" readOnly value={page.webhookUrl} />
            </div>
            <p className="muted">
              {page.webhookConfigured
                ? "Webhook secret configured. Delivery must also be enabled in GitHub."
                : "Configure a secret, then paste it into the GitHub App webhook settings."}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError("");
                setHookOpen(true);
                setGenerated(undefined);
              }}
            >
              {page.webhookConfigured
                ? "Update webhook secret"
                : "Configure webhook"}
            </button>
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
        <h2>Repositories</h2>
        <p className="muted">
          Select repositories configured in Codex. Automatic reviews use the
          selected maintainer’s repository grant. Tagged requests require a
          verified GitHub account. Fixes also require Codex Direct execution.
        </p>
        {!draft || !page ? (
          <SkeletonRows label="Review repositories" />
        ) : (
          <form
            className="record-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft);
            }}
          >
            <fieldset disabled={busy}>
              {draft.repositories.map((target, index) => {
                const repository = page.repositories.find(
                  (r) => r.id === target.repositoryId,
                );
                return (
                  <section className="card" key={target.repositoryId}>
                    <RepositorySelect
                      repositories={page.repositories.filter(
                        (r) =>
                          r.id === target.repositoryId ||
                          !draft.repositories.some(
                            (t) => t.repositoryId === r.id,
                          ),
                      )}
                      value={target.repositoryId}
                      onChange={(id) =>
                        update(index, {
                          repositoryId: id,
                          reviewer:
                            page.repositories.find((r) => r.id === id)
                              ?.maintainers[0]?.id ?? "",
                        })
                      }
                    />
                    <div className="field">
                      <label htmlFor={`review-owner-${index}`}>
                        Automatic review owner
                      </label>
                      <Select
                        id={`review-owner-${index}`}
                        value={target.reviewer}
                        onChange={(event) =>
                          update(index, { reviewer: event.target.value })
                        }
                        required
                      >
                        <option value="">Select a maintainer</option>
                        {repository?.maintainers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={target.autoReview}
                        onChange={(event) =>
                          update(index, { autoReview: event.target.checked })
                        }
                      />
                      Automatically review open PRs and new commits
                    </label>
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={target.acceptRequests}
                        onChange={(event) =>
                          update(index, {
                            acceptRequests: event.target.checked,
                          })
                        }
                      />
                      Accept tagged requests
                    </label>
                    <label className="form-check">
                      <input
                        type="checkbox"
                        checked={target.allowFixes}
                        onChange={(event) =>
                          update(index, { allowFixes: event.target.checked })
                        }
                      />
                      Allow explicitly requested fixes to the same PR
                    </label>
                    <IconButton
                      icon="delete"
                      label={`Remove ${repository?.full_name ?? "repository"}`}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          repositories: draft.repositories.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    />
                  </section>
                );
              })}
              {!page.repositories.length && (
                <p>
                  Enable Codex and configure a repository and maintainer to get
                  started.
                </p>
              )}
              <div className="modal-actions">
                <IconButton
                  icon="add"
                  label="Add repository"
                  showLabel
                  type="button"
                  disabled={
                    draft.repositories.length >= 12 ||
                    !page.repositories.some(
                      (r) =>
                        !draft.repositories.some(
                          (t) => t.repositoryId === r.id,
                        ),
                    )
                  }
                  onClick={() => {
                    const repo = page.repositories.find(
                      (r) =>
                        !draft.repositories.some(
                          (t) => t.repositoryId === r.id,
                        ),
                    );
                    if (repo)
                      setDraft({
                        ...draft,
                        repositories: [
                          ...draft.repositories,
                          {
                            repositoryId: repo.id,
                            reviewer: repo.maintainers[0]?.id ?? "",
                            autoReview: true,
                            acceptRequests: true,
                            allowFixes: false,
                          },
                        ],
                      });
                  }}
                />
                <button type="submit">
                  {busy ? "Saving…" : "Save settings"}
                </button>
              </div>
            </fieldset>
          </form>
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
