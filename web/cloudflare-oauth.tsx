import { useState } from "react";
import type { CloudflarePage } from "../src/cloudflare/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function cloudflareOAuthError(cause: unknown) {
  const code = (cause as Error).message;
  if (code.includes("version_conflict"))
    return "Cloudflare settings changed in another session. Reload saved settings before trying again.";
  return (
    (
      {
        cloudflare_oauth_client_required:
          "Save the OAuth client ID, client secret and API scopes first.",
        cloudflare_oauth_accounts_empty:
          "No accounts were authorized. Reconnect Cloudflare and select an account with Account Read permission.",
        cloudflare_oauth_account_required: "Choose an account before saving.",
        cloudflare_zone_denied:
          "A selected domain is unavailable or belongs to another account. Check your selection and permissions.",
        cloudflare_oauth_account_denied:
          "Cloudflare did not authorize the selected account. Reconnect and grant access to that account.",
        cloudflare_access_denied:
          "Cloudflare denied access. Check the account and required Account Read or Zone Read permissions.",
        cloudflare_unavailable:
          "Couldn’t load Cloudflare resources. Try again shortly.",
        cloudflare_reconnect_required:
          "Cloudflare authorization expired. Reconnect to continue.",
        cloudflare_disconnect_before_client_change:
          "Disconnect Cloudflare before changing its client, scopes or authentication method.",
        cloudflare_https_required:
          "OAuth requires an HTTPS site address. Configure Site domain before connecting.",
        cloudflare_authorization_expired:
          "This connection attempt expired or changed. Start Connect Cloudflare again.",
        cloudflare_oauth_failed:
          "Cloudflare authorization failed. Check the OAuth client configuration and try again.",
        invalid_request:
          "Check the client ID, secret and dot-delimited API scope IDs.",
      } as Record<string, string>
    )[code] ?? code
  );
}
export function CloudflareOAuth({
  request,
  endpoint,
  data,
  busy,
  setBusy,
  saved,
  reload,
}: {
  request: Request;
  endpoint: string;
  data?: CloudflarePage;
  busy: boolean;
  setBusy: (value: boolean) => void;
  saved: (value: CloudflarePage) => void;
  reload: () => void;
}) {
  const [editor, setEditor] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");
  const notify = useToast();
  const oauth = data?.oauth;
  const canConnect =
    !!oauth?.clientId &&
    oauth.clientSecretConfigured &&
    oauth.scopes.length > 0;
  const connected = oauth?.status !== "not_connected" && !!oauth?.status;
  const labels = {
    not_connected: "Not connected",
    connected: "Connected",
    refreshing: "Refreshing",
    reconnect_required: "Reconnect required",
  };
  return (
    <section
      className="card"
      aria-label="Cloudflare authorization"
      aria-busy={busy || !data}
    >
      <div className="plugin-card-heading coding-card-heading">
        <div>
          <h2>Authorization</h2>
          <p className="muted">Connect through Cloudflare’s consent screen.</p>
        </div>
        <IconButton
          icon="edit"
          label="Edit Cloudflare OAuth application"
          showLabel
          disabled={busy || !data}
          onClick={() => {
            setError("");
            setEditor(true);
          }}
        />
      </div>
      {error && !editor && !disconnecting && (
        <ErrorToast message={error}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              reload();
            }}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <dl className="plugin-summary">
        <div>
          <dt>Connection</dt>
          <dd>
            {data ? (
              labels[oauth?.status ?? "not_connected"]
            ) : (
              <Skeleton width="8rem" />
            )}
          </dd>
        </div>
        <div>
          <dt>OAuth client</dt>
          <dd className="mono">
            {data ? (
              oauth?.clientId || "Not configured"
            ) : (
              <Skeleton width="8rem" />
            )}
          </dd>
        </div>
        <div>
          <dt>Client secret</dt>
          <dd>
            {data ? (
              oauth?.clientSecretConfigured ? (
                "Configured"
              ) : (
                "Not configured"
              )
            ) : (
              <Skeleton width="8rem" />
            )}
          </dd>
        </div>
        {oauth?.expiresAt && (
          <div>
            <dt>Access expires</dt>
            <dd>{new Date(oauth.expiresAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {oauth?.scopes.length ? (
        <p className="muted" style={{ overflowWrap: "anywhere" }}>
          API scopes: {oauth.scopes.join(", ")}
        </p>
      ) : (
        <p className="muted">
          Register a Cloudflare OAuth client once, then save its credentials and
          API scope IDs in Edit. Account Read discovers authorized accounts;
          Zone Read discovers domains. No account or zone IDs are needed.
        </p>
      )}
      {oauth?.status === "reconnect_required" && (
        <p className="notice" role="status">
          Authorization expired or its refresh could not be confirmed. Reconnect
          to resume Cloudflare access.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          disabled={busy || !canConnect}
          onClick={async () => {
            if (!data) return;
            setBusy(true);
            setError("");
            try {
              const result = await request<{ url: string }>(
                `${endpoint}/oauth/connect`,
                "POST",
                { revision: data.revision },
              );
              window.location.assign(result.url);
            } catch (cause) {
              setError(cloudflareOAuthError(cause));
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Connecting…"
            : connected
              ? "Reconnect Cloudflare"
              : "Connect Cloudflare"}
        </button>
        {connected && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setError("");
              setDisconnecting(true);
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      <p className="muted">
        Choose accounts and permissions on Cloudflare. A single account is
        selected automatically; if you authorize several, choose one here
        afterward. Use Configuration → Edit to select optional domains for DNS
        and cache access.
      </p>
      {editor && data && (
        <OAuthEditor
          data={data}
          busy={busy}
          close={() => setEditor(false)}
          save={async (oauthClient) => {
            setBusy(true);
            try {
              const next = await request<CloudflarePage>(endpoint, "PUT", {
                revision: data.revision,
                settings: {
                  ...data.settings,
                  enabled:
                    data.settings.enabled &&
                    oauthClient.clientId === data.oauth?.clientId &&
                    JSON.stringify(oauthClient.scopes) ===
                      JSON.stringify(data.oauth?.scopes),
                },
                oauthClient,
              });
              saved(next);
              setEditor(false);
              notify("Cloudflare OAuth application saved.");
            } catch (cause) {
              setError(cloudflareOAuthError(cause));
              throw cause;
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {disconnecting && data && (
        <Modal
          title="Disconnect Cloudflare"
          busy={busy}
          onClose={() => setDisconnecting(false)}
        >
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <p>
            Disconnect Cloudflare and disable this plugin? This removes the
            saved OAuth tokens and requests revocation in Cloudflare. Existing
            DNS records and deployments remain in place.
          </p>
          <ModalActions>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const next = await request<
                    CloudflarePage & { revocationConfirmed: boolean }
                  >(`${endpoint}/oauth/disconnect`, "POST", {
                    revision: data.revision,
                  });
                  saved(next);
                  setDisconnecting(false);
                  if (next.revocationConfirmed)
                    notify("Cloudflare disconnected.");
                  else
                    setError(
                      "Local access was removed. Cloudflare revocation could not be confirmed; revoke the authorization in your Cloudflare profile.",
                    );
                } catch (cause) {
                  setError(cloudflareOAuthError(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </ModalActions>
        </Modal>
      )}
    </section>
  );
}
function OAuthEditor({
  data,
  busy,
  close,
  save,
}: {
  data: CloudflarePage;
  busy: boolean;
  close: () => void;
  save: (client: {
    clientId: string;
    clientSecret?: string;
    scopes: string[];
  }) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(data.oauth?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState(
    data.oauth?.scopes.length ? data.oauth.scopes.join("\n") : "account.read",
  );
  const [error, setError] = useState("");
  return (
    <Modal
      title="Edit Cloudflare OAuth application"
      busy={busy}
      onClose={close}
    >
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <p>
        In Cloudflare, create an OAuth client with Authorization Code and
        Refresh Token grants, Code response type and client_secret_basic
        authentication. Register this callback URL:
      </p>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>
        {data.oauth?.redirectUri}
      </p>
      <p>
        <a
          href="https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Cloudflare client setup ↗
        </a>
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          const list = scopes.split(/[\s,]+/).filter(Boolean);
          if (
            !list.some((s) => s.includes(".")) ||
            new Set(list).size !== list.length ||
            list.length > 30 ||
            list.some((s) => !/^[a-z0-9][a-z0-9_.-]{0,199}$/.test(s))
          ) {
            setError(
              "Enter up to 30 unique API scope IDs from your Cloudflare client.",
            );
            return;
          }
          try {
            await save({
              clientId,
              ...(secret ? { clientSecret: secret } : {}),
              scopes: list,
            });
          } catch (cause) {
            setError(cloudflareOAuthError(cause));
          }
        }}
      >
        <label className="field">
          <span>Client ID</span>
          <input
            required
            value={clientId}
            pattern="[A-Za-z0-9_.-]{1,200}"
            maxLength={200}
            onChange={(e) => setClientId(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Client secret</span>
          <input
            type="password"
            autoComplete="new-password"
            required={
              !data.oauth?.clientSecretConfigured ||
              clientId !== data.oauth?.clientId
            }
            maxLength={4096}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <p className="muted">
          Leave the secret blank to keep the saved value for the same client ID.
        </p>
        <label className="field">
          <span>API scope IDs</span>
          <textarea
            aria-label="API scope IDs"
            required
            rows={4}
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
        </label>
        <p className="muted">
          Copy the dot-delimited API scope IDs selected for your client. Include
          Account Read plus the permissions needed for your queries/actions.
          Offline access is requested automatically.
        </p>
        <ModalActions>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
