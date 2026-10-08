import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { GitHubRepository } from "../src/github/app.ts";
import type { GitHubPage } from "../src/github/config.ts";
import {
  GitHubRegistration,
  submitGitHubManifest,
} from "./github-registration.tsx";
import { Modal } from "./modal.tsx";
import { RepositoryCard } from "./repository-card.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
function explain(error: unknown) {
  const message = (error as Error).message;
  if (message.includes("version_conflict"))
    return "This workspace’s connection changed. Reload before trying again.";
  return (
    (
      {
        github_access_denied:
          "GitHub denied access. Check the App installation, organization approval and selected repositories.",
        github_authorization_expired:
          "GitHub authorization expired. Connect again to continue.",
        github_authorization_failed:
          "GitHub authorization failed. Please try again.",
        github_app_not_configured:
          "The GitHub App must be configured by your deployment operator.",
        github_unavailable: "GitHub is unavailable. Try again shortly.",
        github_selection_too_large:
          "Too many GitHub results. Limit the App installation to the repositories you need.",
        github_app_already_configured:
          "A GitHub App is already configured. Reload the connection to continue.",
      } as Record<string, string>
    )[message] ?? message
  );
}
export function GitHubSetup({
  request,
  workspaceId,
  onConnected,
}: {
  request: Request;
  workspaceId: string;
  onConnected: () => void;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github`;
  const [data, setData] = useState<GitHubPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [needsRepositoryChoice, setNeedsRepositoryChoice] = useState(false);
  const completed = useRef(false);
  const completing = useRef(false);
  const autoConnecting = useRef(false);
  const callback = new URLSearchParams(window.location.search).get("github");
  const requestedInstallation = Number(
    new URLSearchParams(window.location.search).get("installation_id"),
  );
  const selectedInstallation = data?.installations.find(
    (item) => item.id === requestedInstallation,
  );
  const needsInstallationSelection =
    !!data?.pending && data.installations.length > 1 && !selectedInstallation;
  const refresh = useCallback(async () => {
    try {
      setData(await request<GitHubPage>(endpoint));
    } catch (error) {
      setError(explain(error));
    }
  }, [request, endpoint]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (data?.connection?.installationId && !completed.current) {
      completed.current = true;
      onConnected();
    }
  }, [data, onConnected]);
  useEffect(() => {
    if (!data?.pending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4000);
    const onFocus = () => {
      if (installing) completing.current = false;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [data?.pending, installing, refresh]);
  useEffect(() => {
    if (!data?.pending || completing.current) return;
    const installation =
      selectedInstallation ??
      (data.installations.length === 1 ? data.installations[0] : undefined);
    if (!installation) return;
    completing.current = true;
    setBusy(true);
    void (async () => {
      try {
        await request(endpoint, "PUT", {
          revision: data.revision,
          installationId: installation.id,
          allRepositories: true,
        });
        completed.current = true;
        onConnected();
      } catch (error) {
        if ((error as Error).message === "github_repository_not_connected") {
          setNeedsRepositoryChoice(true);
          setError(
            "Choose at least one repository for the App in GitHub, then return here.",
          );
        } else setError(explain(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [data, endpoint, onConnected, request, selectedInstallation]);
  const connect = useCallback(async () => {
    if (!data || busy) return;
    if (data.pending) {
      if (data.installations.length && error && !needsRepositoryChoice) {
        completing.current = false;
        void refresh();
        return;
      }
      if (data.installUrl) {
        window.open(data.installUrl, "_blank", "noopener,noreferrer");
        setInstalling(true);
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (data.configured) {
        const result = await request<{ url: string }>(
          `${endpoint}/connect`,
          "POST",
          { source: "setup" },
        );
        window.location.assign(result.url);
      } else if (data.canRegister) {
        const result = await request<{ url: string; manifest: object }>(
          `${endpoint}/register`,
          "POST",
          {
            owner: "personal",
            name: "repodesk",
            public: false,
            source: "setup",
          },
        );
        submitGitHubManifest(result);
      } else {
        setError("A GitHub App is not available for this deployment.");
      }
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [busy, data, endpoint, error, needsRepositoryChoice, refresh, request]);
  useEffect(() => {
    if (
      callback !== "app-created" ||
      !data?.configured ||
      autoConnecting.current
    )
      return;
    autoConnecting.current = true;
    void connect();
  }, [callback, connect, data]);
  return (
    <>
      {callback === "failed" && (
        <p className="notice" role="alert">
          GitHub authorization did not complete. Try connecting again.
        </p>
      )}
      {callback === "registration-failed" && (
        <p className="notice" role="alert">
          GitHub App creation did not complete. Try connecting again.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <SkeletonRows label="GitHub connection" rows={1} />}
      {data?.pending && !completed.current && (
        <p className="muted" role="status">
          {needsInstallationSelection
            ? "Several App installations are available. Choose the right account in Plugins."
            : data.installations.length
              ? "Connecting the repositories approved in GitHub…"
              : installing
                ? "Complete the installation in GitHub. This page will continue when the App has repository access."
                : "GitHub account authorized. Install the App to grant repository access."}
        </p>
      )}
      {needsInstallationSelection && (
        <a href={`/admin/plugins?workspace=${workspaceId}`}>
          Choose an account in Plugins
        </a>
      )}
      {data && !data.connection?.installationId && (
        <button
          type="button"
          disabled={
            busy ||
            (!data.configured && !data.canRegister) ||
            needsInstallationSelection
          }
          onClick={() => void connect()}
        >
          {busy ? "Connecting GitHub…" : "Connect GitHub"}
        </button>
      )}
    </>
  );
}
export function GitHubConnection({
  request,
  workspaceId,
  source,
  open,
  onClose,
}: {
  request: Request;
  workspaceId: string;
  source?: "setup";
  open?: boolean;
  onClose?: () => void;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github`;
  const [data, setData] = useState<GitHubPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installation, setInstallation] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [showAllRepositories, setShowAllRepositories] = useState(false);
  const [params, setParams] = useSearchParams();
  const [internalOpen, setInternalOpen] = useState(() => params.has("github"));
  useEffect(() => {
    if (open === undefined && params.has("github")) setInternalOpen(true);
  }, [open, params]);
  const close = () => {
    setInternalOpen(false);
    onClose?.();
    setShowAllRepositories(false);
    if (params.has("github")) {
      const next = new URLSearchParams(params);
      next.delete("github");
      setParams(next, { replace: true });
    }
  };
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setRefreshError("");
    try {
      setData(await request<GitHubPage>(endpoint));
      setInstallation("");
      setRepositories([]);
      setSelected([]);
      setShowAllRepositories(false);
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [request, endpoint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Discard data and drafts when the workspace endpoint changes.
  useEffect(() => {
    setData(undefined);
    setError("");
    setRefreshError("");
    setInstallation("");
    setRepositories([]);
    setSelected([]);
    setShowAllRepositories(false);
  }, [endpoint]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await request<GitHubPage>(
          endpoint,
          "GET",
          undefined,
          signal,
        );
        const choices =
          installation && page.pending
            ? await request<GitHubRepository[]>(
                `${endpoint}/installations/${installation}/repositories`,
                "GET",
                undefined,
                signal,
              )
            : undefined;
        if (signal.aborted) return;
        setData(page);
        setRefreshError("");
        if (choices) {
          setRepositories(choices);
          setSelected((ids) =>
            ids.filter((id) => choices.some((r) => r.id === id)),
          );
        }
      } catch (error) {
        if (!signal.aborted) setRefreshError(explain(error));
      }
    },
    [endpoint, installation, request],
  );
  useRepositoryRefresh(refresh, (open ?? internalOpen) && !busy);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {(open ?? internalOpen) && (
        <Modal title="Manage GitHub" onClose={close} busy={busy}>
          <div className="github-details">
            {data ? (
              <span className="pill">
                {data.connection?.installationId
                  ? "Connected"
                  : "Not connected"}
              </span>
            ) : (
              !error && !refreshError && <Skeleton width="7rem" />
            )}
            <p>
              Connect a GitHub App to give this workspace source access to
              selected repositories and submit issues after approval in
              Telegram.
            </p>
            {params.get("github") === "failed" && (
              <p className="notice" role="alert">
                GitHub authorization did not complete. Connect again to retry.
              </p>
            )}
            {(error || refreshError) && (
              <p className="notice" role="alert">
                {error || refreshError}
              </p>
            )}
            {data?.refreshError && (
              <p className="notice" role="status">
                Repository updates are temporarily unavailable. Showing the last
                saved list. {explain(new Error(data.refreshError))}
              </p>
            )}
            {params.get("github") === "registration-failed" && (
              <p className="notice" role="alert">
                GitHub App setup did not complete. Reload the page to check
                whether an App is already configured. If GitHub created an App
                but setup failed here, remove that unused App in GitHub before
                retrying, or configure it manually.
              </p>
            )}
            {params.get("github") === "app-created" && data?.configured && (
              <p role="status">
                GitHub App created. Install it on the repositories you need,
                then connect this workspace.
              </p>
            )}
            {!data && !error && !refreshError && (
              <SkeletonRows label="GitHub connection" rows={2} />
            )}
            {data?.canRegister && (
              <GitHubRegistration
                request={request}
                endpoint={endpoint}
                onError={(error) => setError(explain(error))}
                source={source}
              />
            )}
            {data && !data.configured && !data.canRegister && (
              <p className="notice">
                A deployment operator must register and configure the GitHub App
                before connecting.
              </p>
            )}
            {data?.configured && (
              <p>
                App: <strong>{data.appSlug}</strong>.{" "}
                <a href={data.installUrl} target="_blank" rel="noreferrer">
                  Install or update the GitHub App
                </a>
              </p>
            )}
            {data?.connection?.installationId && (
              <>
                <p>
                  Connected to <strong>{data.connection.account}</strong> by{" "}
                  {data.connection.connectedBy}.
                </p>
                <p className="muted">
                  To submit issues, grant the App Issues: read and write in
                  GitHub and approve the updated installation permissions. Then
                  ask the Telegram assistant to draft an issue and review its
                  Approve/Reject buttons.
                </p>
                <ul
                  className="repository-list"
                  aria-label="Connected repositories"
                >
                  {(showAllRepositories
                    ? data.connection.repositories
                    : data.connection.repositories.slice(0, 5)
                  ).map((repo) => (
                    <li className="repository-list-item" key={repo.id}>
                      <RepositoryCard
                        compact
                        name={repo.full_name}
                        url={`https://github.com/${repo.full_name}`}
                      />
                    </li>
                  ))}
                  {data.connection.repositories.length > 5 && (
                    <li className="repository-list-item">
                      <button
                        type="button"
                        className="github-repository-more"
                        aria-expanded={showAllRepositories}
                        onClick={() =>
                          setShowAllRepositories(!showAllRepositories)
                        }
                      >
                        {showAllRepositories
                          ? "Show less"
                          : `${data.connection.repositories.length - 5} more`}
                      </button>
                    </li>
                  )}
                </ul>
              </>
            )}
            {data?.configured && !data.connection && (
              <p className="muted">
                Existing deployment credentials may apply until you connect or
                disconnect this workspace.
              </p>
            )}
            {data?.connection && !data.connection.installationId && (
              <p className="muted">
                Private repository access is disconnected. Public repositories
                can still be queried.
              </p>
            )}
            <div className="row">
              {data?.configured && !data.connection?.installationId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await request<{ url: string }>(
                        `${endpoint}/connect`,
                        "POST",
                        source ? { source } : {},
                      );
                      window.location.assign(result.url);
                    })
                  }
                >
                  Connect GitHub
                </button>
              )}
              {(error || refreshError) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  Reload GitHub connection
                </button>
              )}
            </div>
            {data?.pending && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await request(endpoint, "PUT", {
                      revision: data.revision,
                      installationId: Number(installation),
                      repositoryIds: selected,
                    });
                    window.location.reload();
                  });
                }}
              >
                <h3>Choose repositories for this workspace</h3>
                <p>
                  Authorized as {data.login}. Select an installation, then the
                  repositories this workspace may query and submit issues to.
                </p>
                <p>
                  After GitHub approves the installation, reopen this page to
                  see it.
                </p>
                <fieldset disabled={busy} className="plugin-fields">
                  <label className="field" htmlFor="github-installation">
                    <span>GitHub installation</span>
                    <Select
                      id="github-installation"
                      required
                      value={installation}
                      onChange={(event) => {
                        const id = event.target.value;
                        setInstallation(id);
                        setRepositories([]);
                        setSelected([]);
                        if (id)
                          void act(async () =>
                            setRepositories(
                              await request<GitHubRepository[]>(
                                `${endpoint}/installations/${id}/repositories`,
                              ),
                            ),
                          );
                      }}
                    >
                      <option value="">Choose an account</option>
                      {data.installations.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.account}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {!data.installations.length && (
                    <p>
                      No accessible installations yet. Install the App or ask
                      your organization owner to approve it, then reopen this
                      page.
                    </p>
                  )}
                  {!!installation && !repositories.length && (
                    <p>No accessible repositories in this installation.</p>
                  )}
                  {repositories.map((repo) => (
                    <label className="checkbox" key={repo.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(repo.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, repo.id]
                              : selected.filter((id) => id !== repo.id),
                          )
                        }
                      />
                      {repo.full_name}
                    </label>
                  ))}
                  <button type="submit" disabled={!selected.length}>
                    Connect selected repositories
                  </button>
                </fieldset>
              </form>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
