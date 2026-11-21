import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AntigravityEffort,
  AntigravityPage,
  AntigravitySettings,
} from "../src/coding/config.ts";
import { codingFailureMessage } from "../src/coding/failure-messages.ts";
import { codingStatusLabel } from "../src/coding/feedback.ts";
import { CodingEnvironments } from "./coding-environments.tsx";
import { CodingRuntime } from "./coding-runtime.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast } from "./toast.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

const effortLabels: Record<AntigravityEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const commonModels = [
  "gemini-4-neon-high",
  "gemini-4-neon-xhigh",
  "gemini-4-neon-medium",
  "gemini-4-argon-high",
  "gemini-4-hydrogen-high",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-high",
];

function message(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError")
    return "The connection request timed out. Recheck connection before trying sign-in again.";
  const code = (error as Error).message;
  if (code.startsWith("version_conflict"))
    return "Settings changed in another session. Reload and review your edits.";
  const messages: Record<string, string> = {
    github_repository_not_connected:
      "Connect the selected repository in GitHub before saving.",
    coding_device_auth_required:
      "Connect a Google account or configure a Gemini API key before starting Antigravity CLI tasks.",
    coding_antigravity_login_unavailable:
      "Google sign-in could not start. Check that Antigravity CLI (agy) is installed on the runner and retry.",
    coding_antigravity_login_network_failed:
      "Antigravity CLI could not establish a secure connection to Google. Check the runner's network and certificates, then retry.",
    coding_antigravity_login_rejected:
      "Google rejected the authorization code. Start sign-in again and paste the fresh code or callback URL.",
    coding_antigravity_login_failed:
      "Google sign-in did not complete. Start sign-in again and verify the authorization code.",
    coding_antigravity_login_not_pending:
      "No Google sign-in session is pending. Click Sign in with Google to start a new link.",
    coding_antigravity_login_busy:
      "Too many sign-ins are pending. Finish or cancel another sign-in first.",
    coding_runner_not_configured:
      "The coding runner is not configured for this deployment. Configure it, then recheck connection.",
    coding_runner_unavailable:
      "The coding runner could not be reached. Recheck connection after it is available.",
    coding_outcome_unknown:
      "The sign-in response could not be confirmed. Recheck connection before trying again.",
    invalid_request: "Check the configuration fields.",
  };
  return messages[code] ?? code;
}

const taskFailures: Record<string, string> = {
  coding_device_auth_required:
    "Sign in to your Google account in Configuration. This task will continue automatically.",
  coding_checkpoint_expired:
    "The saved checkout expired. Start a new task to continue.",
  coding_verification_invalid:
    "Antigravity CLI did not provide runnable verification checks.",
  coding_budget_exhausted:
    "Task limits reached. Review its result before starting another task.",
  coding_token_limit: "Antigravity CLI reached the task's token limit.",
  coding_publication_unknown:
    "Publication could not be confirmed. Inspect GitHub before starting more work.",
  coding_pr_closed:
    "The task's PR is closed or merged. It will not be recreated automatically.",
  coding_source_expired:
    "A retained source expired or was removed; the task was stopped.",
  coding_configuration_changed:
    "Repository configuration changed; the task was stopped.",
  coding_setup_failed: "Repository environment preparation failed.",
  coding_codex_failed:
    "Antigravity CLI stopped before completing the implementation.",
  coding_check_failed: "The repository verification checks failed.",
  coding_patch_empty: "Antigravity CLI produced no changes to publish.",
  coding_execution_failed: "Implementation or repository verification failed.",
};

function AntigravitySetupNotice() {
  return (
    <p className="muted">
      Antigravity CLI uses the deployment’s coding runner with the{" "}
      <code>agy</code> CLI binary installed. Enable this plugin, then sign in
      with Google OAuth or save a Gemini API key. If the runner is unavailable,
      check deployment status and recheck the connection.{" "}
      <a
        href="https://antigravity.google/docs/install"
        target="_blank"
        rel="noopener noreferrer"
      >
        Antigravity CLI authentication docs
      </a>
      .
    </p>
  );
}

