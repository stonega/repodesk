import { useCallback, useEffect, useState } from "react";
import type { CodingPage, CodingSettings } from "../src/coding/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Repository = CodingSettings["repositories"][number];
function message(error: unknown) {
  const code = (error as Error).message;
  const messages: Record<string, string> = {
    version_conflict:
      "Settings changed in another session. Reload and review your edits.",
    coding_maintainer_inactive:
      "Select maintainers who currently have workspace access.",
    github_repository_not_connected:
      "Connect the selected repository in GitHub before saving.",
    invalid_request:
      "Check the branch, repository commands and maintainer selections.",
  };
  return messages[code] ?? code;
}
export function Coding({
  request,
  workspaceId,
}: {
  request: Request;
  workspaceId: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
  const [data, setData] = useState<CodingPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Repository>();
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<CodingPage>(endpoint));
      setEditing(undefined);
      setKeyEditing(false);
      setKeyDraft("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [request, endpoint]);
  useEffect(() => {
    setKeyEditing(false);
    setKeyDraft("");
    void load();
  }, [load]);
  const save = async (
    settings: CodingSettings,
    optimistic = false,
    providerApiKey?: string | null,
  ) => {
    if (!data || busy) return;
    const previous = data;
    if (optimistic) setData({ ...data, settings });
    setBusy(true);
    setError("");
    try {
      setData(
        await request<CodingPage>(endpoint, "PUT", {
          revision: data.revision,
          settings,
          ...(providerApiKey !== undefined ? { providerApiKey } : {}),
        }),
      );
      setEditing(undefined);
      setKeyEditing(false);
      setKeyDraft("");
    } catch (e) {
      if (optimistic) setData(previous);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Codex implementation">
      <div className="row plugin-toolbar">
        <h2>Codex implementation</h2>
        <IconButton
          icon="add"
          label="Add coding repository"
          disabled={!data?.repositories.length || busy || loading}
          onClick={() => {
            setError("");
            setEditing({
              repositoryId: 0,
              baseBranch: "develop",
              workflowFile: "repodesk-codex.yml",
              maintainers: [],
            });
          }}
        />
      </div>
      <p>
        Create an issue, implement a feature or fix with Codex, and open a draft
        PR. Only each repository’s selected maintainers can start tasks.
      </p>
      <p className="muted">
        Coding provider usage is billed separately from chat usage. Local Podman
        uses the deployment’s custom provider configuration and the API key
        saved for this workspace.
      </p>
      {error && !editing && !keyEditing && (
        <p role="alert">
          {error}
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Reload coding settings
          </button>
        </p>
      )}
      {data && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={data.settings.enabled}
              disabled={busy || loading}
              onChange={(e) =>
                void save({ ...data.settings, enabled: e.target.checked }, true)
              }
            />
            Enable Codex implementation
          </label>
          <label>
            Execution backend
            <select
              value={data.settings.backend ?? "github-actions"}
              disabled={busy || loading}
              onChange={(e) =>
                void save(
                  {
                    ...data.settings,
                    backend: e.target.value as "github-actions" | "podman",
                  },
                  true,
                )
              }
            >
              <option value="github-actions">GitHub Actions</option>
              <option value="podman">Local Podman</option>
            </select>
          </label>
          <p className="muted">
            {data.settings.backend === "podman"
              ? "Each approved task runs in its own container. Configure the local runner and provider endpoint in deployment settings, save your provider API key below, and set each repository’s setup and check commands."
              : "Install examples/coding/repodesk-codex.yml in each repository and configure its OpenAI secret and GitHub App bot login. GitHub Actions usage is billed separately."}
          </p>
          <p className="muted">
            Saving settings invalidates pending approvals and requests
            cancellation of active tasks using older settings.
          </p>
          {data.settings.backend === "podman" && (
            <div className="card">
              <h3>Provider API key</h3>
              <p>
                {data.providerApiKeyConfigured
                  ? "Configured for this workspace."
                  : "No workspace key saved. A deployment key is used if configured."}
              </p>
              <p className="muted">
                The key is stored encrypted and is never displayed again. Saving
                or removing a key invalidates pending approvals and requests
                cancellation of active tasks.
              </p>
              <div className="row">
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => {
                    setError("");
                    setKeyDraft("");
                    setKeyEditing(true);
                  }}
                >
                  {data.providerApiKeyConfigured
                    ? "Replace API key"
                    : "Set API key"}
                </button>
                {data.providerApiKeyConfigured && (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => {
                      if (
                        confirm(
                          "Remove the saved Codex API key? Active tasks will receive cancellation requests. A deployment key will be used if configured.",
                        )
                      )
                        void save(data.settings, false, null);
                    }}
                  >
                    Remove saved key
                  </button>
                )}
              </div>
            </div>
          )}
          {!data.repositories.length && (
            <p>Connect a GitHub repository above to configure coding tasks.</p>
          )}
          {!data.settings.repositories.length && (
            <p>No coding repositories configured.</p>
          )}
          {data.settings.repositories.map((repo) => (
            <div className="row" key={repo.repositoryId}>
              <div>
                <strong>
                  {data.repositories.find((r) => r.id === repo.repositoryId)
                    ?.full_name ??
                    `Repository ${repo.repositoryId} (disconnected)`}
                </strong>
                <p>
                  Base: <code>{repo.baseBranch}</code> · Maintainers:{" "}
                  {repo.maintainers.join(", ")}
                </p>
              </div>
              <IconButton
                icon="edit"
                label={`Edit coding repository ${repo.repositoryId}`}
                disabled={busy || loading}
                onClick={() => {
                  setError("");
                  setEditing(structuredClone(repo));
                }}
              />
              <IconButton
                icon="delete"
                label={`Remove coding repository ${repo.repositoryId}`}
                disabled={busy || loading}
                onClick={() => {
                  if (
                    confirm(
                      "Remove this coding repository? Active tasks will receive cancellation requests.",
                    )
                  )
                    void save({
                      ...data.settings,
                      repositories: data.settings.repositories.filter(
                        (r) => r.repositoryId !== repo.repositoryId,
                      ),
                    });
                }}
              />
            </div>
          ))}
          <h3>Coding tasks</h3>
          {data.tasks.some(
            (task) =>
              !["succeeded", "failed", "unknown", "cancelled"].includes(
                task.state,
              ),
          ) && (
            <button
              type="button"
              disabled={busy || loading || !!editing}
              onClick={() => void load()}
            >
              Check progress
            </button>
          )}
          <p className="muted">
            Stop requests remote cancellation; an issue, branch or PR already
            published remains on GitHub.
          </p>
          {!data.tasks.length ? (
            <p>
              No tasks yet. Ask the bot in Telegram to implement a feature or
              fix a bug in a configured repository.
            </p>
          ) : (
            <div className="usage-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Repository / base</th>
                    <th>Status</th>
                    <th>Links</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        {task.payload.title}
                        <br />
                        <small>
                          {new Date(task.createdAt).toLocaleString()} ·{" "}
                          {task.actor}
                        </small>
                        <br />
                        <code>{task.id}</code>
                      </td>
                      <td>
                        {task.payload.repository}
                        <br />
                        <code>{task.payload.baseBranch}</code>
                      </td>
                      <td>
                        {task.state.replaceAll("_", " ")}
                        {task.cancelRequested && " · stop requested"}
                        {task.error && <p>{task.error}</p>}
                      </td>
                      <td>
                        {task.issue && (
                          <p>
                            <a
                              href={task.issue.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Issue
                            </a>
                          </p>
                        )}
                        {task.workflowUrl && (
                          <p>
                            <a
                              href={task.workflowUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Workflow
                            </a>
                          </p>
                        )}
                        {task.prUrl && (
                          <p>
                            <a
                              href={task.prUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              PR
                            </a>
                          </p>
                        )}
                      </td>
                      <td>
                        {![
                          "succeeded",
                          "failed",
                          "unknown",
                          "cancelled",
                        ].includes(task.state) && (
                          <IconButton
                            icon="stop"
                            label={`Stop coding task ${task.payload.title}`}
                            disabled={busy || task.cancelRequested}
                            onClick={async () => {
                              setBusy(true);
                              setError("");
                              try {
                                await request(
                                  `${endpoint}/${task.id}/cancel`,
                                  "POST",
                                  {},
                                );
                                await load();
                              } catch (e) {
                                setError(message(e));
                              } finally {
                                setBusy(false);
                              }
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
        </>
      )}
      {keyEditing && data && (
        <Modal
          title={
            data.providerApiKeyConfigured
              ? "Replace Codex API key"
              : "Set Codex API key"
          }
          busy={busy}
          onClose={() => {
            setKeyEditing(false);
            setKeyDraft("");
            setError("");
          }}
        >
          {error && (
            <p role="alert">
              {error}{" "}
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                Reload coding settings
              </button>
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (keyDraft.trim())
                void save(data.settings, false, keyDraft.trim());
            }}
          >
            <label>
              Provider API key
              <input
                type="password"
                autoComplete="new-password"
                required
                maxLength={8192}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
            </label>
            <p className="muted">
              Use a key for the custom provider configured on this deployment.
              It applies only to this workspace’s local Codex tasks.
            </p>
            <ModalActions>
              <button type="submit" disabled={busy || !keyDraft.trim()}>
                Save API key
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
      {editing && data && (
        <Modal
          title={
            editing.repositoryId
              ? "Edit coding repository"
              : "Add coding repository"
          }
          busy={busy}
          onClose={() => {
            setEditing(undefined);
            setError("");
          }}
        >
          {error && (
            <p role="alert">
              {error}
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                Reload coding settings
              </button>
            </p>
          )}
          <RepositoryEditor
            key={editing.repositoryId}
            initial={editing}
            data={data}
            submit={(repo) =>
              void save({
                ...data.settings,
                repositories: [
                  ...data.settings.repositories.filter(
                    (r) => r.repositoryId !== editing.repositoryId,
                  ),
                  repo,
                ],
              })
            }
          />
        </Modal>
      )}
    </section>
  );
}
function RepositoryEditor({
  initial,
  data,
  submit,
}: {
  initial: Repository;
  data: CodingPage;
  submit: (r: Repository) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [validation, setValidation] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.maintainers.length) {
          setValidation("Select at least one maintainer.");
          return;
        }
        submit(draft);
      }}
    >
      <label>
        Repository
        <select
          required
          value={draft.repositoryId || ""}
          onChange={(e) =>
            setDraft({ ...draft, repositoryId: Number(e.target.value) })
          }
        >
          <option value="">Select a connected repository</option>
          {data.repositories
            .filter(
              (r) =>
                r.id === initial.repositoryId ||
                !data.settings.repositories.some(
                  (s) => s.repositoryId === r.id,
                ),
            )
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.full_name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Development / base branch
        <input
          required
          maxLength={150}
          value={draft.baseBranch}
          onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })}
        />
      </label>
      <p className="muted">
        An existing branch, for example develop. Task branches and PRs use this
        base.
      </p>
      {
        <>
          <label>
            Local setup command (optional)
            <textarea
              maxLength={2000}
              value={draft.setupCommand ?? ""}
              placeholder="bun install --frozen-lockfile"
              onChange={(e) =>
                setDraft({ ...draft, setupCommand: e.target.value })
              }
            />
          </label>
          <label>
            Local check command
            <textarea
              required={data.settings.backend === "podman"}
              maxLength={2000}
              value={draft.checkCommand ?? ""}
              placeholder="bun run check && bun run typecheck && bun test && bun run build"
              onChange={(e) =>
                setDraft({ ...draft, checkCommand: e.target.value })
              }
            />
          </label>
          <p className="muted">
            Commands run in the isolated checkout. Checks must pass before
            publication. The standard runner includes Node, Bun, Git and Bash.
          </p>
        </>
      }
      {data.settings.backend !== "podman" && (
        <>
          <label>
            Workflow filename
            <input
              required
              maxLength={100}
              value={draft.workflowFile}
              onChange={(e) =>
                setDraft({ ...draft, workflowFile: e.target.value })
              }
            />
          </label>
          <p className="muted">
            A .yml or .yaml filename under .github/workflows, installed on the
            default and base branches.
          </p>
        </>
      )}
      <fieldset>
        <legend>Maintainers (Telegram user IDs)</legend>
        {[
          ...data.members,
          ...draft.maintainers
            .filter((id) => !data.members.some((m) => m.id === id))
            .map((id) => ({ id, active: false })),
        ].map((m) => (
          <label key={m.id} className="row">
            <input
              type="checkbox"
              checked={draft.maintainers.includes(m.id)}
              onChange={(e) => {
                setValidation("");
                setDraft({
                  ...draft,
                  maintainers: e.target.checked
                    ? [...draft.maintainers, m.id]
                    : draft.maintainers.filter((id) => id !== m.id),
                });
              }}
            />
            {m.id}
            {!m.active && " (access removed)"}
          </label>
        ))}
      </fieldset>
      {validation && <p role="alert">{validation}</p>}
      <ModalActions>
        <button type="submit">Save coding repository</button>
      </ModalActions>
    </form>
  );
}
