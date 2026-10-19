import { useState } from "react";
import type {
  CloudflarePage,
  CloudflareSettings,
} from "../src/cloudflare/config.ts";
import { cloudflareError } from "./cloudflare-errors.ts";
import { Modal, ModalActions } from "./modal.tsx";

export function CloudflareTokenEditor({
  data,
  busy,
  close,
  save,
}: {
  data: CloudflarePage;
  busy: boolean;
  close: () => void;
  save: (
    settings: CloudflareSettings,
    token?: string,
    removeToken?: boolean,
  ) => Promise<void>;
}) {
  const tokenConfigured =
    data.tokenConfigured && data.settings.authMethod !== "oauth";
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Edit Cloudflare API token" busy={busy} onClose={close}>
      <p>
        Prefer an account API token for credentials that are independent of a
        user. Create a scoped token in Cloudflare, then paste it here. User API
        tokens also work.
      </p>
      <p>
        <a
          href="https://dash.cloudflare.com/?to=/:account/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
        >
          Create an account API token ↗
        </a>
      </p>
      <p className="muted">
        Include Account Settings Read for account verification. Add Zone Read,
        DNS Read and Cloudflare Pages Read as needed; DNS changes need DNS Edit
        and cache purges need Cache Purge. Restrict the token to the accounts
        and domains you want to use.
      </p>
      <p className="muted">
        User API tokens need User Memberships Read to discover accounts. If your
        token cannot list accounts, choose Enter IDs manually in Configuration
        after saving.
      </p>
      {data.settings.authMethod === "oauth" && (
        <p className="notice">
          Saving a token replaces this workspace’s OAuth connection. Revoke its
          old authorization in Cloudflare afterward.
        </p>
      )}
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
          try {
            await save(
              {
                ...data.settings,
                authMethod: "api_token",
                enabled:
                  token.trim() || removeToken ? false : data.settings.enabled,
              },
              token.trim() || undefined,
              removeToken,
            );
          } catch (cause) {
            setError(cloudflareError(cause));
          }
        }}
      >
        <label className="field">
          <span>{tokenConfigured ? "Replace API token" : "API token"}</span>
          <input
            type="password"
            aria-label={tokenConfigured ? "Replace API token" : "API token"}
            aria-describedby="cloudflare-api-token-help"
            autoComplete="new-password"
            value={token}
            disabled={busy || removeToken}
            required={!tokenConfigured && !removeToken}
            pattern="[A-Za-z0-9_-]{20,256}"
            maxLength={256}
            onChange={(event) => setToken(event.target.value)}
          />
          <small className="muted" id="cloudflare-api-token-help">
            {tokenConfigured && "Leave blank to keep the saved token. "}The
            token is encrypted and never displayed after saving. Saving alone
            does not verify its permissions.
          </small>
        </label>
        {tokenConfigured && (
          <label className="check">
            <input
              type="checkbox"
              checked={removeToken}
              disabled={busy}
              onChange={(event) => {
                setRemoveToken(event.target.checked);
                if (event.target.checked) setToken("");
              }}
            />
            Remove saved token and disable Cloudflare
          </label>
        )}
        <ModalActions>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
