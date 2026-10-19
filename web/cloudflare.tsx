import { useCallback, useEffect, useState } from "react";
import type {
  CloudflarePage,
  CloudflareSettings,
} from "../src/cloudflare/config.ts";
import { cloudflareError } from "./cloudflare-errors.ts";
import { CloudflareResourceEditor } from "./cloudflare-resources.tsx";
import { CloudflareTokenEditor } from "./cloudflare-token.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
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
  const [editor, setEditor] = useState<"token" | "resources">();
  const notify = useToast();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<CloudflarePage>(endpoint));
    } catch (cause) {
      setError(cloudflareError(cause));
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(
    settings: CloudflareSettings,
    token?: string,
    removeToken?: boolean,
    verifyResources?: boolean,
  ) {
    if (!data || busy) return;
    setBusy(true);
    try {
      const result = await request<CloudflarePage>(endpoint, "PUT", {
        revision: data.revision,
        settings,
        ...(token ? { apiToken: token } : {}),
        ...(removeToken ? { removeToken } : {}),
        ...(verifyResources ? { verifyResources } : {}),
      });
      setData(result);
      setEditor(token && !removeToken ? "resources" : undefined);
      setError("");
      notify("Cloudflare settings saved.");
    } finally {
      setBusy(false);
    }
  }
  const tokenReady =
    data?.tokenConfigured && data.settings.authMethod !== "oauth";
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
            if (enabled && !tokenReady) {
              setEditor("token");
              return;
            }
            if (enabled && !data.settings.accountId) {
              setEditor("resources");
              return;
            }
            void save({ ...data.settings, enabled }).catch((cause) =>
              setError(cloudflareError(cause)),
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
        className="card cloudflare-summary-card"
        aria-label="Cloudflare authorization"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>API token</h2>
            <p className="muted">Scoped access to your Cloudflare resources</p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Cloudflare API token"
            showLabel
            disabled={!data || busy || loading}
            onClick={() => setEditor("token")}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>API token</dt>
            <dd>
              {data ? (tokenReady ? "Configured" : "Not configured") : pending}
            </dd>
          </div>
        </dl>
        {data && !tokenReady && (
          <p className="muted">
            Add a scoped API token in Edit to get started. No OAuth client
            registration is required.
          </p>
        )}
        {data?.settings.authMethod === "oauth" && (
          <p className="notice">
            This workspace has a legacy OAuth connection. Add an API token to
            switch.
          </p>
        )}
      </section>
      <section
        className="card cloudflare-summary-card"
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
            disabled={!data || busy || loading || !tokenReady}
            onClick={() => setEditor("resources")}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Account</dt>
            <dd>
              {data
                ? data.resources?.account?.name ||
                  data.settings.accountId ||
                  (tokenReady
                    ? "Choose an account in Edit"
                    : "Add an API token first")
                : pending}
            </dd>
          </div>
          <div>
            <dt>Allowed domains</dt>
            <dd>
              {data
                ? data.settings.zoneIds.length
                  ? data.settings.zoneIds.map((id) => (
                      <div key={id}>
                        {data.resources?.zones.find((zone) => zone.id === id)
                          ?.name || id}
                      </div>
                    ))
                  : data.settings.accountId
                    ? "Pages only"
                    : "No domains selected"
                : pending}
            </dd>
          </div>
        </dl>
      </section>
      <section
        className="card cloudflare-summary-card"
        aria-label="Cloudflare capabilities"
      >
        <h2>Queries and actions</h2>
        <p>
          Ask in a private Telegram conversation to inspect selected domains and
          DNS records, or Pages projects and deployments in the configured
          account.
        </p>
        <p>
          Workspace owners and admins can propose DNS changes and cache purges.
          Each change shows its exact request with Approve and Reject controls
          before execution.
        </p>
        <p className="muted">
          Grant Zone Read, DNS Read and Cloudflare Pages Read as needed. DNS
          changes require DNS Edit; cache purges require Cache Purge. Token
          resource restrictions should match this account and the selected
          domains.
        </p>
        <p className="muted">
          Workers, deployment creation and secret management are not included.
        </p>
      </section>
      {editor === "token" && data && (
        <CloudflareTokenEditor
          data={data}
          busy={busy}
          close={() => setEditor(undefined)}
          save={save}
        />
      )}
      {editor === "resources" && data && (
        <ResourceEditor
          data={data}
          request={request}
          endpoint={endpoint}
          busy={busy}
          close={() => setEditor(undefined)}
          save={save}
        />
      )}
    </section>
  );
}
function ResourceEditor({
  data,
  request,
  endpoint,
  busy,
  close,
  save,
}: {
  data: CloudflarePage;
  request: Request;
  endpoint: string;
  busy: boolean;
  close: () => void;
  save: (
    settings: CloudflareSettings,
    token?: string,
    removeToken?: boolean,
    verifyResources?: boolean,
  ) => Promise<void>;
}) {
  const [manual, setManual] = useState(false);
  return (
    <Modal title="Edit Cloudflare configuration" onClose={close} busy={busy}>
      <p className="muted">
        {manual
          ? "Use IDs from the Cloudflare dashboard when your token cannot discover accounts. Permissions are checked when a tool uses the token."
          : "Choose the resources this workspace can use. Account verification needs Account Settings Read. User tokens need User Memberships Read to discover accounts; if discovery is unavailable, enter IDs manually."}
      </p>
      <button
        className="secondary"
        type="button"
        disabled={busy}
        onClick={() => setManual(!manual)}
      >
        {manual ? "Choose by name" : "Enter IDs manually"}
      </button>
      {manual ? (
        <ManualResourceEditor
          data={data}
          busy={busy}
          save={(settings) => save(settings)}
        />
      ) : (
        <CloudflareResourceEditor
          data={data}
          request={request}
          endpoint={endpoint}
          busy={busy}
          save={(settings) => save(settings, undefined, false, true)}
        />
      )}
    </Modal>
  );
}
function ManualResourceEditor({
  data,
  busy,
  save,
}: {
  data: CloudflarePage;
  busy: boolean;
  save: (settings: CloudflareSettings) => Promise<void>;
}) {
  const [account, setAccount] = useState(data.settings.accountId);
  const [zones, setZones] = useState(data.settings.zoneIds.join("\n"));
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const zoneIds = zones
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((id) => id.toLowerCase());
        if (
          zoneIds.length > 20 ||
          zoneIds.some((id) => !/^[a-f0-9]{32}$/.test(id)) ||
          new Set(zoneIds).size !== zoneIds.length
        ) {
          setError(
            "Enter up to 20 unique zone IDs, each with 32 hexadecimal characters.",
          );
          return;
        }
        setError("");
        try {
          await save({
            ...data.settings,
            authMethod: "api_token",
            accountId: account.toLowerCase(),
            zoneIds,
            enabled: data.settings.enabled || !data.settings.accountId,
          });
        } catch (cause) {
          setError(cloudflareError(cause));
        }
      }}
    >
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>Account ID</span>
        <input
          required
          pattern="[a-fA-F0-9]{32}"
          maxLength={32}
          value={account}
          disabled={busy}
          onChange={(event) => setAccount(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Allowed zone IDs</span>
        <textarea
          aria-label="Allowed zone IDs"
          rows={4}
          value={zones}
          disabled={busy}
          onChange={(event) => setZones(event.target.value)}
        />
        <small className="muted">
          One zone ID per line, up to 20. Leave empty for Pages only.
        </small>
      </label>
      <ModalActions>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </form>
  );
}