export function Antigravity({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo?: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/antigravity`;
  const [data, setData] = useState<AntigravityPage>();
  const [actionError, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const error = actionError || refreshError;
  const [busy, setBusy] = useState(false);
  const [authAction, setAuthAction] = useState<
    "start" | "complete" | "status"
  >();
  const [loading, setLoading] = useState(false);
  const [configEditing, setConfigEditing] = useState(false);
  const configActions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (configEditing && error && !busy)
      configActions.current?.scrollIntoView({ block: "nearest" });
  }, [configEditing, error, busy]);

  const [configDraft, setConfigDraft] = useState<AntigravitySettings>();
  const [keyDraft, setKeyDraft] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const [stopping, setStopping] = useState<{
    id: string;
    title: string;
    repository: string;
  }>();
  const [stopError, setStopError] = useState("");

  const preserveSettings = configEditing;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await request<AntigravityPage>(
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
    data?.oauthAuth?.state === "pending" ? 3000 : 5000,
  );

  const recheckConnection = async () => {
    setBusy(true);
    setAuthAction("status");
    setError("");
    try {
      setData(
        await request<AntigravityPage>(
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
      setAuthAction(undefined);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setRefreshError("");
    try {
      setData(await request<AntigravityPage>(endpoint));
      setConfigEditing(false);
      setConfigDraft(undefined);
      setKeyDraft("");
      setRemoveKey(false);
      setCodeDraft("");
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
    setConfigEditing(false);
    setConfigDraft(undefined);
    setKeyDraft("");
    setRemoveKey(false);
    setCodeDraft("");
    setStopping(undefined);
    setStopError("");
  }, [endpoint]);

  const save = async (
    settings: AntigravitySettings,
    apiKey?: string | null,
  ) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      const cleanedSettings: AntigravitySettings = {
        enabled: settings.enabled,
        authMode: settings.authMode,
        ...(settings.model?.trim() ? { model: settings.model.trim() } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.authMode === "gemini_api_key" && settings.baseUrl?.trim()
          ? { baseUrl: settings.baseUrl.trim() }
          : {}),
        ...(settings.development ? { development: settings.development } : {}),
      };
      setData(
        await request<AntigravityPage>(endpoint, "PUT", {
          revision: data.revision,
          settings: cleanedSettings,
          ...(apiKey !== undefined ? { apiKey } : {}),
        }),
      );
      setConfigEditing(false);
      setConfigDraft(undefined);
      setKeyDraft("");
      setRemoveKey(false);
      setCodeDraft("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const tasks = data?.tasks ?? [];
  const stopTask = tasks.find((task) => task.id === stopping?.id);
  const canStop =
    !!stopTask &&
    !stopTask.cancelRequested &&
    !["failed", "unknown", "cancelled"].includes(stopTask.state);

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
    (task) => !["failed", "unknown", "cancelled"].includes(task.state),
  ).length;
  const pendingValue = error ? "—" : <Skeleton width="9rem" />;

  const credentialStatus =
    data?.settings.authMode === "google_oauth"
      ? data.oauthAuth?.state === "connected"
        ? "Google account connected"
        : data.oauthAuth?.state === "pending"
          ? "Sign-in pending"
          : data.oauthAuth?.state === "auth_required"
            ? "Google sign-in required"
            : "Google account not connected"
      : data?.apiKeyConfigured
        ? "Gemini API key configured"
        : "No Gemini API key";

  return (
    <section
      className="coding-detail"
      id="antigravity-tasks"
      aria-label="Antigravity CLI implementation"
    >
      {backTo && (
        <PluginDetailHeading title="Antigravity CLI" backTo={backTo}>
          <PluginToggle
            name="Antigravity CLI"
            enabled={data?.settings.enabled}
            loading={!data && !error}
            disabled={!data || busy || loading}
            onChange={(enabled) => {
              if (data) void save({ ...data.settings, enabled });
            }}
          />
        </PluginDetailHeading>
      )}
      {error && !configEditing && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Retry loading Antigravity CLI settings"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      {data?.repositoryRefreshError && (
        <p className="notice" role="status">
          Repository updates are temporarily unavailable. Showing the last saved
          list. Check the GitHub App connection if this continues.
        </p>
      )}
      <CodingRuntime request={request} />
      <section
        className="card"
        aria-label="Antigravity CLI configuration"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Configuration</h2>
            <p className="muted">
              Isolated coding tasks, investigations, releases and PRs powered by
              Antigravity CLI.
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Antigravity CLI configuration"
            showLabel
            disabled={!data || busy || loading}
            onClick={() => {
              if (!data) return;
              setError("");
              setConfigDraft(structuredClone(data.settings));
              setKeyDraft("");
              setRemoveKey(false);
              setCodeDraft("");
              setConfigEditing(true);
            }}
          />
        </div>
        <p className="muted">
          Repository access follows your connected GitHub account and GitHub
          App. Tasks use the repository’s default branch. Manage access in
          GitHub.
        </p>
        {data && <AntigravitySetupNotice />}
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
            <dt>Sign-in method</dt>
            <dd>
              {data
                ? data.settings.authMode === "google_oauth"
                  ? "Google account (OAuth)"
                  : "Gemini API key"
                : pendingValue}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {data
                ? (data.settings.model ?? "Antigravity default")
                : pendingValue}
            </dd>
          </div>
          <div>
            <dt>Reasoning effort</dt>
            <dd>
              {data
                ? data.settings.effort
                  ? effortLabels[data.settings.effort]
                  : "Model default"
                : pendingValue}
            </dd>
          </div>
          <div>
            <dt>Credential</dt>
            <dd>{data ? credentialStatus : pendingValue}</dd>
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
      </section>
      <section
        className="card"
        aria-label="Antigravity coding tasks"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Coding tasks</h2>
            <p className="muted">
              Stop cancels local execution. Published branches and PRs remain on
              GitHub.
            </p>
          </div>
          {tasks.some(
            (task) => !["failed", "unknown", "cancelled"].includes(task.state),
          ) && (
            <button
              type="button"
              className="secondary"
              disabled={busy || loading || configEditing}
              onClick={() => void load()}
            >
              Check progress
            </button>
          )}
        </div>
        {!data ? (
          !error && <SkeletonRows label="Antigravity coding tasks" />
        ) : !tasks.length ? (
          <p>
            No tasks yet. Ask the bot in Telegram to implement a feature or fix
            a bug with Antigravity CLI in a connected repository.
          </p>
        ) : (
          <div className="usage-table-scroll">
            <table className="coding-task-table">
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
                    <td data-label="Task">
                      {task.payload.title}
                      <br />
                      <small>
                        {new Date(task.createdAt).toLocaleString()} ·{" "}
                        {task.actor}
                      </small>
                      <br />
                      <code>{task.id}</code>
                    </td>
                    <td data-label="Repository / base">
                      {task.payload.repository}
                      <br />
                      <code>{task.payload.baseBranch}</code>
                    </td>
                    <td data-label="Status">
                      {codingStatusLabel(task)}
                      {task.question?.text && <p>{task.question?.text}</p>}
                      {task.error && (
                        <p>
                          {taskFailures[task.error] ??
                            codingFailureMessage(task.error, task.payload)}
                        </p>
                      )}
                    </td>
                    <td data-label="Links">
                      {task.pr?.url && (
                        <p>
                          <a
                            href={task.pr?.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PR
                          </a>
                        </p>
                      )}
                    </td>
                    <td data-label="Actions">
                      {!["failed", "unknown", "cancelled"].includes(
                        task.state,
                      ) && (
                        <IconButton
                          icon="stop"
                          className="danger"
                          label={`Stop coding task ${task.payload.title}`}
                          disabled={busy || task.cancelRequested}
                          onClick={() => {
                            setStopError("");
                            setStopping({
                              id: task.id,
                              title: task.payload.title,
                              repository: task.payload.repository,
                            });
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
      <CodingEnvironments
        request={request}
        workspaceId={workspaceId}
        repositories={data?.repositories ?? []}
        tasks={tasks}
      />
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
            Stopping cancels local execution. Published branches and PRs remain
            on GitHub.
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
          title="Edit Antigravity CLI configuration"
          busy={busy}
          onClose={() => {
            setConfigEditing(false);
            setConfigDraft(undefined);
            setKeyDraft("");
            setRemoveKey(false);
            setCodeDraft("");
            setError("");
          }}
        >
          <AntigravitySetupNotice />
          <form
            className="record-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(
                configDraft,
                configDraft.authMode === "gemini_api_key"
                  ? removeKey
                    ? null
                    : keyDraft.trim() || undefined
                  : undefined,
              );
            }}
          >
            <label className="field" htmlFor="antigravity-auth-mode">
              <span>Sign-in method</span>
              <Select
                id="antigravity-auth-mode"
                value={configDraft.authMode}
                disabled={busy}
                onChange={(event) =>
                  setConfigDraft({
                    ...configDraft,
                    authMode: event.target
                      .value as AntigravitySettings["authMode"],
                  })
                }
              >
                <option value="google_oauth">Google account (OAuth)</option>
                <option value="gemini_api_key">Gemini API key</option>
              </Select>
            </label>
            <label className="field" htmlFor="antigravity-model">
              <span>Model (optional)</span>
              <input
                id="antigravity-model"
                type="text"
                list="antigravity-model-suggestions"
                maxLength={120}
                disabled={busy}
                value={configDraft.model ?? ""}
                placeholder="Leave blank for Antigravity default"
                onChange={(event) =>
                  setConfigDraft({
                    ...configDraft,
                    model: event.target.value || undefined,
                  })
                }
              />
              <datalist id="antigravity-model-suggestions">
                {commonModels.map((slug) => (
                  <option key={slug} value={slug} />
                ))}
              </datalist>
            </label>
            <label className="field" htmlFor="antigravity-effort">
              <span>Reasoning effort</span>
              <Select
                id="antigravity-effort"
                value={configDraft.effort ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setConfigDraft({
                    ...configDraft,
                    effort:
                      (event.target.value as AntigravityEffort) || undefined,
                  })
                }
              >
                <option value="">Model default</option>
                {(Object.keys(effortLabels) as AntigravityEffort[]).map(
                  (level) => (
                    <option key={level} value={level}>
                      {effortLabels[level]}
                    </option>
                  ),
                )}
              </Select>
            </label>
            {configDraft.authMode === "gemini_api_key" ? (
              <>
                <label className="field" htmlFor="antigravity-api-key">
                  <span>Gemini API key</span>
                  <input
                    id="antigravity-api-key"
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    value={keyDraft}
                    disabled={busy || removeKey}
                    placeholder={
                      data.apiKeyConfigured
                        ? "Leave blank to keep saved key"
                        : "Paste your Gemini API key"
                    }
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                </label>
                {data.apiKeyConfigured && (
                  <label className="plugin-check">
                    <input
                      type="checkbox"
                      checked={removeKey}
                      disabled={busy}
                      onChange={(event) => {
                        setRemoveKey(event.target.checked);
                        if (event.target.checked) setKeyDraft("");
                      }}
                    />
                    <span>Remove saved API key</span>
                  </label>
                )}
                <label className="field" htmlFor="antigravity-base-url">
                  <span>Custom Gemini base URL (optional)</span>
                  <input
                    id="antigravity-base-url"
                    type="url"
                    maxLength={500}
                    disabled={busy}
                    value={configDraft.baseUrl ?? ""}
                    placeholder="https://generativelanguage.googleapis.com"
                    onChange={(event) =>
                      setConfigDraft({
                        ...configDraft,
                        baseUrl: event.target.value || undefined,
                      })
                    }
                  />
                </label>
                <p className="muted">
                  The API key stays encrypted on the server and is proxied by
                  the runner; task containers never see the raw key.
                </p>
              </>
            ) : (
              <>
                <p role="status">
                  {authAction === "start"
                    ? "Requesting a Google sign-in link…"
                    : authAction === "complete"
                      ? "Completing Google sign-in…"
                      : authAction === "status"
                        ? "Checking connection…"
                        : data.oauthAuth?.state === "connected"
                          ? "Connected for this workspace."
                          : data.oauthAuth?.state === "pending"
                            ? "Waiting for you to finish Google sign-in."
                            : data.oauthAuth?.state === "unavailable"
                              ? "The coding runner is unavailable. Check deployment status, then recheck connection."
                              : data.oauthAuth?.state === "auth_required"
                                ? "Your Google account needs sign-in again. Paused tasks will continue automatically after connection."
                                : data.oauthAuth?.state === "failed"
                                  ? "Sign-in failed or expired. Start again."
                                  : "No Google account connected."}
                </p>
                <p className="muted">
                  Repository access uses your connected GitHub App for public
                  and private repositories. Google sign-in authenticates
                  Antigravity CLI. Use trusted code: account tokens are
                  available during implementation.
                </p>
                {data.settings.authMode !== "google_oauth" ? (
                  <p className="muted">
                    Save this sign-in method, then reopen configuration to
                    connect a Google account.
                  </p>
                ) : (
                  <>
                    {data.oauthAuth?.state === "pending" &&
                      data.oauthAuth.verificationUrl && (
                        <>
                          <p>
                            Open{" "}
                            <a
                              href={data.oauthAuth.verificationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Google sign-in
                            </a>
                            , finish signing in, then paste the authorization
                            code or full callback URL below.
                          </p>
                          <label
                            className="field"
                            htmlFor="antigravity-auth-code"
                          >
                            <span>Authorization code or callback URL</span>
                            <input
                              id="antigravity-auth-code"
                              type="text"
                              autoComplete="off"
                              maxLength={4096}
                              disabled={busy}
                              value={codeDraft}
                              placeholder="Paste authorization code or redirect URL"
                              onChange={(event) =>
                                setCodeDraft(event.target.value)
                              }
                            />
                          </label>
                        </>
                      )}
                    <div className="row">
                      {data.oauthAuth?.state !== "connected" &&
                        data.oauthAuth?.state !== "pending" && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              busy ||
                              loading ||
                              data.oauthAuth?.state === "unavailable"
                            }
                            onClick={async () => {
                              setBusy(true);
                              setAuthAction("start");
                              setError("");
                              setCodeDraft("");
                              try {
                                const status = await request<
                                  AntigravityPage["oauthAuth"]
                                >(
                                  `${endpoint}/auth/start`,
                                  "POST",
                                  {},
                                  AbortSignal.timeout(20000),
                                );
                                setData(
                                  (current) =>
                                    current && {
                                      ...current,
                                      oauthAuth: status,
                                    },
                                );
                              } catch (cause) {
                                setError(message(cause));
                              } finally {
                                setBusy(false);
                                setAuthAction(undefined);
                              }
                            }}
                          >
                            {authAction === "start"
                              ? "Starting sign-in…"
                              : "Sign in with Google"}
                          </button>
                        )}
                      {data.oauthAuth?.state === "pending" && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || loading || !codeDraft.trim()}
                          onClick={async () => {
                            setBusy(true);
                            setAuthAction("complete");
                            setError("");
                            try {
                              const updated = await request<AntigravityPage>(
                                `${endpoint}/auth/complete`,
                                "POST",
                                { code: codeDraft.trim() },
                                AbortSignal.timeout(35000),
                              );
                              setData(updated);
                              setCodeDraft("");
                            } catch (cause) {
                              setError(message(cause));
                            } finally {
                              setBusy(false);
                              setAuthAction(undefined);
                            }
                          }}
                        >
                          {authAction === "complete"
                            ? "Completing sign-in…"
                            : "Complete sign-in"}
                        </button>
                      )}
                      {(data.oauthAuth?.state === "connected" ||
                        data.oauthAuth?.state === "pending" ||
                        data.oauthAuth?.state === "auth_required") && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || loading}
                          onClick={async () => {
                            if (
                              !confirm(
                                "Disconnect this Google account? Active Antigravity CLI tasks will be stopped.",
                              )
                            )
                              return;
                            setBusy(true);
                            setError("");
                            try {
                              setData(
                                await request<AntigravityPage>(
                                  `${endpoint}/auth/logout`,
                                  "POST",
                                  {},
                                  AbortSignal.timeout(20000),
                                ),
                              );
                              setCodeDraft("");
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
                        {authAction === "status"
                          ? "Checking connection…"
                          : "Recheck connection"}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            <p className="muted">
              Saving configuration requests cancellation of active tasks using
              older settings.
            </p>
            <div ref={configActions}>
              {error && (
                <p className="notice" role="alert">
                  {error}{" "}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || loading}
                    onClick={() => void load()}
                  >
                    Reload Antigravity settings
                  </button>
                </p>
              )}
              <ModalActions>
                <button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save configuration"}
                </button>
              </ModalActions>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
