import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserPluginPage } from "../src/browser/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function BrowserPlugin({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/browser`;
  const [data, setData] = useState<BrowserPluginPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [previews, setPreviews] = useState("");
  const lock = useRef(false),
    sequence = useRef(0),
    notify = useToast();
  const load = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const next = await request<BrowserPluginPage>(endpoint);
      if (own === sequence.current) {
        setData(next);
        setError("");
      }
    } catch {
      if (own === sequence.current)
        setError(
          "Could not load Browser settings. Retry when your connection is available.",
        );
    }
  }, [request, endpoint]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  async function save(
    enabled: boolean,
    previewOrigins = data?.settings.previewOrigins ?? [],
  ) {
    if (!data || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    sequence.current++;
    try {
      setData(
        await request<BrowserPluginPage>(endpoint, "PUT", {
          revision: data.revision,
          settings: { enabled, previewOrigins },
        }),
      );
      setEditing(false);
      notify("Browser settings saved.");
    } catch (cause) {
      const code = (cause as Error).message;
      setError(
        code.includes("version_conflict")
          ? "These settings changed in another session. Reload and review your changes."
          : code.includes("extension_tool_collision")
            ? "A file plugin already uses a Browser tool name. Rename its tools before enabling Browser."
            : "Could not save. Use one complete loopback origin per line, including the port, and retry.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="browser-plugin">
      <PluginDetailHeading title="Browser" backTo={backTo}>
        <PluginToggle
          name="Browser"
          enabled={data?.settings.enabled}
          disabled={busy || !data}
          loading={!data && !error}
          onChange={(value) => void save(value)}
        />
      </PluginDetailHeading>
      {error && (
        <ErrorToast message={error}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Reload settings
          </button>
        </ErrorToast>
      )}
      <section
        className="card transcription-card"
        aria-label="Browser configuration"
        aria-busy={!data || busy}
      >
        <h2>Shared browser</h2>
        <p>
          Use your own persistent browser from chat and authorized plugins. Each
          workspace member has a separate login and private session.
        </p>
        <dl className="transcription-summary">
          <div>
            <dt>Plugin</dt>
            <dd>
              {data ? (
                data.settings.enabled ? (
                  "Enabled"
                ) : (
                  "Disabled"
                )
              ) : (
                <Skeleton width="6rem" />
              )}
            </dd>
          </div>
          <div>
            <dt>Browser mode</dt>
            <dd>Headed Chrome on the VPS</dd>
          </div>
          <div>
            <dt>Host service</dt>
            <dd>
              {data ? (
                data.serviceConfigured ? (
                  "Configured · checked when used"
                ) : (
                  "Not configured"
                )
              ) : (
                <Skeleton width="12rem" />
              )}
            </dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>Private to each member · task-bound input in Telegram</dd>
          </div>
        </dl>
        {data && !data.serviceConfigured && (
          <p className="muted">
            Connect the host browser service in deployment settings. Other
            conversations remain available.
          </p>
        )}
        <p className="muted">
          Ask the bot to open a website in a private conversation. Open Browser
          from its response to approve a site or action, enter a password or
          code, or take control. Browser sessions are available only to their
          owner.
        </p>
      </section>
      <section
        className="card transcription-card"
        aria-label="Local preview access"
      >
        <div className="plugin-card-heading">
          <h2>Local previews</h2>
          <IconButton
            icon="edit"
            label="Edit local previews"
            type="button"
            disabled={!data || busy}
            onClick={() => {
              setPreviews((data?.settings.previewOrigins ?? []).join("\n"));
              setEditing(true);
              setError("");
            }}
          />
        </div>
        <p>
          Allow specific local development servers. Members still approve access
          for each task.
        </p>
        {!data ? (
          <Skeleton width="14rem" />
        ) : data.settings.previewOrigins?.length ? (
          <ul>
            {data.settings.previewOrigins.map((value) => (
              <li key={value}>
                <code>{value}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No local previews allowed.</p>
        )}
      </section>
      {editing && data && (
        <Modal
          title="Edit local previews"
          busy={busy}
          onClose={() => setEditing(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(
                data.settings.enabled,
                previews
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              );
            }}
          >
            <label>
              Allowed origins
              <textarea
                value={previews}
                onChange={(event) => setPreviews(event.target.value)}
                disabled={busy}
                rows={5}
                placeholder="http://127.0.0.1:5173"
              />
            </label>
            <p className="muted">
              Up to eight loopback origins. Include the scheme and port, without
              a path. The development server must be reachable on the browser
              host.
            </p>
            <ModalActions>
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
    </section>
  );
}
