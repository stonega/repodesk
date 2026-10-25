import { useCallback, useEffect, useRef, useState } from "react";
import type { GooglePage } from "../src/google/config.ts";
import { GoogleApiGuide } from "./google-api-guide.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { ServiceUrl } from "./service-url.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function message(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    version_conflict:
      "These plugins changed in another session. Close the dialog and retry loading saved settings before editing again.",
    google_client_required:
      "Save a Google Web application client ID and secret first.",
    google_client_secret_required: "Enter a client secret for this client ID.",
    google_credentials_unavailable:
      "Google integrations are unavailable on this server. Check the deployment configuration.",
    google_https_required:
      "Google sign-in needs an HTTPS admin address. Localhost is supported for development.",
    access_denied:
      "Only this workspace’s deployment operator can manage this application.",
    extension_tool_collision:
      "An enabled file plugin uses this Google tool name. Resolve the conflict before enabling.",
    invalid_request: "Check the Google client ID and client secret.",
  };
  if (code.startsWith("version_conflict"))
    return (
      messages.version_conflict ?? "Plugins changed. Reload saved settings."
    );
  return messages[code] ?? "Could not save Google settings. Try again.";
}
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
  const [editing, setEditing] = useState(false);
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
      setEditing(false);
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
            if (
              enabled &&
              (!data?.clientId || !data.clientSecretConfigured || data.legacy)
            ) {
              setEditing(true);
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
        aria-label={`${def.name} application`}
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Web application</h2>
            <p className="muted">Shared OAuth client for this workspace</p>
          </div>
          <IconButton
            icon="edit"
            label={`Edit ${def.name} application`}
            showLabel
            disabled={!data || loading || busy}
            onClick={() => setEditing(true)}
          />
        </div>
        <dl className="plugin-summary">
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
        <p className="muted">
          Configure the Web application here, then enable Google. Each member
          connects their own account with <code>/google</code> in the bot’s
          private chat.
        </p>
        {data?.legacy && (
          <p className="notice">
            Your existing Web application client can be reused. Open Edit and
            save it once. Members must connect their own accounts in Telegram.
          </p>
        )}
      </section>
      <GoogleApiGuide />
      <section
        className="card google-summary-card"
        aria-label={`${def.name} capabilities`}
      >
        <h2>Access</h2>
        <p>
          {def.summary} Each active member can read only their own connected
          account in private conversations.
        </p>
        <p className="muted">
          Use Drive to discover document and spreadsheet IDs. Gmail reads plain
          text, headers and snippets; attachments are not downloaded. Search
          Console reads only properties that member selects with /google
          properties.
        </p>
        <p className="muted">
          Editing, sharing, deleting and sending are unavailable.
        </p>
      </section>
      {editing && data && (
        <GoogleEditor
          key={data.revision}
          data={data}
          name={def.name}
          busy={busy}
          close={() => setEditing(false)}
          save={save}
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
}: {
  data: GooglePage;
  name: string;
  busy: boolean;
  close: () => void;
  save: (clientId?: string, clientSecret?: string) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [operation, setOperation] = useState("");
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
    <Modal title={`Edit ${name} application`} busy={busy} onClose={close}>
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
      </dl>
      <p>Read-only access to Docs, Sheets, Drive, Gmail and Search Console.</p>
      <details className="setup-advanced google-oauth-scopes">
        <summary>OAuth scopes</summary>
        <p className="muted">
          Use these permission identifiers when configuring Google’s consent
          screen.
        </p>
        <dl className="plugin-summary google-connection-details">
          {data.scope.split(" ").map((scope) => (
            <ServiceUrl key={scope} label="Read scope" value={scope} />
          ))}
        </dl>
      </details>
      <p className="muted">
        Sign-in also requests your email to identify the account. All five
        services use this client. Each member connects their own Google account
        in private Telegram with /google and confirms the account there.
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
            disabled={busy}
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
            disabled={busy}
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
            Replacing credentials disconnects all personal Google accounts in
            this workspace.
          </small>
        </label>
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
