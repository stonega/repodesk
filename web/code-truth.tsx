import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router";
import type {
  CodeRepository,
  CodeTruthPage,
  CodeTruthSettings,
  CodeTruthStatus,
} from "../src/code-truth/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
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
        code_truth_disabled: "Enable Code Truth and save before indexing.",
        code_truth_no_repositories:
          "Grant a saved repository to this workspace first.",
        invalid_request:
          "Check repository IDs, HTTPS GitHub URLs, branch names and unique network names.",
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
  const [settings, setSettings] = useState<CodeTruthSettings>({
    enabled: false,
    repositories: [],
  });
  const [error, setError] = useState("");
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editingRepository, setEditingRepository] = useState<number | "new">();
  const [status, setStatus] = useState<CodeTruthStatus>();
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const page = await request<CodeTruthPage>(endpoint);
      setData(page);
      setSettings(page.settings);
      setDirty(false);
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
  const change = (value: CodeTruthSettings) => {
    setSettings(value);
    setDirty(true);
    setStatus(undefined);
  };
  const update = (index: number, repo: CodeRepository) =>
    change({
      ...settings,
      repositories: settings.repositories.map((r, i) =>
        i === index ? repo : r,
      ),
    });
  const save = async (value: CodeTruthSettings, preserveDraft = false) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await request<CodeTruthPage>(endpoint, "PUT", {
        revision: data.revision,
        settings: value,
      });
      setData(page);
      if (preserveDraft) {
        setSettings((draft) => ({ ...draft, enabled: page.settings.enabled }));
      } else {
        setSettings(page.settings);
        setDirty(false);
      }
      setStatus(undefined);
      notify(
        "Code Truth saved. These settings apply to new runs in this workspace.",
      );
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
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
              if (data) void save({ ...data.settings, enabled }, true);
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
          <button type="button" disabled={busy} onClick={() => void load()}>
            Reload Code Truth
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(settings);
          }}
        >
          <fieldset disabled={busy || !data} className="code-truth-fields">
            <div className="plugin-card-heading">
              <div>
                <h2>Repositories</h2>
                <p className="muted">
                  Map each repository's networks to branches.
                </p>
              </div>
              <IconButton
                icon="add"
                label="Add repository"
                showLabel
                disabled={settings.repositories.length >= 12}
                onClick={() => setEditingRepository("new")}
              />
            </div>
            <p className="muted">
              Add HTTPS GitHub repositories for this workspace and map each
              network to a branch. Use Manage GitHub on{" "}
              <NavLink to={`/admin/overview?workspace=${workspaceId}`}>
                Overview
              </NavLink>{" "}
              to access private repositories through your GitHub App.
            </p>
            {!data && !error && (
              <SkeletonRows label="Code Truth repositories" rows={2} />
            )}
            {data && settings.repositories.length === 0 && (
              <p>No repositories configured.</p>
            )}
            {settings.repositories.map((repo, index) => (
              <section
                className="plugin-item"
                key={repo.id}
                aria-label={`Repository ${index + 1}`}
              >
                <div className="row">
                  <h3>{repo.id}</h3>
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
                      change({
                        ...settings,
                        repositories: settings.repositories.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  />
                </div>
                <p className="mono">{repo.repositoryUrl}</p>
                <ul>
                  {Object.entries(repo.networks).map(([network, branch]) => (
                    <li key={network}>
                      {network} → {branch}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <div className="row">
              <button type="submit" disabled={!dirty}>
                Save Code Truth
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      {editingRepository !== undefined && (
        <RepositoryEditor
          initial={
            editingRepository === "new"
              ? undefined
              : settings.repositories[editingRepository]
          }
          workspaceId={workspaceId}
          existingIds={settings.repositories
            .filter((_, i) => i !== editingRepository)
            .map((r) => r.id)}
          close={() => setEditingRepository(undefined)}
          apply={(repo) => {
            if (editingRepository === "new")
              change({
                ...settings,
                repositories: [...settings.repositories, repo],
              });
            else update(editingRepository, repo);
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
          Save first, then sync and check this workspace. Indexing runs locally
          and can take several minutes. Active configurations refresh on use at
          most every five minutes.
        </p>
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={busy || dirty || !workspaceId || !data?.settings.enabled}
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
                <h3>{t.target}</h3>
                {t.networks.map((n) => (
                  <p className="plugin-path" key={n.network}>
                    {n.network} → {n.branch} · {n.status}
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
  existingIds,
  close,
  apply,
}: {
  initial?: CodeRepository;
  workspaceId: string;
  existingIds: string[];
  close: () => void;
  apply: (repository: CodeRepository) => void;
}) {
  const [draft, setDraft] = useState<CodeRepository>(() =>
    initial
      ? { ...initial, networks: { ...initial.networks } }
      : {
          id: "",
          repositoryUrl: "",
          networks: { devnet: "" },
          workspaces: [workspaceId],
        },
  );
  const [error, setError] = useState("");
  return (
    <Modal
      title={initial ? `Edit repository ${initial.id}` : "Add repository"}
      onClose={close}
    >
      <p className="muted">
        Apply this repository to your draft, then choose Save Code Truth to save
        the workspace configuration.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (existingIds.includes(draft.id)) {
            setError("A repository with this ID already exists.");
            return;
          }
          apply(draft);
        }}
      >
        <label className="field">
          <span>Repository ID</span>
          <input
            required
            pattern="[a-z0-9][a-z0-9_-]{0,63}"
            value={draft.id}
            placeholder="my-repository"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </label>
        <label className="field">
          <span>GitHub repository URL</span>
          <input
            type="url"
            required
            value={draft.repositoryUrl}
            placeholder="https://github.com/your-org/my-repository.git"
            onChange={(e) =>
              setDraft({ ...draft, repositoryUrl: e.target.value })
            }
          />
        </label>
        <NetworkFields
          value={draft.networks}
          change={(networks) => setDraft({ ...draft, networks })}
        />
        <ModalActions>
          <button type="submit">Apply repository</button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function NetworkFields({
  value,
  change,
}: {
  value: Record<string, string>;
  change: (value: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);
  const [adding, setAdding] = useState(false);
  return (
    <fieldset className="plugin-workspaces">
      <legend>Networks and branches</legend>
      {entries.map(([network, branch], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Controlled fields; network names are editable.
        <div className="row" key={index}>
          <label className="field">
            <span>Network {index + 1}</span>
            <input
              required
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              value={network}
              onChange={(e) => {
                // Keep duplicate names invalid while editing rather than overwriting a branch.
                if (
                  !entries.some(
                    ([name], i) => i !== index && name === e.target.value,
                  )
                )
                  change(
                    Object.fromEntries(
                      entries.map(([key, v], i) => [
                        i === index ? e.target.value : key,
                        v,
                      ]),
                    ),
                  );
              }}
            />
          </label>
          <label className="field">
            <span>Branch {index + 1}</span>
            <input
              required
              value={branch}
              placeholder="devnet-develop"
              onChange={(e) => change({ ...value, [network]: e.target.value })}
            />
          </label>
          <IconButton
            icon="delete"
            label={`Remove network ${index + 1}`}
            className="danger"
            type="button"
            disabled={entries.length === 1}
            onClick={() =>
              change(Object.fromEntries(entries.filter((_, i) => i !== index)))
            }
          />
        </div>
      ))}
      <IconButton
        icon="add"
        label="Add network"
        disabled={entries.length >= 8}
        onClick={() => setAdding(true)}
      />
      {adding && (
        <NetworkEditor
          existingNames={Object.keys(value)}
          close={() => setAdding(false)}
          apply={(network, branch) => {
            change({ ...value, [network]: branch });
            setAdding(false);
          }}
        />
      )}
    </fieldset>
  );
}

function NetworkEditor({
  existingNames,
  close,
  apply,
}: {
  existingNames: string[];
  close: () => void;
  apply: (network: string, branch: string) => void;
}) {
  const [network, setNetwork] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title="Add network" onClose={close}>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (existingNames.includes(network)) {
            setError("This network already exists.");
            return;
          }
          apply(network, branch);
        }}
      >
        <label className="field">
          <span>Network name</span>
          <input
            required
            pattern="[a-z0-9][a-z0-9_-]{0,63}"
            value={network}
            placeholder="testnet"
            onChange={(e) => setNetwork(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Branch name</span>
          <input
            required
            value={branch}
            placeholder="testnet-develop"
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <ModalActions>
          <button type="submit" aria-label="Add network">
            New
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
