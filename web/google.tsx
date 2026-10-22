import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { GooglePage } from "../src/google/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { PropertyEditor } from "./search-console.tsx";
import { ServiceUrl } from "./service-url.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function message(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    version_conflict:
      "These plugins changed in another session. Close the dialog and retry loading saved settings before editing again.",
    search_console_property_denied:
      "A selected property is no longer available. Check the connected Google account’s Search Console permissions.",
    google_scope_required:
      "Reconnect and grant all five Google read permissions.",
    google_not_connected:
      "Connect your Google account before enabling this plugin.",
    google_client_required:
      "Save a Google Web application client ID and secret first.",
    google_client_secret_required: "Enter a client secret for this client ID.",
    google_reconnect_required:
      "Reconnect your Google account to restore access.",
    google_credentials_unavailable:
      "Google integrations are unavailable on this server. Check the deployment configuration.",
    google_https_required:
      "Google sign-in needs an HTTPS admin address. Localhost is supported for development.",
    access_denied:
      "Only this workspace’s deployment operator can manage this connection.",
    extension_tool_collision:
      "An enabled file plugin uses this Google tool name. Resolve the conflict before enabling.",
    invalid_request: "Check the Google client ID and client secret.",
  };
  if (code.startsWith("version_conflict"))
    return (
      messages.version_conflict ?? "Plugins changed. Reload saved settings."
    );
  return (
    messages[code] ??
    "Could not complete the Google connection request. Try again."
  );
}
const statuses: Record<GooglePage["status"], string> = {
  not_connected: "Not connected",
  connected: "Connected",
  refreshing: "Refreshing connection",
  reconnect_required: "Reconnect required",
};
export function Google({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const def = {
    name: "Google",
    summary:
      "Read Docs and Sheets, find Drive files, search Gmail and query selected Search Console properties.",
  };
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/google`;
  const [data, setData] = useState<GooglePage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const pendingAction = useRef(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<"connection" | "properties">();
  const [params, setParams] = useSearchParams();
  const notify = useToast();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<GooglePage>(endpoint));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const result = params.get("google");
    if (!result) return;
    if (result === "connected")
      notify(`${def.name} connected. Enable the plugin when you’re ready.`);
    else if (result === "failed")
      setError(
        "Google sign-in did not complete. Check the enabled API, consent scopes, test users and exact callback URL, then try connecting again.",
      );
    const next = new URLSearchParams(params);
    next.delete("google");
    setParams(next, { replace: true });
  }, [params, setParams, notify, def.name]);
  async function action<T>(work: () => Promise<T>): Promise<T> {
    if (pendingAction.current) throw new Error("pending");
    pendingAction.current = true;
    setBusy(true);
    setError("");
    try {
      return await work();
    } catch (cause) {
      setError(message(cause));
      throw cause;
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  }
  async function save(
    clientId?: string,
    clientSecret?: string,
    enabled = data?.settings.enabled ?? false,
  ) {
    if (!data) return;
    await action(async () => {
      const result = await request<GooglePage>(endpoint, "PUT", {
        revision: data.revision,
        settings: { enabled },
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
      setData(result);
      setError("");
      setEditing(undefined);
      notify(`${def.name} settings saved.`);
    });
  }
  const pending = error ? "—" : <Skeleton width="10rem" />;
  return (
    <section className="plugin-detail" aria-label={`${def.name} plugin`}>
      <PluginDetailHeading title={def.name} backTo={backTo}>
        <PluginToggle
          name={def.name}
          enabled={data?.settings.enabled}
          loading={loading && !data}
          disabled={busy || loading || !data}
          onChange={(enabled) => {
            if (enabled && data?.status !== "connected") {
              setEditing("connection");
              return;
            }
            void save(undefined, undefined, enabled).catch((cause) =>
              setError(message(cause)),
            );
          }}
        />
      </PluginDetailHeading>
      {error && !editing && (
        <ErrorToast message={error}>
          <button
            type="button"
            disabled={busy || loading}
            aria-label={`Reload ${def.name} settings`}
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card google-summary-card"
        aria-label={`${def.name} connection`}
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Connection</h2>
            <p className="muted">Google account for this workspace</p>
          </div>
          <IconButton
            icon="edit"
            label={`Edit ${def.name} connection`}
            showLabel
            disabled={!data || loading || busy}
            onClick={() => setEditing("connection")}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Status</dt>
            <dd>
              {data
                ? data.legacy
                  ? "Separate connections"
                  : statuses[data.status]
                : pending}
            </dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{data ? (data.account ?? "No account connected") : pending}</dd>
          </div>
          <div>
            <dt>Client ID</dt>
            <dd>{data ? data.clientId || "Not configured" : pending}</dd>
          </div>
          <div>
            <dt>Client secret</dt>
            <dd>
              {data
                ? data.clientSecretConfigured
                  ? "Configured"
                  : "Not configured"
                : pending}
            </dd>
          </div>
        </dl>
        {data?.status === "not_connected" && (
          <p className="muted">
            Open Edit to save a Google OAuth client, then connect an account.
            One connection is shared by Docs, Sheets, Drive, Gmail and Search
            Console.
          </p>
        )}
        {data?.legacy && (
          <p className="notice">
            {data.clientSecretConfigured
              ? "Your existing Web application client can be reused."
              : "Use a Web application to connect all Google services."}{" "}
            Open Edit, save once, then reconnect for the combined permissions.
            This replaces the separate connections. Existing access remains
            active until you save or disable Google.
          </p>
        )}
        {data?.status === "reconnect_required" && (
          <p className="notice">
            Open Edit and reconnect your Google account to restore access.
          </p>
        )}
      </section>
      <section
        className="card google-summary-card"
        aria-label={`${def.name} capabilities`}
      >
        <h2>Access</h2>
        <p>
          {def.summary} Read-only access is available to workspace owners and
          admins in private conversations.
        </p>
        <p className="muted">
          Use Drive to discover document and spreadsheet IDs. Gmail reads plain
          text, headers and snippets; attachments are not downloaded. Search
          Console reads only the properties you select below.
        </p>
        <p className="muted">
          Editing, sharing, deleting and sending are unavailable.{" "}
          <a
            href="https://myaccount.google.com/connections"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage Google authorizations ↗
          </a>
        </p>
      </section>
      <section
        className="card google-summary-card"
        aria-label="Search Console properties"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Search Console properties</h2>
            <p className="muted">
              Choose which properties the assistant can read
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Search Console properties"
            showLabel
            disabled={data?.status !== "connected" || loading || busy}
            onClick={() => setEditing("properties")}
          />
        </div>
        {data ? (
          data.siteUrls?.length ? (
            <ul className="resource-list">
              {data.siteUrls.map((site) => (
                <li key={site}>{site}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No properties selected. Connect Google, then open Edit to choose
              properties.
            </p>
          )
        ) : (
          <div>{pending}</div>
        )}
      </section>
      {editing === "properties" && data && (
        <PropertyEditor
          data={{
            revision: data.revision,
            settings: {
              enabled: data.settings.enabled,
              siteUrls: data.siteUrls ?? [],
            },
            credentialConfigured: data.status === "connected",
          }}
          request={request}
          endpoint={`/api/admin/workspaces/${workspaceId}/plugins/search-console`}
          busy={busy}
          close={() => setEditing(undefined)}
          save={(settings) =>
            action(async () => {
              await request(
                `/api/admin/workspaces/${workspaceId}/plugins/search-console`,
                "PUT",
                { revision: data.revision, settings },
              );
              await load();
              setEditing(undefined);
              notify("Search Console properties saved.");
            })
          }
        />
      )}
      {editing === "connection" && data && (
        <GoogleEditor
          key={data.revision}
          data={data}
          name={def.name}
          busy={busy}
          close={() => setEditing(undefined)}
          save={save}
          connect={() =>
            action(async () => {
              const result = await request<{ url: string }>(
                `${endpoint}/connect`,
                "POST",
                { revision: data.revision },
              );
              const url = new URL(result.url);
              if (url.origin !== "https://accounts.google.com")
                throw new Error("invalid_redirect");
              window.location.assign(url.toString());
            })
          }
          disconnect={() =>
            action(async () => {
              setData(
                await request<GooglePage>(`${endpoint}/disconnect`, "POST", {
                  revision: data.revision,
                }),
              );
              notify(`${def.name} disconnected from this workspace.`);
            })
          }
        />
      )}
    </section>
  );
}
function GoogleEditor({
  data,
  name,
  busy,
  close,
  save,
  connect,
  disconnect,
}: {
  data: GooglePage;
  name: string;
  busy: boolean;
  close: () => void;
  save: (clientId?: string, clientSecret?: string) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [operation, setOperation] = useState("");
  const dirty = clientId.trim() !== data.clientId || !!secret;
  async function run(label: string, work: () => Promise<void>) {
    if (busy) return;
    setOperation(label);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setOperation("");
    }
  }
  return (
    <Modal title={`Edit ${name} connection`} busy={busy} onClose={close}>
      <p>
        Use your registered Web application OAuth client in{" "}
        <a
          href="https://console.cloud.google.com/auth/clients"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Cloud ↗
        </a>
        . Enable the Docs, Sheets, Drive, Gmail and Search Console APIs,
        configure consent and test users, and add this exact callback URL.
      </p>
      <dl className="plugin-summary google-connection-details">
        <ServiceUrl label="Callback URL" value={data.redirectUri} />
        {data.scope.split(" ").map((scope) => (
          <ServiceUrl key={scope} label="Read scope" value={scope} />
        ))}
      </dl>
      <p className="muted">
        Sign-in also requests your email to identify the account. All five
        services use this client and Google account.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("Saving…", () =>
            save(clientId.trim(), secret.trim() || undefined),
          );
        }}
      >
        <label className="field">
          <span>Client ID</span>
          <input
            required
            maxLength={256}
            pattern="[A-Za-z0-9_\-]+\.apps\.googleusercontent\.com"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label className="field">
          <span>
            {data.clientSecretConfigured
              ? "Replace client secret"
              : "Client secret"}
          </span>
          <input
            type="password"
            aria-label={
              data.clientSecretConfigured
                ? "Replace client secret"
                : "Client secret"
            }
            aria-describedby="google-client-secret-help"
            autoComplete="new-password"
            required={
              !data.clientSecretConfigured || clientId.trim() !== data.clientId
            }
            maxLength={4096}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
          <small className="muted" id="google-client-secret-help">
            Leave blank to keep the saved secret for the same client ID.
            Replacing credentials disconnects and disables this plugin.
          </small>
        </label>
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={
              busy || dirty || !data.clientSecretConfigured || data.legacy
            }
            onClick={() => void run("Opening Google sign-in…", connect)}
          >
            {data.status === "not_connected"
              ? "Connect Google account"
              : "Reconnect Google account"}
          </button>
          {data.account && (
            <button
              type="button"
              className="secondary"
              disabled={busy || dirty}
              onClick={() => void run("Disconnecting…", disconnect)}
            >
              Disconnect
            </button>
          )}
        </div>
        {(dirty || data.legacy) && (
          <p className="muted">Save your client settings before connecting.</p>
        )}
        <p className="muted">
          Disconnect removes the shared local tokens and disables access to all
          five services. Revoke authorization in your Google account to remove
          provider access.
        </p>
        {busy && <p role="status">{operation || "Saving…"}</p>}
        <ModalActions>
          <button type="submit" disabled={busy}>
            {operation === "Saving…" ? "Saving…" : "Save"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
