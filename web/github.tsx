import { useCallback, useEffect, useState } from "react";
import type { GitHubRepository } from "../src/github/app.ts";
import type { GitHubPage } from "../src/github/config.ts";
import { GitHubRegistration } from "./github-registration.tsx";
import { IconButton } from "./icon-button.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
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
export function GitHubConnection({
  request,
  workspaceId,
}: {
  request: Request;
  workspaceId: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github`;
  const [data, setData] = useState<GitHubPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installation, setInstallation] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setData(await request<GitHubPage>(endpoint));
      setInstallation("");
      setRepositories([]);
      setSelected([]);
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [request, endpoint]);
  useEffect(() => {
    void load();
  }, [load]);
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
    <section className="card" aria-label="GitHub connection">
      <div className="row">
        <h2>GitHub</h2>
        <span className="pill">
          {data?.connection?.installationId ? "Connected" : "Not connected"}
        </span>
      </div>
      <p>
        Connect a GitHub App to give this workspace read access to selected
        repositories.
      </p>
      {new URLSearchParams(window.location.search).get("github") ===
        "failed" && (
        <p className="notice" role="alert">
          GitHub authorization did not complete. Connect again to retry.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {new URLSearchParams(window.location.search).get("github") ===
        "registration-failed" && (
        <p className="notice" role="alert">
          GitHub App setup did not complete. Reload to check whether an App is
          already configured. If GitHub created an App but setup failed here,
          remove that unused App in GitHub before retrying, or configure it
          manually.
        </p>
      )}
      {new URLSearchParams(window.location.search).get("github") ===
        "app-created" &&
        data?.configured && (
          <p role="status">
            GitHub App created. Install it on the repositories you need, then
            connect this workspace.
          </p>
        )}
      {!data && <p role="status">Loading GitHub connection…</p>}
      {data?.canRegister && (
        <GitHubRegistration
          request={request}
          endpoint={endpoint}
          onError={(error) => setError(explain(error))}
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
          <ul>
            {data.connection.repositories.map((repo) => (
              <li key={repo.id}>{repo.full_name}</li>
            ))}
          </ul>
        </>
      )}
      {data && !data.connection && (
        <p className="muted">
          Existing deployment credentials may apply until you connect or
          disconnect this workspace.
        </p>
      )}
      {data?.connection && !data.connection.installationId && (
        <p className="muted">
          Private repository access is disconnected. Public repositories can
          still be queried.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          disabled={busy || !data?.configured}
          onClick={() =>
            void act(async () => {
              const result = await request<{ url: string }>(
                `${endpoint}/connect`,
                "POST",
                {},
              );
              window.location.assign(result.url);
            })
          }
        >
          {data?.connection?.installationId
            ? "Change GitHub connection"
            : "Connect GitHub"}
        </button>
        <IconButton
          icon="refresh"
          label="Reload GitHub connection"
          type="button"
          busy={busy}
          onClick={() => void load()}
        />
        {data &&
          (!data.connection ||
            data.connection.installationId ||
            data.pending) && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Disconnect GitHub from this workspace? Private repository access and deployment-token fallback will stop for this workspace.",
                  )
                )
                  return;
                void act(async () => {
                  await request(endpoint, "DELETE", {
                    revision: data.revision,
                  });
                  window.location.reload();
                });
              }}
            >
              Disconnect GitHub
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
            repositories this workspace may query.
          </p>
          <p>After GitHub approves the installation, reload this connection.</p>
          <fieldset disabled={busy} className="plugin-fields">
            <label className="field">
              <span>GitHub installation</span>
              <select
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
              </select>
            </label>
            {!data.installations.length && (
              <p>
                No accessible installations yet. Install the App or ask your
                organization owner to approve it, then reload.
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
                  disabled={
                    selected.length >= 12 && !selected.includes(repo.id)
                  }
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
    </section>
  );
}
