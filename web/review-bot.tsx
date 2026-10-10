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
import { RepositoryCard } from "./repository-card.tsx";
import { RepositorySelect } from "./repository-select.tsx";
import { Select } from "./select.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type ReviewRepository = ReviewSettings["repositories"][number];
type RepositoryDraft = {
  originalId?: number;
  target: ReviewRepository;
  settings: ReviewSettings;
  revision: number;
};
const explain = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith("version_conflict.")
    ? "version_conflict"
    : message;
  return (
    {
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
  const [editing, setEditing] = useState<RepositoryDraft>();
  const [removing, setRemoving] = useState<RepositoryDraft>();
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
    setEditing(undefined);
    setRemoving(undefined);
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
  const update = (value: Partial<ReviewRepository>) =>
    setEditing((draft) =>
      draft ? { ...draft, target: { ...draft.target, ...value } } : draft,
    );
  const openEditor = (target: ReviewRepository, originalId?: number) => {
    if (!page || busy) return;
    setError("");
    setEditing({
      originalId,
      target: { ...target },
      settings: page.settings,
      revision: page.revision,
    });
  };
  const reload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setPage(await request<ReviewPage>(endpoint));
      setEditing(undefined);
      setRemoving(undefined);
      setError("");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const availableRepository = page?.repositories.find(
    (repository) =>
      !page.settings.repositories.some(
        (target) => target.repositoryId === repository.id,
      ),
  );
  const selectedRepository = page?.repositories.find(
    (repository) => repository.id === editing?.target.repositoryId,
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
      {error &&
        !modelEditing &&
        !hookOpen &&
        !stopping &&
        !editing &&
        !removing && (
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
      <section className="card" aria-label="Review model">
        <div className="plugin-card-heading">
          <h2>Review model</h2>
          <IconButton
            icon="edit"
            label="Edit review model"
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
          Reviews and answers use this model. Requested fixes use the Codex
          model.
        </p>
        <dl className="plugin-summary">
          <div>
            <dt>Provider</dt>
            <dd>
              {!page ? (
                <SkeletonRows label="Review provider" />
              ) : page.settings.model ? (
                (catalog?.providers.find(
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
                <SkeletonRows label="Review model" />
              )}
            </dd>
          </div>
        </dl>
      </section>
      {modelEditing && (
        <Modal
          title="Edit review model"
          busy={busy}
          onClose={() => setModelEditing(undefined)}
        >
          <form
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
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <ModalActions>
              <button
                type="submit"
                disabled={busy || (!!modelDraft && !modelDraft.model)}
              >
                {busy ? "Saving…" : "Save review model"}
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
      <section className="card" aria-labelledby="review-repositories-heading">
        <div className="plugin-card-heading">
          <h2 id="review-repositories-heading">Repositories</h2>
          <IconButton
            icon="add"
            label="Add repository"
            showLabel
            disabled={
              busy ||
              !availableRepository ||
              !page ||
              page.settings.repositories.length >= 12
            }
            onClick={() => {
              if (availableRepository)
                openEditor({
                  repositoryId: availableRepository.id,
                  reviewer: availableRepository.maintainers[0]?.id ?? "",
                  autoReview: true,
                  acceptRequests: true,
                  allowFixes: false,
                });
            }}
          />
        </div>
        <p className="muted">
          Automatic reviews use the selected maintainer’s repository grant.
          Tagged requests require a verified GitHub account. Fixes also require
          Codex Direct execution.
        </p>
        {!page ? (
          <SkeletonRows label="Review repositories" />
        ) : !page.settings.repositories.length ? (
          <p className="muted">
            {page.repositories.length
              ? "No repositories configured. Choose New to add one."
              : "Enable Codex and configure a repository and maintainer to get started."}
          </p>
        ) : (
          <div className="repository-list repository-list-stacked">
            {page.settings.repositories.map((target) => {
              const repository = page.repositories.find(
                (repository) => repository.id === target.repositoryId,
              );
              const name =
                repository?.full_name ?? `Repository ${target.repositoryId}`;
              const reviewer = repository?.maintainers.find(
                (maintainer) => maintainer.id === target.reviewer,
              );
              return (
                <RepositoryCard
                  name={name}
                  url={
                    repository
                      ? `https://github.com/${repository.full_name}`
                      : undefined
                  }
                  key={target.repositoryId}
                  actions={
                    <>
                      <IconButton
                        icon="edit"
                        label={`Edit ${name}`}
                        disabled={busy}
                        onClick={() => openEditor(target, target.repositoryId)}
                      />
                      <IconButton
                        icon="delete"
                        label={`Remove ${name}`}
                        disabled={busy}
                        onClick={() => {
                          setError("");
                          setRemoving({
                            target,
                            settings: page.settings,
                            revision: page.revision,
                          });
                        }}
                      />
                    </>
                  }
                >
                  <dl className="plugin-summary">
                    <div>
                      <dt>Automatic review owner</dt>
                      <dd>
                        {reviewer?.name ??
                          `Unavailable maintainer (${target.reviewer})`}
                      </dd>
                    </div>
                    <div>
                      <dt>Automatic reviews</dt>
                      <dd>{target.autoReview ? "Enabled" : "Disabled"}</dd>
                    </div>
                    <div>
                      <dt>Tagged requests</dt>
                      <dd>{target.acceptRequests ? "Enabled" : "Disabled"}</dd>
                    </div>
                    <div>
                      <dt>Requested fixes</dt>
                      <dd>{target.allowFixes ? "Allowed" : "Disabled"}</dd>
                    </div>
                  </dl>
                </RepositoryCard>
              );
            })}
          </div>
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
      {editing && page && (
        <Modal
          title={
            editing.originalId === undefined
              ? "Add Review Bot repository"
              : "Edit Review Bot repository"
          }
          busy={busy}
          onClose={() => {
            setEditing(undefined);
            setError("");
          }}
        >
          <form
            className="record-form coding-repository-form"
            onSubmit={(event) => {
              event.preventDefault();
              const repositories =
                editing.originalId === undefined
                  ? [...editing.settings.repositories, editing.target]
                  : editing.settings.repositories.map((target) =>
                      target.repositoryId === editing.originalId
                        ? editing.target
                        : target,
                    );
              void save(
                { ...editing.settings, repositories },
                editing.revision,
              ).then((saved) => {
                if (saved) setEditing(undefined);
              });
            }}
          >
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {error && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload saved settings
              </button>
            )}
            <RepositorySelect
              repositories={page.repositories.filter(
                (repository) =>
                  repository.id === editing.originalId ||
                  !editing.settings.repositories.some(
                    (target) => target.repositoryId === repository.id,
                  ),
              )}
              value={editing.target.repositoryId}
              onChange={(id) =>
                update({
                  repositoryId: id,
                  reviewer:
                    page.repositories.find((repository) => repository.id === id)
                      ?.maintainers[0]?.id ?? "",
                })
              }
            />
            <div className="field">
              <label htmlFor="review-owner">Automatic review owner</label>
              <Select
                id="review-owner"
                value={editing.target.reviewer}
                onChange={(event) => update({ reviewer: event.target.value })}
                required
              >
                <option value="">Select a maintainer</option>
                {selectedRepository?.maintainers.map((maintainer) => (
                  <option key={maintainer.id} value={maintainer.id}>
                    {maintainer.name}
                  </option>
                ))}
              </Select>
              <small>
                Automatic reviews use this maintainer’s repository grant.
              </small>
            </div>
            <label className="form-check">
              <input
                type="checkbox"
                checked={editing.target.autoReview}
                onChange={(event) =>
                  update({ autoReview: event.target.checked })
                }
              />
              Automatically review open PRs and new commits
            </label>
            <label className="form-check">
              <input
                type="checkbox"
                checked={editing.target.acceptRequests}
                onChange={(event) =>
                  update({ acceptRequests: event.target.checked })
                }
              />
              Accept tagged requests
            </label>
            <label className="form-check">
              <input
                type="checkbox"
                checked={editing.target.allowFixes}
                onChange={(event) =>
                  update({ allowFixes: event.target.checked })
                }
              />
              Allow explicitly requested fixes to the same PR
            </label>
            <p className="muted">
              Tagged requests require a verified GitHub account. Fixes also
              require Codex Direct execution.
            </p>
            <ModalActions>
              <button type="submit">
                {busy ? "Saving…" : "Save repository"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Remove Review Bot repository"
          busy={busy}
          onClose={() => {
            setRemoving(undefined);
            setError("");
          }}
        >
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {error && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload saved settings
            </button>
          )}
          <p>
            Remove{" "}
            {page?.repositories.find(
              (repository) => repository.id === removing.target.repositoryId,
            )?.full_name ?? `repository ${removing.target.repositoryId}`}{" "}
            from Review Bot? Automatic reviews and tagged requests will no
            longer be accepted for this repository.
          </p>
          <ModalActions>
            <button
              type="button"
              className="danger"
              onClick={() => {
                void save(
                  {
                    ...removing.settings,
                    repositories: removing.settings.repositories.filter(
                      (target) =>
                        target.repositoryId !== removing.target.repositoryId,
                    ),
                  },
                  removing.revision,
                ).then((saved) => {
                  if (saved) setRemoving(undefined);
                });
              }}
            >
              {busy ? "Removing…" : "Remove repository"}
            </button>
          </ModalActions>
        </Modal>
      )}
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
