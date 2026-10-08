import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { PluginPage, PluginSpec } from "../src/agent/plugin-config.ts";
import type { CodeTruthPage } from "../src/code-truth/config.ts";
import type { CodingPage } from "../src/coding/config.ts";
import type { ReviewPage } from "../src/review-bot/config.ts";
import { CodeTruth } from "./code-truth.tsx";
import { Coding } from "./coding.tsx";
import { GitHubConnection } from "./github.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { ReviewBot } from "./review-bot.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type View = "catalog" | "installed" | "market";
type MarketEntry = {
  id: string;
  name: string;
  author: string;
  summary: string;
  description: string;
  url: string;
};

// Selected from Pi's package catalog, ordered by monthly downloads on 2026-09-29.
// These are discovery links, not RepoDesk compatibility or security endorsements.
const market: MarketEntry[] = [
  {
    id: "pi-mcp-adapter",
    name: "pi-mcp-adapter",
    author: "nicopreme",
    summary: "Connect Pi tools to MCP servers.",
    description: "An MCP adapter for the Pi coding agent.",
    url: "https://pi.dev/packages/pi-mcp-adapter",
  },
  {
    id: "pi-web-access",
    name: "pi-web-access",
    author: "nicopreme",
    summary: "Search and fetch web content.",
    description:
      "Web search and fetching tools for Pi, with additional source and media integrations.",
    url: "https://pi.dev/packages/pi-web-access",
  },
  {
    id: "pi-lens",
    name: "pi-lens",
    author: "apmantza",
    summary: "Get code feedback from development tools.",
    description:
      "Code feedback for Pi through language servers, linters, formatters, and type checking.",
    url: "https://pi.dev/packages/pi-lens",
  },
];

const spec = ({
  fileStatus: _status,
  ...entry
}: PluginPage["entries"][number]): PluginSpec => entry;
function errorMessage(cause: unknown) {
  const message = (cause as Error).message;
  if (message.includes("version_conflict"))
    return "Another operator session changed these plugins. Reload saved plugins and review your changes before saving again.";
  const messages: Record<string, string> = {
    extension_configuration_invalid:
      "Check the plugin IDs, tool names and local files. Enabled plugins must be readable by the API and worker at the same path.",
    extension_path_invalid:
      "Enter an absolute server path to a .ts, .js or .mjs file.",
    extension_tool_collision:
      "A granted tool name conflicts with an application tool or another enabled plugin in this workspace.",
    access_denied:
      "Only this workspace’s deployment operator can manage these plugins.",
    invalid_request: "Check the plugin ID, version and tool names.",
  };
  return messages[message] ?? message;
}
const fileLabels = {
  ready: "File verified",
  changed: "File changed — review and update version",
  unavailable: "File unavailable — check the server mount",
  unchecked: "File not checked while disabled",
};

