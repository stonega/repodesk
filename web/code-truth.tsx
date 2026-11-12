import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router";
import type {
  CodeRepository,
  CodeTruthPage,
  CodeTruthSettings,
  CodeTruthStatus,
} from "../src/code-truth/config.ts";
import { codeRepositorySchema } from "../src/code-truth/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { RepositoryCard } from "./repository-card.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const repositoryName = (url: string) =>
  new URL(url).pathname.slice(1).replace(/\.git$/, "");

const explain = (error: unknown) => {
  const message = (error as Error).message;
  if (message.includes("version_conflict"))
    return "Plugin settings changed in another session. Reload Code Truth and review your changes.";
  return (
    (
      {
        code_truth_unavailable:
          "The local Code Truth service is unavailable. Check its process and service credentials, then retry.",
        github_access_denied:
          "GitHub denied repository access. Check the App installation and reconnect GitHub for this workspace.",
        github_unavailable: "GitHub is unavailable. Try again shortly.",
        github_app_not_configured:
          "The GitHub App is not configured on this deployment.",
        github_repository_not_connected:
          "Connect this repository under GitHub for the selected workspace first.",
        code_truth_disabled: "Enable Code Truth before indexing.",
        code_truth_no_repositories:
          "Grant a saved repository to this workspace first.",
        invalid_request:
          "Check HTTPS GitHub URLs and descriptions (up to 2,000 characters).",
        extension_tool_collision:
          "A registered plugin already uses a Code Truth tool name in this workspace.",
        access_denied: "You can grant access only to your own workspaces.",
      } as Record<string, string>
    )[message] ?? message
  );
};
export function CodeTruth({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo?: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/code-truth`;
  const [data, setData] = useState<CodeTruthPage>();
  const [error, setError] = useState("");
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const pendingSave = useRef(false);
  const [editingRepository, setEditingRepository] = useState<number | "new">();
  const [status, setStatus] = useState<CodeTruthStatus>();
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const page = await request<CodeTruthPage>(endpoint);
      setData(page);
      setStatus(undefined);
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [request, endpoint]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (value: CodeTruthSettings) => {
    if (!data || busy || pendingSave.current) throw new Error("pending");
    pendingSave.current = true;
    setBusy(true);
    setError("");
    try {
      const page = await request<CodeTruthPage>(endpoint, "PUT", {
        revision: data.revision,
        settings: value,
      });
      setData(page);
      setStatus(undefined);
      notify(
        "Code Truth saved. These settings apply to new runs in this workspace.",
      );
    } finally {
      pendingSave.current = false;
      setBusy(false);
    }
  };
  const settings = data?.settings;
  const nameForTarget = (id: string) => {
    const repo = data?.settings.repositories.find((r) => r.id === id);
    return repo ? repositoryName(repo.repositoryUrl) : "Repository";
  };
  const pendingValue = error ? "—" : <Skeleton width="8rem" />;
  return (
    <section
      className="plugin-detail"
      aria-label="Predefined Code Truth extension"
    >
      {backTo && (
        <PluginDetailHeading title="Code Truth" backTo={backTo}>
          <PluginToggle
            name="Code Truth"
            enabled={data?.settings.enabled}
            loading={!data && !error}
            disabled={busy || !data}
            onChange={(enabled) => {
              if (settings)
                void save({ ...settings, enabled }).catch((error) =>
                  setError(explain(error)),
                );
            }}
          />
        </PluginDetailHeading>
      )}
      {!data?.serviceConfigured && data && (
        <p className="notice">
          The local service is not configured. You can save repositories now;
          configure CODE_TRUTH_URL and its service token on the API and worker
          to use them.
        </p>
      )}
      {error && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Retry loading Code Truth"
            disabled={busy}
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card"
        aria-label="Code Truth configuration"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading">
          <div>
            <h2>Configuration</h2>
            <p className="muted">
              Query indexed source code, dependencies and architecture.
            </p>
          </div>
        </div>
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
            <dd>Read-only code tools · v1</dd>
          </div>
          <div>
            <dt>Service</dt>
            <dd>
              {data
                ? data.serviceConfigured
                  ? "Configured"
                  : "Not configured"
                : pendingValue}
            </dd>
          </div>
          <div>
            <dt>Repositories</dt>
            <dd>{data ? data.settings.repositories.length : pendingValue}</dd>
          </div>
          <div>
            <dt>Saved revision</dt>
            <dd>{data ? data.revision : pendingValue}</dd>
          </div>
        </dl>
      </section>
      <section
        className="card"
        aria-label="Code Truth repositories"
        aria-busy={!data && !error}
      >
        <fieldset disabled={busy || !data} className="code-truth-fields">
          <div className="plugin-card-heading">
            <div>
              <h2>Repositories</h2>
              <p className="muted">
                Index each repository's default GitHub branch automatically.
              </p>
            </div>
            <IconButton
              icon="add"
              label="Add repository"
              showLabel
              disabled={(settings?.repositories.length ?? 0) >= 12}
              onClick={() => setEditingRepository("new")}
            />
          </div>
          <p className="muted">
            Add HTTPS GitHub repositories for this workspace. Use Manage GitHub
            on{" "}
            <NavLink to={`/admin/overview?workspace=${workspaceId}`}>
              Overview
            </NavLink>{" "}
            to access private repositories through your GitHub App.
          </p>
          {!data && !error && (
            <SkeletonRows label="Code Truth repositories" rows={2} />
          )}
          {settings?.repositories.length === 0 && (
            <p>No repositories configured.</p>
          )}
          {!!settings?.repositories.length && (
            <div className="repository-list repository-list-stacked">
              {settings.repositories.map((repo, index) => (
                <RepositoryCard
                  key={repo.id}
                  label={`Repository ${index + 1}`}
                  name={repositoryName(repo.repositoryUrl)}
                  url={repo.repositoryUrl}
                  actions={
                    <>
                      <IconButton
                        icon="edit"
                        label={`Edit repository ${index + 1}`}
                        onClick={() => setEditingRepository(index)}
                      />
                      <IconButton
                        icon="delete"
                        label={`Remove repository ${index + 1}`}
                        className="danger"
                        onClick={() =>
                          void save({
                            ...settings,
                            repositories: settings.repositories.filter(
                              (_, i) => i !== index,
                            ),
                          }).catch((error) => setError(explain(error)))
                        }
                      />
                    </>
                  }
                >
                  <div className="code-truth-repository-details">
                    {repo.description && (
                      <p className="repository-card-note">{repo.description}</p>
                    )}
                    <p className="repository-card-note muted">
                      Default GitHub branch
                    </p>
                  </div>
                </RepositoryCard>
              ))}
            </div>
          )}
        </fieldset>
      </section>
      {editingRepository !== undefined && settings && (
        <RepositoryEditor
          initial={
            editingRepository === "new"
              ? undefined
              : settings.repositories[editingRepository]
          }
          workspaceId={workspaceId}
          busy={busy}
          existingUrls={settings.repositories
            .filter((_, i) => i !== editingRepository)
            .map((r) => r.repositoryUrl)}
          close={() => setEditingRepository(undefined)}
          save={async (repo) => {
            await save({
              ...settings,
              repositories:
                editingRepository === "new"
                  ? [...settings.repositories, repo]
                  : settings.repositories.map((saved, index) =>
                      index === editingRepository ? repo : saved,
                    ),
            });
            setEditingRepository(undefined);
          }}
        />
      )}
      <section className="card" aria-label="Repository indexing status">
        <div className="plugin-card-heading">
          <div>
            <h2>Repository indexing status</h2>
          </div>
        </div>
        <p className="muted">
          Sync and check this workspace. Indexing runs locally and can take
          several minutes. Active configurations refresh on use at most every
          five minutes.
        </p>
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={busy || !workspaceId || !data?.settings.enabled}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await request<CodeTruthStatus>(
                  `${endpoint}/status`,
                  "POST",
                  {},
                );
                setStatus(result);
                if (!result.syncing) notify("Index status refreshed.");
              } catch (error) {
                setError(explain(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sync & check indexes
          </button>
        </div>
        {status && (
          <div>
            {status.syncing && (
              <p role="status">Indexing in progress. Check again shortly.</p>
            )}
            {status.targets.map((t) => (
              <div key={t.target}>
                <h3>{nameForTarget(t.target)}</h3>
                {t.networks.map((n) => (
                  <p className="plugin-path" key={n.network}>
                    {n.branch === "HEAD" ? "Default GitHub branch" : n.branch} ·{" "}
                    {n.status}
                    {n.commit && (
                      <>
                        {" "}
                        · <code>{n.commit}</code>
                      </>
                    )}
                    {n.indexedAt && (
                      <> · {new Date(n.indexedAt).toLocaleString()}</>
                    )}
                    {n.error && <> · {n.error}</>}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
function RepositoryEditor({
  initial,
  workspaceId,
  existingUrls,
  busy,
  close,
  save,
}: {
  initial?: CodeRepository;
  workspaceId: string;
  existingUrls: string[];
  busy: boolean;
  close: () => void;
  save: (repository: CodeRepository) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CodeRepository>(() =>
    initial
      ? { ...initial }
      : {
          id: `repo-${crypto.randomUUID()}`,
          repositoryUrl: "",
          description: "",
          workspaces: [workspaceId],
        },
  );
  const [error, setError] = useState("");
  return (
    <Modal
      title={
        initial
          ? `Edit repository ${repositoryName(initial.repositoryUrl)}`
          : "Add repository"
      }
      onClose={close}
      busy={busy}
    >
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError("");
          const parsed = codeRepositorySchema.safeParse(draft);
          if (!parsed.success) {
            setError(
              "Enter an HTTPS GitHub repository URL and a description of up to 2,000 characters.",
            );
            return;
          }
          if (
            existingUrls.some(
              (url) =>
                repositoryName(url).toLowerCase() ===
                repositoryName(draft.repositoryUrl).toLowerCase(),
            )
          ) {
            setError("This repository is already configured.");
            return;
          }
          try {
            await save(parsed.data);
          } catch (error) {
            setError(explain(error));
          }
        }}
      >
        <label className="field">
          <span>GitHub repository URL</span>
          <input
            type="url"
            required
            disabled={busy}
            value={draft.repositoryUrl}
            placeholder="https://github.com/your-org/my-repository.git"
            onChange={(e) =>
              setDraft({ ...draft, repositoryUrl: e.target.value })
            }
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            rows={4}
            maxLength={2000}
            disabled={busy}
            value={draft.description ?? ""}
            placeholder="Describe what this repository contains and when to use it."
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
          <small className="muted">Optional · up to 2,000 characters.</small>
        </label>
        <ModalActions>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Confirm"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
