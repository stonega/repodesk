import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router";
import type { CodingPage, CodingSettings } from "../src/coding/config.ts";
import { codingFailureMessage } from "../src/coding/failure-messages.ts";
import { codingStatusLabel } from "../src/coding/feedback.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { RepositorySelect } from "./repository-select.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
type Repository = CodingSettings["repositories"][number];
function message(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError")
    return "The connection request timed out. Recheck connection before trying sign-in again.";
  const code = (error as Error).message;
  if (code.startsWith("version_conflict"))
    return "Settings changed in another session. Reload and review your edits.";
  const messages: Record<string, string> = {
    coding_maintainer_inactive:
      "Select maintainers who currently have workspace access.",
    github_repository_not_connected:
      "Connect the selected repository in GitHub before saving.",
    coding_device_auth_required:
      "Connect a ChatGPT account with device code before starting coding tasks.",
    coding_device_login_unavailable:
      "Device sign-in could not start. Retry, or check the runner's connection to OpenAI.",
    coding_device_login_network_failed:
      "Codex could not establish a secure connection to OpenAI. Check the runner's network and certificates, then retry.",
    coding_device_login_rejected:
      "OpenAI refused the server's device sign-in request. Check the deployment's access to OpenAI, then retry.",
    coding_device_login_disabled:
      "Device-code sign-in is unavailable. Enable device login in your ChatGPT security settings or ask your workspace administrator.",
    coding_device_login_busy:
      "Too many device sign-ins are pending. Finish or cancel another sign-in first.",
    coding_runner_not_configured:
      "The Codex runner is not configured for this deployment. Configure it, then recheck connection.",
    coding_runner_unavailable:
      "The Codex runner could not be reached. Recheck connection after it is available.",
    coding_outcome_unknown:
      "The sign-in response could not be confirmed. Recheck connection before trying again.",
    invalid_request: "Check the branch and maintainer selections.",
  };
  return messages[code] ?? code;
}
const taskFailures: Record<string, string> = {
  coding_device_auth_required:
    "Sign in to your Codex account in Configuration. This task will continue automatically.",
  coding_checkpoint_expired:
    "The saved checkout expired. Start a new task to continue.",
  coding_verification_invalid:
    "Codex did not provide runnable verification checks.",
  coding_budget_exhausted:
    "Task limits reached. Review its result before starting another task.",
  coding_token_limit: "Codex reached the task's token limit.",
  coding_publication_unknown:
    "Publication could not be confirmed. Inspect GitHub before starting more work.",
  coding_pr_closed:
    "The task's PR is closed or merged. It will not be recreated automatically.",
  coding_source_expired:
    "A retained source expired or was removed; the task was stopped.",
  coding_configuration_changed:
    "Repository configuration changed; the task was stopped.",

  coding_legacy_backend_disabled:
    "GitHub Actions execution was removed. Inspect any existing workflow on GitHub.",
  coding_setup_failed: "Repository environment preparation failed.",
  coding_codex_failed: "Codex stopped before completing the implementation.",
  coding_check_failed: "The repository verification checks failed.",
  coding_patch_empty: "Codex produced no changes to publish.",
  coding_execution_failed: "Implementation or repository verification failed.",
};
function RunnerSetupNotice() {
  return (
    <p className="muted">
      VPS releases automatically start and maintain the Codex runner. Enable
      this plugin, then connect your account. If the runner is unavailable,
      check the deployment status and recheck the connection.{" "}
      <a
        href="https://github.com/stonega/repodesk/blob/main/docs/implementation/codex-podman.md#configure-the-deployment"
        target="_blank"
        rel="noopener noreferrer"
      >
        Codex runner setup instructions
      </a>
      .
    </p>
  );
}
export function Coding({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo?: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding`;
  const [data, setData] = useState<CodingPage>();
  const [actionError, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const error = actionError || refreshError;
  const [busy, setBusy] = useState(false);
  const [deviceAction, setDeviceAction] = useState<"start" | "status">();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Repository>();
  const [configEditing, setConfigEditing] = useState(false);
  const [configDraft, setConfigDraft] = useState<CodingSettings>();
  const [keyDraft, setKeyDraft] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [stopping, setStopping] = useState<{
    id: string;
    title: string;
    repository: string;
  }>();
  const [stopError, setStopError] = useState("");
  const preserveSettings = !!editing || configEditing;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await request<CodingPage>(
          endpoint,
          "GET",
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        );
        if (!signal.aborted) {
          setData((previous) =>
            previous && preserveSettings
              ? {
                  ...page,
                  settings: previous.settings,
                  revision: previous.revision,
                }
              : page,
          );
          setRefreshError("");
        }
      } catch (e) {
        if (!signal.aborted) setRefreshError(message(e));
      }
    },
    [endpoint, preserveSettings, request],
  );
  useRepositoryRefresh(
    refresh,
    !busy && !loading,
    data?.deviceAuth?.state === "pending" ? 3000 : 5000,
  );
  const recheckConnection = async () => {
    setBusy(true);
    setDeviceAction("status");
    setError("");
    try {
      setData(
        await request<CodingPage>(
          endpoint,
          "GET",
          undefined,
          AbortSignal.timeout(10000),
        ),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      setDeviceAction(undefined);
    }
  };
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setRefreshError("");
    try {
      setData(await request<CodingPage>(endpoint));
      setEditing(undefined);
      setConfigEditing(false);
      setConfigDraft(undefined);
      setKeyDraft("");
      setRemoveKey(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [request, endpoint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Discard data and drafts when the workspace endpoint changes.
  useEffect(() => {
    setData(undefined);
    setError("");
    setRefreshError("");
    setEditing(undefined);
    setConfigEditing(false);
    setConfigDraft(undefined);
    setKeyDraft("");
    setRemoveKey(false);
    setStopping(undefined);
    setStopError("");
  }, [endpoint]);
  const save = async (
    settings: CodingSettings,
    providerApiKey?: string | null,
  ) => {
    if (!data || busy) return;
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
      setConfigEditing(false);
      setConfigDraft(undefined);
      setKeyDraft("");
      setRemoveKey(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const tasks = data
    ? [
        ...(data.developmentTasks ?? []).map((t) => ({
          ...t,
          runId: "",
          prUrl: t.pr?.url,
          issue: undefined,
          workflowUrl: undefined,
          continuous: true,
          questionText: t.question?.text,
        })),
        ...data.tasks.map((t) => ({
          ...t,
          continuous: false,
          questionText: undefined,
        })),
      ]
    : [];
  const stopTask = tasks.find((task) => task.id === stopping?.id);
  const canStop =
    !!stopTask &&
    !stopTask.cancelRequested &&
    !["succeeded", "failed", "unknown", "cancelled"].includes(stopTask.state);
  const stop = async () => {
    if (!stopping || !canStop || busy || loading) return;
    setBusy(true);
    setStopError("");
    try {
      await request(`${endpoint}/${stopping.id}/cancel`, "POST", {});
      setStopping(undefined);
      await load();
    } catch (e) {
      setStopError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const activeTasks = tasks.filter(
    (task) =>
      !["succeeded", "failed", "unknown", "cancelled"].includes(task.state),
  ).length;
  const pendingValue = error ? "—" : <Skeleton width="9rem" />;
  const credentialStatus =
    data?.settings.authMode === "device_code"
      ? data.deviceAuth?.state === "connected"
        ? "ChatGPT connected"
        : data.deviceAuth?.state === "pending"
          ? "Sign-in pending"
          : data.deviceAuth?.state === "auth_required"
            ? "ChatGPT sign-in required"
            : "ChatGPT not connected"
      : data?.providerApiKeyConfigured
        ? "Workspace key configured"
        : "No workspace key";
  return (
    <section
      className="coding-detail"
      id="coding-tasks"
      aria-label="Codex implementation"
    >
      {backTo && (
        <PluginDetailHeading title="Codex" backTo={backTo}>
          <PluginToggle
            name="Codex implementation"
            enabled={data?.settings.enabled}
            loading={!data && !error}
            disabled={!data || busy || loading}
            onChange={(enabled) => {
              if (data) void save({ ...data.settings, enabled });
            }}
          />
        </PluginDetailHeading>
      )}
      {error && !editing && !configEditing && (
        <p className="notice" role="alert">
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
      {data?.repositoryRefreshError && (
        <p className="notice" role="status">
          Repository updates are temporarily unavailable. Showing the last saved
          list. Check the GitHub App connection if this continues.
        </p>
      )}
      <section
        className="card"
        aria-label="Codex configuration"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Configuration</h2>
            <p className="muted">
              Repository policy controls coding work in isolated local
              containers.
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Codex configuration"
            showLabel
            disabled={!data || busy || loading}
            onClick={() => {
              if (!data) return;
              setError("");
              setConfigDraft(structuredClone(data.settings));
              setKeyDraft("");
              setRemoveKey(false);
              setConfigEditing(true);
            }}
          />
        </div>
        {data && <RunnerSetupNotice />}
        <dl className="plugin-summary">
          <div>
            <dt>Status</dt>
            <dd>
              {data ? (
                <span className={data.settings.enabled ? "pill good" : "pill"}>
                  {data.settings.enabled ? "Enabled" : "Disabled"}
                </span>
              ) : (
                pendingValue
              )}
            </dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>Local containers</dd>
          </div>
          <div>
            <dt>Sign-in method</dt>
            <dd>
              {data
                ? data.settings.authMode === "device_code"
                  ? "ChatGPT device code"
                  : "Custom provider API key"
                : pendingValue}
            </dd>
          </div>
          <div>
            <dt>Credential</dt>
            <dd>{data ? credentialStatus : pendingValue}</dd>
          </div>
          <div>
            <dt>Repositories</dt>
            <dd>{data ? data.settings.repositories.length : pendingValue}</dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>
              {data ? (
                <>
                  {tasks.length} total · {activeTasks} active
                </>
              ) : (
                pendingValue
              )}
            </dd>
          </div>
        </dl>
        {data?.legacyActionsConfiguration && (
          <p className="notice" role="status">
            This workspace still has a GitHub Actions configuration. Save the
            repository configuration to use the local runner.
          </p>
        )}
      </section>
      <section
        className="card"
        aria-label="Coding repositories"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Repositories</h2>
            <p className="muted">
              Choose where selected maintainers can start coding tasks.
            </p>
          </div>
          <IconButton
            icon="add"
            label="Add coding repository"
            showLabel
            disabled={!data?.repositories.length || busy || loading}
            onClick={() => {
              setError("");
              setEditing({
                repositoryId: 0,
                baseBranch: "develop",
                maintainers: [],
              });
            }}
          />
        </div>
        {!data && !error && (
          <SkeletonRows label="Coding repositories" rows={2} />
        )}
        {data && !data.repositories.length && (
          <p>
            Use Manage GitHub on{" "}
            <NavLink to={`/admin/overview?workspace=${workspaceId}`}>
              Overview
            </NavLink>{" "}
            to connect a repository for coding tasks.
          </p>
        )}
        {data && !data.settings.repositories.length && (
          <p>No coding repositories configured.</p>
        )}
        {data?.settings.repositories.map((repo) => (
          <div className="coding-repository" key={repo.repositoryId}>
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
            <div className="row">
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
          </div>
        ))}
      </section>
      <section
        className="card"
        aria-label="Coding tasks"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Coding tasks</h2>
            <p className="muted">
              Stop cancels local execution. Published issues, branches and PRs
              remain on GitHub.
            </p>
          </div>
          {tasks.some(
            (task) =>
              !["succeeded", "failed", "unknown", "cancelled"].includes(
                task.state,
              ),
          ) && (
            <button
              type="button"
              className="secondary"
              disabled={busy || loading || !!editing}
              onClick={() => void load()}
            >
              Check progress
            </button>
          )}
        </div>
        {!data ? (
          !error && <SkeletonRows label="Coding tasks" />
        ) : !tasks.length ? (
          <p>
            No tasks yet. Ask the bot in Telegram to implement a feature or fix
            a bug in a configured repository.
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
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      {task.payload.title}
                      <br />
                      <small>
                        {task.continuous
                          ? "Continuous collaboration"
                          : "Reviewed task"}
                      </small>
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
                      {codingStatusLabel(task)}
                      {task.questionText && <p>{task.questionText}</p>}
                      {task.error && (
                        <p>
                          {taskFailures[task.error] ??
                            codingFailureMessage(task.error)}
                        </p>
                      )}
                      {!task.continuous && task.threadId && (
                        <p>
                          Codex thread <code>{task.threadId}</code>
                        </p>
                      )}
                      {!task.continuous &&
                        task.state === "running" &&
                        !task.threadId && (
                          <p className="muted">
                            Codex is running; its thread ID appears after the
                            implementation finishes.
                          </p>
                        )}
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
                          <a href={task.prUrl} target="_blank" rel="noreferrer">
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
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Stop coding task ${task.payload.title}`}
                          disabled={busy || task.cancelRequested}
                          onClick={() => {
                            setStopError("");
                            setStopping({
                              id: task.id,
                              title: task.payload.title,
                              repository: task.payload.repository,
                            });
                          }}
                        >
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {stopping && (
        <Modal
          title="Stop coding task?"
          busy={busy}
          onClose={() => {
            setStopping(undefined);
            setStopError("");
          }}
        >
          <p>
            <strong>{stopping.title}</strong>
            <br />
            <span className="muted">{stopping.repository}</span>
          </p>
          <p>
            Stopping cancels local execution. Published issues, branches and PRs
            remain on GitHub.
          </p>
          {!canStop && (
            <p role="status">This task is no longer available to stop.</p>
          )}
          {stopError && (
            <p className="notice" role="alert">
              {stopError}
            </p>
          )}
          <ModalActions>
            <button
              type="button"
              className="danger"
              disabled={busy || loading || !canStop}
              onClick={() => void stop()}
            >
              {busy ? "Stopping…" : "Stop"}
            </button>
          </ModalActions>
        </Modal>
      )}
      {configEditing && data && configDraft && (
        <Modal
          title="Edit Codex configuration"
          busy={busy}
          onClose={() => {
            setConfigEditing(false);
            setConfigDraft(undefined);
            setKeyDraft("");
            setRemoveKey(false);
            setError("");
          }}
        >
          <RunnerSetupNotice />
          {error && (
            <p className="notice" role="alert">
              {error}{" "}
              <button
                type="button"
                className="secondary"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                Reload coding settings
              </button>
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(
                configDraft,
                removeKey ? null : keyDraft.trim() || undefined,
              );
            }}
          >
            <label className="field" htmlFor="coding-auth-mode">
              <span>Sign-in method</span>
              <Select
                id="coding-auth-mode"
                value={configDraft.authMode}
                onChange={(event) =>
                  setConfigDraft({
                    ...configDraft,
                    authMode: event.target.value as CodingSettings["authMode"],
                  })
                }
              >
                <option value="provider_key">Custom provider API key</option>
                <option value="device_code">ChatGPT device code</option>
              </Select>
            </label>
            {configDraft.authMode === "provider_key" ? (
              <>
                <p className="muted">
                  Provider endpoint and model are set in deployment
                  configuration.
                  {data.providerApiKeyConfigured
                    ? " A workspace key is configured."
                    : " No workspace key is saved; a deployment key is used if configured."}
                </p>
                <label className="field">
                  <span>Provider API key</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    value={keyDraft}
                    disabled={removeKey}
                    placeholder={
                      data.providerApiKeyConfigured
                        ? "Leave blank to keep saved key"
                        : "Optional workspace key"
                    }
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                </label>
                {data.providerApiKeyConfigured && (
                  <label className="plugin-check">
                    <input
                      type="checkbox"
                      checked={removeKey}
                      onChange={(event) => {
                        setRemoveKey(event.target.checked);
                        if (event.target.checked) setKeyDraft("");
                      }}
                    />
                    <span>Remove saved key</span>
                  </label>
                )}
              </>
            ) : (
              <>
                <p role="status">
                  {deviceAction === "start"
                    ? "Requesting a sign-in link and one-time code…"
                    : deviceAction === "status"
                      ? "Checking connection…"
                      : data.deviceAuth?.state === "connected"
                        ? "Connected for this workspace."
                        : data.deviceAuth?.state === "pending"
                          ? "Waiting for you to finish sign-in."
                          : data.deviceAuth?.state === "unavailable"
                            ? "The Codex runner is unavailable. Check deployment status, then recheck connection."
                            : data.deviceAuth?.state === "auth_required"
                              ? "Your account needs sign-in again. Paused tasks will continue automatically after connection."
                              : data.deviceAuth?.state === "failed"
                                ? "Sign-in failed or expired. Start again."
                                : "No ChatGPT account connected."}
                </p>
                <p className="muted">
                  Repository access uses your connected GitHub App for public
                  and private repositories. ChatGPT sign-in authenticates Codex.
                  Use trusted code: account tokens are available during
                  implementation.
                </p>
                {data.settings.authMode !== "device_code" ? (
                  <p className="muted">
                    Save this sign-in method, then reopen configuration to
                    connect an account.
                  </p>
                ) : (
                  <>
                    {data.deviceAuth?.state === "pending" &&
                      data.deviceAuth.verificationUrl &&
                      data.deviceAuth.userCode && (
                        <p>
                          Open{" "}
                          <a
                            href={data.deviceAuth.verificationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            ChatGPT device sign-in
                          </a>
                          , then enter code{" "}
                          <code>{data.deviceAuth.userCode}</code>.
                        </p>
                      )}
                    <div className="row">
                      {data.deviceAuth?.state !== "connected" &&
                        data.deviceAuth?.state !== "pending" && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              busy ||
                              loading ||
                              data.deviceAuth?.state === "unavailable"
                            }
                            onClick={async () => {
                              setBusy(true);
                              setDeviceAction("start");
                              setError("");
                              try {
                                const status = await request<
                                  CodingPage["deviceAuth"]
                                >(
                                  `${endpoint}/device/start`,
                                  "POST",
                                  {},
                                  AbortSignal.timeout(20000),
                                );
                                setData(
                                  (current) =>
                                    current && {
                                      ...current,
                                      deviceAuth: status,
                                    },
                                );
                              } catch (cause) {
                                setError(message(cause));
                              } finally {
                                setBusy(false);
                                setDeviceAction(undefined);
                              }
                            }}
                          >
                            {deviceAction === "start"
                              ? "Starting sign-in…"
                              : "Sign in with device code"}
                          </button>
                        )}
                      {(data.deviceAuth?.state === "connected" ||
                        data.deviceAuth?.state === "pending" ||
                        data.deviceAuth?.state === "auth_required") && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || loading}
                          onClick={async () => {
                            if (
                              !confirm(
                                "Disconnect this ChatGPT account? Active coding tasks will be stopped.",
                              )
                            )
                              return;
                            setBusy(true);
                            setError("");
                            try {
                              setData(
                                await request<CodingPage>(
                                  `${endpoint}/device/logout`,
                                  "POST",
                                  {},
                                  AbortSignal.timeout(20000),
                                ),
                              );
                            } catch (cause) {
                              setError(message(cause));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Disconnect account
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || loading}
                        onClick={() => void recheckConnection()}
                      >
                        {deviceAction === "status"
                          ? "Checking connection…"
                          : "Recheck connection"}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            <p className="muted">
              Saving configuration invalidates pending approvals and requests
              cancellation of active tasks using older settings.
            </p>
            <ModalActions>
              <button type="submit" disabled={busy}>
                Save configuration
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
  const policy = draft.development ?? {
    executionMode: "reviewed",
    publishByDefault: false,
  };
  return (
    <form
      className="coding-repository-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.maintainers.length) {
          setValidation("Select at least one maintainer.");
          return;
        }
        submit(draft);
      }}
    >
      <RepositorySelect
        repositories={data.repositories.filter(
          (r) =>
            r.id === initial.repositoryId ||
            !data.settings.repositories.some((s) => s.repositoryId === r.id),
        )}
        value={draft.repositoryId}
        onChange={(repositoryId) => setDraft({ ...draft, repositoryId })}
      />
      <div className="field">
        <label htmlFor="coding-base-branch">Development / base branch</label>
        <input
          id="coding-base-branch"
          aria-describedby="coding-base-branch-help"
          required
          maxLength={150}
          value={draft.baseBranch}
          onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })}
        />
        <small id="coding-base-branch-help">
          Use an existing branch. Task branches and pull requests start here.
        </small>
      </div>
      <fieldset className="plugin-workspaces">
        <legend>Development collaboration</legend>
        <label className="field" htmlFor="coding-execution-mode">
          <span>Execution policy</span>
          <Select
            id="coding-execution-mode"
            value={policy.executionMode}
            onChange={(e) =>
              setDraft({
                ...draft,
                development: {
                  ...policy,
                  executionMode: e.target.value as "reviewed" | "direct",
                },
              })
            }
          >
            <option value="reviewed">
              Reviewed — approve each new implementation
            </option>
            <option value="direct">
              Direct — maintainer's clear instruction starts Codex
            </option>
          </Select>
          <small>
            Codex makes technical decisions. Analysis requests allow
            investigation only. Existing tasks stop if their policy changes.
          </small>
        </label>
        <label className="coding-maintainer-row">
          <input
            type="checkbox"
            checked={policy.publishByDefault}
            onChange={(e) =>
              setDraft({
                ...draft,
                development: { ...policy, publishByDefault: e.target.checked },
              })
            }
          />
          <span>Publish verified implementations as draft PRs by default</span>
        </label>
        <small>
          Codex continues implementation and check repairs until the task is
          complete, needs your input, or is stopped. Waiting for an answer
          releases the runner slot.
        </small>
      </fieldset>
      <fieldset className="coding-maintainers">
        <legend>Maintainers</legend>
        <div className="coding-maintainer-list">
          {[
            ...data.members,
            ...draft.maintainers
              .filter((id) => !data.members.some((m) => m.id === id))
              .map((id) => ({ id, active: false, username: undefined })),
          ].map((m) => (
            <label key={m.id} className="coding-maintainer-row">
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
              <span className="coding-maintainer-identity">
                <span>
                  {m.username ? `@${m.username.replace(/^@/, "")}` : m.id}
                </span>
                <small>
                  {m.username ? `Telegram ID ${m.id}` : "Telegram user ID"}
                  {!m.active && " · Access removed"}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {validation && <p role="alert">{validation}</p>}
      <ModalActions>
        <button type="submit">Save coding repository</button>
      </ModalActions>
    </form>
  );
}