export function Plugins({
  request,
  workspaceId,
  view = "catalog",
}: {
  request: Request;
  workspaceId: string;
  view?: View;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins`;
  const { pluginId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<PluginPage>();
  const [error, setError] = useState("");
  const notify = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [builtIns, setBuiltIns] = useState<{
    codeTruth?: boolean;
    codex?: boolean;
    reviewBot?: boolean;
  }>({});
  const path = (suffix = "") =>
    `/admin/plugins${suffix}?workspace=${encodeURIComponent(workspaceId)}`;
  const load = useCallback(
    async (resetDraft = false) => {
      setLoading(true);
      setError("");
      try {
        setData(await request<PluginPage>(endpoint));
        if (resetDraft) setEditing(undefined);
      } catch (cause) {
        setData(undefined);
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [request, endpoint],
  );
  useEffect(() => {
    if (
      view === "catalog" ||
      (view === "installed" &&
        pluginId !== "code-truth" &&
        pluginId !== "codex" &&
        pluginId !== "review-bot")
    )
      void load();
  }, [load, pluginId, view]);
  useEffect(() => {
    if (view !== "catalog") return;
    let active = true;
    void Promise.allSettled([
      request<CodeTruthPage>(`${endpoint}/code-truth`),
      request<CodingPage>(`${endpoint}/coding`),
      request<ReviewPage>(`${endpoint}/review-bot`),
    ]).then(([truth, coding, review]) => {
      if (!active) return;
      setBuiltIns({
        reviewBot:
          review.status === "fulfilled"
            ? review.value.settings?.enabled
            : undefined,
        codeTruth:
          truth.status === "fulfilled"
            ? truth.value.settings.enabled
            : undefined,
        codex:
          coding.status === "fulfilled"
            ? coding.value.settings.enabled
            : undefined,
      });
    });
    return () => {
      active = false;
    };
  }, [endpoint, request, view]);
  useEffect(() => {
    if (view !== "catalog" || params.get("add") !== "1") return;
    setEditing("__new");
    const next = new URLSearchParams(params);
    next.delete("add");
    setParams(next, { replace: true });
  }, [params, setParams, view]);
  const save = async (entries: PluginSpec[]) => {
    if (!data || busy) return false;
    setBusy(true);
    setError("");
    try {
      setData(
        await request<PluginPage>(endpoint, "PUT", {
          revision: data.revision,
          entries,
        }),
      );
      setEditing(undefined);
      notify(
        "Plugins saved. New runs use these settings; runs with older settings stop before their next step.",
      );
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const selected = data?.entries.find((entry) => entry.id === pluginId);
  const editorEntry = data?.entries.find((entry) => entry.id === editing);
  const marketEntry = market.find((entry) => entry.id === pluginId);
  const heading =
    view === "catalog"
      ? "Plugins"
      : view === "market"
        ? (marketEntry?.name ?? "Extension not found")
        : pluginId === "code-truth"
          ? "Code Truth"
          : pluginId === "codex"
            ? "Codex"
            : pluginId === "review-bot"
              ? "Review Bot"
              : (selected?.id ??
                (loading ? (pluginId ?? "Plugin") : "Plugin not found"));

  return (
    <>
      {view === "catalog" ? (
        <header className="page-heading">
          <p className="eyebrow">REPODESK / WORKSPACE</p>
          <h1>{heading}</h1>
          <p className="muted">
            Manage installed extensions and explore the Pi ecosystem.
          </p>
        </header>
      ) : (pluginId !== "code-truth" &&
          pluginId !== "codex" &&
          pluginId !== "review-bot") ||
        view === "market" ? (
        <PluginDetailHeading title={heading} backTo={path()}>
          {view === "installed" && selected && data && (
            <PluginToggle
              name={selected.id}
              enabled={selected.enabled}
              disabled={busy || loading}
              onChange={(enabled) =>
                void save(
                  data.entries.map((item) => ({
                    ...spec(item),
                    enabled: item.id === selected.id ? enabled : item.enabled,
                  })),
                )
              }
            />
          )}
        </PluginDetailHeading>
      ) : null}
      <GitHubConnection request={request} workspaceId={workspaceId} />
      {view === "catalog" && (
        <>
          <section
            className="plugin-catalog-section"
            aria-labelledby="installed-heading"
          >
            <div className="plugin-section-heading">
              <div>
                <h2 id="installed-heading">Installed</h2>
                <p className="muted">
                  Available in this deployment and registered for this
                  workspace.
                </p>
              </div>
              <IconButton
                icon="add"
                label="Add plugin"
                showLabel
                type="button"
                disabled={!data || loading || busy}
                onClick={() => {
                  setEditing("__new");
                  setError("");
                }}
              />
            </div>
            {error && editing === undefined && (
              <p className="notice" role="alert">
                {error}{" "}
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => void load(true)}
                >
                  Reload saved plugins
                </button>
              </p>
            )}
            {data?.notice && (
              <p className="notice" role="status">
                {data.notice}
              </p>
            )}
            <div className="plugin-catalog-grid">
              <PluginCard
                to={path("/code-truth")}
                name="Code Truth"
                summary="Ask questions about indexed source code."
                status={
                  builtIns.codeTruth === undefined
                    ? "Built in"
                    : builtIns.codeTruth
                      ? "Enabled"
                      : "Disabled"
                }
              />
              <PluginCard
                to={path("/codex")}
                name="Codex"
                summary="Isolated coding tasks and draft PRs."
                status={
                  builtIns.codex === undefined
                    ? "Built in"
                    : builtIns.codex
                      ? "Enabled"
                      : "Disabled"
                }
              />
              <PluginCard
                to={path("/review-bot")}
                name="Review Bot"
                summary="Automatic PR reviews and tagged fixes."
                status={
                  builtIns.reviewBot === undefined
                    ? "Built in"
                    : builtIns.reviewBot
                      ? "Enabled"
                      : "Disabled"
                }
              />
              {data?.entries.map((entry) => (
                <PluginCard
                  key={entry.id}
                  to={path(`/file/${encodeURIComponent(entry.id)}`)}
                  name={entry.id}
                  summary="Local Pi extension"
                  status={entry.enabled ? "Enabled" : "Disabled"}
                />
              ))}
            </div>
          </section>
          <section
            className="plugin-catalog-section"
            aria-labelledby="market-heading"
          >
            <div className="plugin-section-heading">
              <div>
                <h2 id="market-heading">Markets</h2>
                <p className="muted">
                  Popular extensions from Pi’s package catalog. Review each
                  package before using it here.
                </p>
              </div>
              <a
                href="https://pi.dev/packages?type=extension"
                target="_blank"
                rel="noopener noreferrer"
              >
                Browse Pi catalog ↗
              </a>
            </div>
            <div className="plugin-catalog-grid">
              {market.map((entry) => (
                <PluginCard
                  key={entry.id}
                  to={path(`/market/${entry.id}`)}
                  name={entry.name}
                  summary={entry.summary}
                  status="Pi package"
                />
              ))}
            </div>
            <p className="plugin-catalog-source muted">
              Selection based on the{" "}
              <a
                href="https://pi.dev/packages?type=extension"
                target="_blank"
                rel="noopener noreferrer"
              >
                Pi package catalog
              </a>
              , 29 September 2026. Catalog popularity does not establish
              RepoDesk compatibility.
            </p>
          </section>
        </>
      )}
      {view === "installed" && pluginId === "code-truth" && (
        <CodeTruth
          request={request}
          workspaceId={workspaceId}
          backTo={path()}
        />
      )}
      {view === "installed" && pluginId === "review-bot" && (
        <ReviewBot
          key={workspaceId}
          request={request}
          workspaceId={workspaceId}
          backTo={path()}
        />
      )}
      {view === "installed" && pluginId === "codex" && (
        <Coding request={request} workspaceId={workspaceId} backTo={path()} />
      )}
      {view === "installed" &&
        pluginId !== "code-truth" &&
        pluginId !== "codex" &&
        pluginId !== "review-bot" && (
          <>
            {!data && loading && !error && (
              <section className="card" aria-busy="true">
                <h2>Configuration</h2>
                <SkeletonRows label="Plugin configuration" />
              </section>
            )}
            {error && editing === undefined && (
              <p className="notice" role="alert">
                {error}{" "}
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => void load(true)}
                >
                  Reload saved plugins
                </button>
              </p>
            )}
            {data?.notice && (
              <p className="notice" role="status">
                {data.notice}
              </p>
            )}
            {!loading && data && !selected && (
              <section className="card">
                <p>This plugin is not registered in the selected workspace.</p>
                <Link to={path()}>Back to Plugins</Link>
              </section>
            )}
            {selected && data && (
              <>
                <section className="card" aria-label={`Plugin ${selected.id}`}>
                  <div className="plugin-card-heading">
                    <div>
                      <h2>Configuration</h2>
                      <p className="muted">Registered local Pi extension</p>
                    </div>
                    <IconButton
                      icon="edit"
                      label={`Edit ${selected.id}`}
                      showLabel
                      disabled={busy || loading}
                      onClick={() => {
                        setEditing(selected.id);
                        setError("");
                      }}
                    />
                  </div>
                  <dl className="plugin-summary">
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <span
                          className={`pill${selected.enabled ? " good" : ""}`}
                        >
                          {selected.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd>{selected.version}</dd>
                    </div>
                    <div>
                      <dt>Saved revision</dt>
                      <dd>{data.revision}</dd>
                    </div>

                    <div>
                      <dt>File</dt>
                      <dd className="mono">{selected.path}</dd>
                    </div>
                    <div>
                      <dt>File status</dt>
                      <dd>{fileLabels[selected.fileStatus]}</dd>
                    </div>
                    <div>
                      <dt>Tools</dt>
                      <dd>
                        {selected.tools.length
                          ? selected.tools.join(", ")
                          : "Hooks only"}
                      </dd>
                    </div>
                  </dl>
                  <div className="row">
                    <button
                      type="button"
                      className="danger"
                      disabled={busy || loading}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${selected.id} from the registry? The installed file stays on the server. Active runs using the previous settings will stop.`,
                          )
                        ) {
                          void save(
                            data.entries
                              .filter((item) => item.id !== selected.id)
                              .map(spec),
                          ).then((saved) => {
                            if (saved) navigate(path());
                          });
                        }
                      }}
                    >
                      Remove {selected.id}
                    </button>
                  </div>
                </section>
                <section
                  className="card"
                  aria-label="Pi extension compatibility"
                >
                  <h2>Runtime compatibility</h2>
                  <p>
                    RepoDesk’s headless worker supports registered tools and
                    selected lifecycle hooks. Terminal UI, commands and provider
                    changes are unavailable.
                  </p>
                  <p className="muted">
                    File verification checks readability and content only.
                    Runtime failures appear in Runs and Runtime logs. Install
                    only reviewed, read-only extensions.
                  </p>
                </section>
                {!!data.audit.length && (
                  <details>
                    <summary>Recent plugin changes</summary>
                    <ul>
                      {data.audit.map((entry) => (
                        <li key={entry.id}>
                          Plugins updated ·{" "}
                          {new Date(entry.at).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </>
        )}
      {view === "market" &&
        (marketEntry ? (
          <section className="card plugin-market-detail">
            <span className="pill">External Pi package</span>
            <p>{marketEntry.description}</p>
            <dl className="plugin-details">
              <div>
                <dt>Publisher</dt>
                <dd>{marketEntry.author}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>Pi package catalog</dd>
              </div>
              <div>
                <dt>RepoDesk status</dt>
                <dd>Not installed or compatibility checked</dd>
              </div>
            </dl>
            <div className="row">
              <a
                href={marketEntry.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View package on Pi ↗
              </a>
              <Link to={`${path()}&add=1`}>Register a reviewed local file</Link>
            </div>
            <p className="muted">
              RepoDesk does not install Pi packages from this page. To use a
              compatible extension, review its code, install its entry file on
              the API and worker, then register the local file in this
              workspace. The worker supports only RepoDesk’s documented headless
              extension subset.
            </p>
          </section>
        ) : (
          <section className="card">
            <p>This market entry is unavailable.</p>
            <Link to={path()}>Back to Plugins</Link>
          </section>
        ))}
      {data && editing !== undefined && (
        <Modal
          title={
            editorEntry ? `Edit ${editorEntry.id}` : "Register a Pi extension"
          }
          busy={busy}
          onClose={() => {
            setEditing(undefined);
            setError("");
          }}
          cancelLabel="Cancel editing"
        >
          {error && (
            <p className="notice" role="alert">
              {error}{" "}
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void load(true)}
              >
                Reload saved plugins
              </button>
            </p>
          )}
          <PluginEditor
            key={`${editing}:${data.revision}`}
            initial={editorEntry ? spec(editorEntry) : undefined}
            workspaceId={workspaceId}
            busy={busy}
            submit={(entry) =>
              void save(
                editorEntry
                  ? data.entries.map((item) =>
                      item.id === editorEntry.id ? entry : spec(item),
                    )
                  : [...data.entries.map(spec), entry],
              )
            }
          />
        </Modal>
      )}
    </>
  );
}

function PluginCard({
  to,
  name,
  summary,
  status,
}: {
  to: string;
  name: string;
  summary: string;
  status: string;
}) {
  return (
    <Link className="plugin-catalog-card" to={to} aria-label={`Open ${name}`}>
      <div className="plugin-card-top">
        <span className="plugin-card-icon" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className={`pill${status === "Enabled" ? " good" : ""}`}>
          {status}
        </span>
      </div>
      <h3>{name}</h3>
      <p>{summary}</p>
      <span className="plugin-card-arrow" aria-hidden="true">
        →
      </span>
    </Link>
  );
}

function PluginEditor({
  initial,
  workspaceId,
  busy,
  submit,
}: {
  initial?: PluginSpec;
  workspaceId: string;
  busy: boolean;
  submit: (entry: PluginSpec) => void;
}) {
  const [draft, setDraft] = useState<PluginSpec>(
    initial ?? {
      id: "",
      version: "1",
      path: "",
      tools: [],
      workspaces: [workspaceId],
      execution: "read-only",
      enabled: false,
    },
  );
  const [tools, setTools] = useState(initial?.tools.join(", ") ?? "");
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit({ ...draft, tools: tools.split(/[\s,]+/).filter(Boolean) });
  };
  return (
    <form onSubmit={onSubmit}>
      <fieldset disabled={busy} className="plugin-fields">
        <div className="columns">
          <label className="field">
            <span>Plugin ID</span>
            <input
              required
              pattern="[a-z][a-z0-9-]{1,63}"
              maxLength={64}
              value={draft.id}
              readOnly={!!initial}
              onChange={(event) =>
                setDraft({ ...draft, id: event.target.value })
              }
              placeholder="word-count"
            />
          </label>
          <label className="field">
            <span>Plugin version</span>
            <input
              required
              maxLength={100}
              value={draft.version}
              onChange={(event) =>
                setDraft({ ...draft, version: event.target.value })
              }
            />
          </label>
        </div>
        <label className="field">
          <span>Installed file path</span>
          <input
            required
            maxLength={2048}
            value={draft.path}
            onChange={(event) =>
              setDraft({ ...draft, path: event.target.value })
            }
            placeholder="/app/extensions/word-count.ts"
          />
        </label>
        <p className="muted">
          Use the same absolute file path in the API and worker. Update the
          version when the extension or its dependencies change.
        </p>
        <label className="field">
          <span>Tool names</span>
          <textarea
            rows={2}
            value={tools}
            onChange={(event) => setTools(event.target.value)}
            placeholder="count_words, another_tool"
          />
        </label>
        <p className="muted">
          List the exact names the extension registers, separated by commas.
          Leave empty for hooks-only extensions.
        </p>
        {!initial && (
          <label className="plugin-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            <span>Enable this plugin</span>
          </label>
        )}
        <p className="muted">
          Saving an enabled plugin grants its tools and hooks to eligible users
          in this workspace.
        </p>
        <ModalActions>
          <button type="submit">{busy ? "Saving…" : "Save plugin"}</button>
        </ModalActions>
      </fieldset>
    </form>
  );
}
