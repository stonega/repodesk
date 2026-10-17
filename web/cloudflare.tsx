import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  CloudflarePage,
  CloudflareSettings,
} from "../src/cloudflare/config.ts";
import { CloudflareOAuth } from "./cloudflare-oauth.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function explain(cause: unknown) {
  const code = (cause as Error).message;
  if (code.includes("version_conflict"))
    return "Cloudflare settings changed in another session. Close the editor and reload saved settings before trying again.";
  const messages: Record<string, string> = {
    cloudflare_disconnect_before_client_change:
      "Disconnect Cloudflare before changing its client, scopes or authentication method.",
    cloudflare_token_and_account_required:
      "Enter an account ID and API token before enabling Cloudflare.",
    cloudflare_credentials_unavailable:
      "Cloudflare credential storage is unavailable. Check the API and worker configuration.",
    extension_tool_collision:
      "A file plugin already uses a Cloudflare tool name. Update its grants first.",
    invalid_request:
      "Check the 32-character account and zone IDs, unique zones, and API token.",
    access_denied:
      "Only this workspace’s deployment operator can configure Cloudflare.",
  };
  return messages[code] ?? code;
}

export function Cloudflare({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/cloudflare`;
  const [data, setData] = useState<CloudflarePage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<CloudflareSettings>();
  const notify = useToast();
  const [params, setParams] = useSearchParams();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<CloudflarePage>(endpoint));
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const result = params.get("cloudflare");
    if (!result) return;
    if (result === "connected") notify("Cloudflare connected.");
    else
      setError(
        "Cloudflare authorization was cancelled, expired or failed. Check the saved client, account and permissions, then reconnect.",
      );
    const next = new URLSearchParams(params);
    next.delete("cloudflare");
    setParams(next, { replace: true });
  }, [params, setParams, notify]);
  async function save(
    settings: CloudflareSettings,
    token?: string,
    removeToken?: boolean,
  ) {
    if (!data || busy) return;
    setBusy(true);
    try {
      const result = await request<CloudflarePage>(endpoint, "PUT", {
        revision: data.revision,
        settings,
        ...(token ? { apiToken: token } : {}),
        ...(removeToken ? { removeToken } : {}),
      });
      setData(result);
      setEditor(undefined);
      setError("");
      notify("Cloudflare settings saved.");
    } catch (cause) {
      setError(explain(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  const pending = error ? "—" : <Skeleton width="10rem" />;
  return (
    <section className="plugin-detail" aria-label="Cloudflare plugin">
      <PluginDetailHeading title="Cloudflare" backTo={backTo}>
        <PluginToggle
          name="Cloudflare"
          enabled={data?.settings.enabled}
          loading={loading && !data}
          disabled={busy || loading || !data}
          onChange={(enabled) => {
            if (!data) return;
            if (
              enabled &&
              data.settings.authMethod === "oauth" &&
              !["connected", "refreshing"].includes(data.oauth?.status ?? "")
            ) {
              setError(
                "Complete OAuth setup and select Connect Cloudflare to enable this plugin.",
              );
              return;
            }
            if (
              enabled &&
              (!data.tokenConfigured || !data.settings.accountId)
            ) {
              setEditor({ ...data.settings, enabled });
              return;
            }
            void save({ ...data.settings, enabled }).catch((cause) =>
              setError(explain(cause)),
            );
          }}
        />
      </PluginDetailHeading>
      {error && !editor && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Reload saved settings"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card"
        aria-label="Cloudflare configuration"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Configuration</h2>
            <p className="muted">Cloudflare resources for this workspace</p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Cloudflare configuration"
            showLabel
            disabled={!data || busy || loading}
            onClick={() => {
              if (data) setEditor(data.settings);
            }}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Account ID</dt>
            <dd className="mono">
              {data ? data.settings.accountId || "Not configured" : pending}
            </dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>
              {data
                ? data.settings.authMethod === "oauth"
                  ? "Cloudflare authorization"
                  : "API token"
                : pending}
            </dd>
          </div>
          {data?.settings.authMethod !== "oauth" && (
            <div>
              <dt>API token</dt>
              <dd>
                {data
                  ? data.tokenConfigured
                    ? "Configured"
                    : "Not configured"
                  : pending}
              </dd>
            </div>
          )}
          <div>
            <dt>Allowed zone IDs</dt>
            <dd>
              {data
                ? data.settings.zoneIds.length
                  ? data.settings.zoneIds.map((id) => (
                      <div className="mono" key={id}>
                        {id}
                      </div>
                    ))
                  : "No zones selected"
                : pending}
            </dd>
          </div>
        </dl>
        {data &&
          !data.tokenConfigured &&
          data.settings.authMethod !== "oauth" && (
            <p className="muted">
              Add a scoped API token in Edit to get started. Saving does not
              verify the token’s permissions.
            </p>
          )}
      </section>
      {(!data || data.settings.authMethod === "oauth") && (
        <CloudflareOAuth
          request={request}
          endpoint={endpoint}
          data={data}
          busy={busy}
          setBusy={setBusy}
          saved={setData}
          reload={() => void load()}
        />
      )}
      <section className="card" aria-label="Cloudflare capabilities">
        <h2>Queries and actions</h2>
        <p>
          Ask in a private Telegram conversation to inspect selected zones and
          DNS records, or Pages projects and deployments in the configured
          account.
        </p>
        <p>
          Workspace owners and admins can propose DNS changes and cache purges.
          Each change shows its exact request with Approve and Reject controls
          before execution.
        </p>
        <p className="muted">
          Grant Zone Read, DNS Read, and Account Pages Read permissions as
          needed. DNS changes require DNS Edit; cache purges require Cache
          Purge. Token resource restrictions should match this account and the
          selected zones.
        </p>
        <p className="muted">
          Workers, deployment creation and secret management are not included.
        </p>
      </section>
      {editor && data && (
        <CloudflareEditor
          initial={editor}
          tokenConfigured={data.tokenConfigured}
          busy={busy}
          close={() => setEditor(undefined)}
          save={save}
        />
      )}
    </section>
  );
}

function CloudflareEditor({
  initial,
  tokenConfigured,
  busy,
  close,
  save,
}: {
  initial: CloudflareSettings;
  tokenConfigured: boolean;
  busy: boolean;
  close: () => void;
  save: (
    settings: CloudflareSettings,
    token?: string,
    removeToken?: boolean,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [zones, setZones] = useState(initial.zoneIds.join("\n"));
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Edit Cloudflare configuration" onClose={close} busy={busy}>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const settings = {
            ...draft,
            accountId: draft.accountId.trim().toLowerCase(),
            zoneIds: zones
              .split(/[\s,]+/)
              .filter(Boolean)
              .map((s) => s.toLowerCase()),
          };
          if (
            settings.zoneIds.length > 20 ||
            settings.zoneIds.some((s) => !/^[a-f0-9]{32}$/.test(s)) ||
            new Set(settings.zoneIds).size !== settings.zoneIds.length
          ) {
            setError(
              "Enter up to 20 unique zone IDs, each with 32 hexadecimal characters.",
            );
            return;
          }
          setError("");
          try {
            await save(settings, token.trim() || undefined, removeToken);
          } catch (cause) {
            setError(explain(cause));
          }
        }}
      >
        <label className="field" htmlFor="cloudflare-auth-method">
          <span>Authentication</span>
          <Select
            id="cloudflare-auth-method"
            aria-label="Authentication"
            value={draft.authMethod ?? "api_token"}
            onChange={(e) =>
              setDraft({
                ...draft,
                authMethod: e.target.value as "oauth" | "api_token",
                enabled: false,
              })
            }
          >
            <option value="oauth">Cloudflare authorization</option>
            <option value="api_token">API token</option>
          </Select>
        </label>
        {draft.authMethod === "oauth" && (
          <p className="muted">
            Save the account and zone settings, then use Connect Cloudflare in
            Authorization to enable access.
          </p>
        )}
        <label className="field">
          <span>Account ID</span>
          <input
            value={draft.accountId}
            required={draft.enabled}
            pattern="[a-fA-F0-9]{32}"
            maxLength={32}
            onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Allowed zone IDs</span>
          <textarea
            aria-label="Allowed zone IDs"
            aria-describedby="cloudflare-zones-help"
            rows={4}
            value={zones}
            onChange={(e) => setZones(e.target.value)}
          />
          <small className="muted" id="cloudflare-zones-help">
            One zone ID per line, up to 20. Leave empty to use Pages queries
            only. Find IDs in your Cloudflare dashboard.
          </small>
        </label>
        {draft.authMethod !== "oauth" && (
          <>
            <label className="field">
              <span>{tokenConfigured ? "Replace API token" : "API token"}</span>
              <input
                type="password"
                aria-label={tokenConfigured ? "Replace API token" : "API token"}
                aria-describedby="cloudflare-token-help"
                autoComplete="new-password"
                value={token}
                disabled={removeToken}
                required={draft.enabled && !tokenConfigured}
                pattern="[A-Za-z0-9_-]{20,256}"
                maxLength={256}
                onChange={(e) => setToken(e.target.value)}
              />
              <small className="muted" id="cloudflare-token-help">
                {tokenConfigured ? "Leave blank to keep the saved token. " : ""}
                The token is encrypted and is never displayed after saving.
              </small>
            </label>
            {tokenConfigured && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={removeToken}
                  onChange={(e) => {
                    setRemoveToken(e.target.checked);
                    if (e.target.checked) {
                      setDraft({ ...draft, enabled: false });
                      setToken("");
                    }
                  }}
                />
                Remove saved token and disable Cloudflare
              </label>
            )}
          </>
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
