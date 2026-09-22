import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { PluginPage, PluginSpec } from "../src/agent/plugin-config.ts";
import { CodeTruth } from "./code-truth.tsx";
import { Coding } from "./coding.tsx";
import { GitHubConnection } from "./github.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
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
}: {
  request: Request;
  workspaceId: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins`;
  const [data, setData] = useState<PluginPage>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [search, setSearch] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<PluginPage>(endpoint));
      setEditing(undefined);
    } catch (cause) {
      setData(undefined);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [request, endpoint]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (entries: PluginSpec[]) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setData(
        await request<PluginPage>(endpoint, "PUT", {
          revision: data.revision,
          entries,
        }),
      );
      setEditing(undefined);
      setNotice(
        "Plugins saved. New runs use these settings; runs with older settings stop before their next step.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const selected = data?.entries.find((entry) => entry.id === editing);
  const filtered = data?.entries.filter((entry) =>
    `${entry.id} ${entry.tools.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">DEEPX / WORKSPACE</p>
        <h1>Plugins</h1>
        <p className="muted">
          Pi extensions add tools and hooks to your assistant. Manage their
          settings for the selected workspace.
        </p>
      </header>
      <GitHubConnection request={request} workspaceId={workspaceId} />
      <CodeTruth request={request} workspaceId={workspaceId} />
      <Coding request={request} workspaceId={workspaceId} />
      <section className="card" aria-label="Plugin management">
        <div className="row plugin-toolbar">
          <h2>Registered plugins</h2>
          <IconButton
            icon="add"
            label="Add plugin"
            type="button"
            disabled={!data || loading || busy}
            onClick={() => {
              setEditing("__new");
              setError("");
              setNotice("");
            }}
          />
          {error && editing === undefined && (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              Reload saved plugins
            </button>
          )}
        </div>
        <p className="muted">
          Register reviewed files already installed on the server. Only
          deployment operators can change these settings.
        </p>
        {data && (
          <p className="muted">
            {data.source === "panel"
              ? `Saved revision ${data.revision}`
              : data.source === "manifest"
                ? "Using this workspace’s manifest grants. Your first save stores independent settings for this workspace."
                : "No plugins configured yet."}{" "}
            · Changes apply without a worker restart.
          </p>
        )}
        {loading && <p role="status">Loading plugins…</p>}
        {error && editing === undefined && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {data?.notice && (
          <p className="notice" role="status">
            {data.notice}
          </p>
        )}
        {!!data?.entries.length && (
          <label className="field">
            <span>Search plugins or tools</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
        {data?.entries.length === 0 && (
          <div className="plugin-empty">
            <h3>Add your first Pi extension</h3>
            <p>
              Install the extension file on the server, then add its path,
              declared tools here.
            </p>
            <p className="muted">
              Markdown instruction skills are managed separately on the Skills
              page.
            </p>
          </div>
        )}
        {!!data?.entries.length && filtered?.length === 0 && (
          <p>No plugins match your search.</p>
        )}
        {data &&
          filtered?.map((entry) => (
            <article
              className="plugin-item"
              key={entry.id}
              aria-label={`Plugin ${entry.id}`}
            >
              <div className="row">
                <h3>{entry.id}</h3>
                <span className={`pill${entry.enabled ? " good" : ""}`}>
                  {entry.enabled ? "Enabled" : "Disabled"}
                </span>
                <span className="muted">Version {entry.version}</span>
              </div>
              <p className="mono plugin-path">{entry.path}</p>
              <p
                className={
                  entry.fileStatus === "changed" ||
                  entry.fileStatus === "unavailable"
                    ? "notice"
                    : "muted"
                }
              >
                {fileLabels[entry.fileStatus]}
              </p>
              <p>
                <strong>Tools:</strong>{" "}
                {entry.tools.length ? entry.tools.join(", ") : "Hooks only"}
              </p>
              <div className="row">
                <IconButton
                  icon="edit"
                  label={`Edit ${entry.id}`}
                  type="button"
                  disabled={busy || loading}
                  onClick={() => {
                    setEditing(entry.id);
                    setError("");
                    setNotice("");
                  }}
                />
                <IconButton
                  icon={entry.enabled ? "pause" : "play"}
                  label={`${entry.enabled ? "Disable" : "Enable"} ${entry.id}`}
                  type="button"
                  disabled={busy || loading}
                  onClick={() =>
                    void save(
                      data.entries.map((item) => ({
                        ...spec(item),
                        enabled:
                          item.id === entry.id ? !item.enabled : item.enabled,
                      })),
                    )
                  }
                />
                <IconButton
                  icon="delete"
                  label={`Remove ${entry.id}`}
                  type="button"
                  className="danger"
                  disabled={busy || loading}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${entry.id} from the registry? The installed file stays on the server. Active runs using the previous settings will stop.`,
                      )
                    )
                      void save(
                        data.entries
                          .filter((item) => item.id !== entry.id)
                          .map(spec),
                      );
                  }}
                />
              </div>
            </article>
          ))}
      </section>
      {data && editing !== undefined && (
        <Modal
          title={selected ? `Edit ${selected.id}` : "Register a Pi extension"}
          busy={busy}
          onClose={() => {
            setEditing(undefined);
            setError("");
          }}
          cancelLabel="Cancel editing"
        >
          {error && (
            <p className="notice" role="alert">
              {error}
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                Reload saved plugins
              </button>
            </p>
          )}
          <PluginEditor
            key={`${editing}:${data.revision}`}
            initial={selected ? spec(selected) : undefined}
            workspaceId={workspaceId}
            busy={busy}
            submit={(entry) =>
              void save(
                selected
                  ? data.entries.map((item) =>
                      item.id === selected.id ? entry : spec(item),
                    )
                  : [...data.entries.map(spec), entry],
              )
            }
          />
        </Modal>
      )}
      <section className="card" aria-label="Pi extension compatibility">
        <h2>Pi extension compatibility</h2>
        <p>
          Plugins use Pi’s extension format. The headless worker supports
          registered tools, prompt and context hooks, tool-call vetoes, and
          lifecycle notifications. Terminal UI, commands and provider changes
          are unavailable.
        </p>
        <p className="muted">
          File verification checks readability and content only; it does not
          execute the plugin or prove runtime compatibility. Runtime failures
          appear in Runs and Runtime logs.
        </p>
        <p className="muted">
          Install only reviewed, read-only extensions. They run with worker
          permissions. Uploads and package installation are not available here.
        </p>
      </section>
      {!!data?.audit.length && (
        <details>
          <summary>Recent plugin changes</summary>
          <ul>
            {data.audit.map((entry) => (
              <li key={entry.id}>
                Plugins updated · {new Date(entry.at).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
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
