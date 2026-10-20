import { useCallback, useEffect, useState } from "react";
import type { SearchConsolePage } from "../src/search-console/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function message(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    version_conflict:
      "These plugins changed in another session. Close this dialog and retry loading saved settings before editing again.",
    search_console_invalid_credential:
      "Paste a valid Google service account JSON key with an RSA private key.",
    search_console_access_denied:
      "Google denied access. Enable the Search Console API and add the service account email to your properties' users.",
    search_console_property_denied:
      "A selected property is no longer available to this service account. Check its Search Console permissions.",
    search_console_rate_limited: "Google's quota was reached. Try again later.",
    search_console_not_configured:
      "Save a service account and select at least one property before enabling.",
    search_console_unavailable:
      "Google could not be reached. Try again when the connection is available.",
    search_console_request_failed:
      "Google could not complete this request. Check the API and property access, then try again.",
    access_denied:
      "Only this workspace's deployment operator can manage this connection.",
    invalid_request: "Check the service account JSON and selected properties.",
  };
  return (
    messages[code.includes("version_conflict") ? "version_conflict" : code] ??
    "Could not load or save Google Search Console. Try again."
  );
}
export function SearchConsole({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/search-console`;
  const [data, setData] = useState<SearchConsolePage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<"credential" | "properties">();
  const notify = useToast();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await request<SearchConsolePage>(endpoint));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(
    settings: SearchConsolePage["settings"],
    credential?: string,
    removeCredential?: boolean,
  ) {
    if (!data || busy) return;
    setBusy(true);
    try {
      const result = await request<SearchConsolePage>(endpoint, "PUT", {
        revision: data.revision,
        settings,
        ...(credential ? { serviceAccount: credential } : {}),
        ...(removeCredential ? { removeCredential: true } : {}),
      });
      setData(result);
      setError("");
      setEditor(credential ? "properties" : undefined);
      notify("Google Search Console settings saved.");
    } catch (cause) {
      setError(message(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  const pending = error ? "—" : <Skeleton width="10rem" />;
  return (
    <section
      className="plugin-detail"
      aria-label="Google Search Console plugin"
    >
      <PluginDetailHeading title="Google Search Console" backTo={backTo}>
        <PluginToggle
          name="Google Search Console"
          enabled={data?.settings.enabled}
          disabled={busy || loading || !data}
          loading={loading && !data}
          onChange={(enabled) => {
            if (!data) return;
            if (enabled && !data.credentialConfigured) {
              setEditor("credential");
              return;
            }
            if (enabled && !data.settings.siteUrls.length) {
              setEditor("properties");
              return;
            }
            void save({ ...data.settings, enabled }).catch((cause) =>
              setError(message(cause)),
            );
          }}
        />
      </PluginDetailHeading>
      {error && !editor && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Reload saved Search Console settings"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card cloudflare-summary-card"
        aria-label="Search Console authorization"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Service account</h2>
            <p className="muted">Read-only access to Google Search Console</p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Search Console service account"
            showLabel
            disabled={!data || busy || loading}
            onClick={() => setEditor("credential")}
          />
        </div>
        <dl className="plugin-summary search-console-summary">
          <div>
            <dt>Connection</dt>
            <dd>
              {data
                ? data.credentialConfigured
                  ? "Configured"
                  : "Not configured"
                : pending}
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{data ? data.email || "No service account saved" : pending}</dd>
          </div>
        </dl>
        {data && !data.credentialConfigured && (
          <p className="muted">
            Enable the Search Console API in your Google Cloud project, create a
            service account JSON key and add its email as a user of each
            property you want to query.
          </p>
        )}
      </section>
      <section
        className="card cloudflare-summary-card"
        aria-label="Search Console properties"
        aria-busy={loading || busy}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Properties</h2>
            <p className="muted">
              Only selected properties are available to this workspace
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Search Console properties"
            showLabel
            disabled={!data?.credentialConfigured || busy || loading}
            onClick={() => setEditor("properties")}
          />
        </div>
        <dl className="plugin-summary search-console-properties">
          <div>
            <dt>Allowed properties</dt>
            <dd>
              {data
                ? data.settings.siteUrls.length
                  ? data.settings.siteUrls.map((url) => (
                      <div key={url}>{url}</div>
                    ))
                  : "No properties selected"
                : pending}
            </dd>
          </div>
        </dl>
      </section>
      <section
        className="card cloudflare-summary-card"
        aria-label="Search Console capabilities"
      >
        <h2>Queries</h2>
        <p>
          Ask in a private Telegram conversation about search clicks,
          impressions, CTR and average position by query, page, country, device
          or date. Read sitemap status or inspect Google's indexed version of a
          URL.
        </p>
        <p className="muted">
          Performance uses finalized data and Pacific dates. Google returns top
          rows and may omit recent or anonymized data. URL inspection does not
          request indexing.
        </p>
      </section>
      {editor === "credential" && data && (
        <CredentialEditor
          data={data}
          busy={busy}
          close={() => setEditor(undefined)}
          save={save}
        />
      )}
      {editor === "properties" && data && (
        <PropertyEditor
          key={data.revision}
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
function CredentialEditor({
  data,
  busy,
  close,
  save,
}: {
  data: SearchConsolePage;
  busy: boolean;
  close: () => void;
  save: (
    settings: SearchConsolePage["settings"],
    credential?: string,
    removeCredential?: boolean,
  ) => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Edit Search Console service account"
      busy={busy}
      onClose={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await save(data.settings, credential.trim() || undefined, remove);
          } catch (cause) {
            setError(message(cause));
          }
        }}
      >
        <p className="muted">
          Add the service account email to each property in Google Search
          Console → Settings → Users and permissions. Replacing a key clears the
          property selection and disables the plugin until you select properties
          again.
        </p>
        <label className="field">
          <span>Service account JSON</span>
          <textarea
            rows={7}
            value={credential}
            autoComplete="off"
            spellCheck={false}
            disabled={remove}
            required={!data.credentialConfigured && !remove}
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
        {data.credentialConfigured && (
          <>
            <p className="muted">
              Leave blank to keep the saved key. Saved private keys are never
              displayed.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={remove}
                onChange={(event) => {
                  setRemove(event.target.checked);
                  setCredential("");
                }}
              />
              Remove saved credentials and disable Google Search Console
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <ModalActions>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save service account"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
function PropertyEditor({
  data,
  request,
  endpoint,
  busy,
  close,
  save,
}: {
  data: SearchConsolePage;
  request: Request;
  endpoint: string;
  busy: boolean;
  close: () => void;
  save: (settings: SearchConsolePage["settings"]) => Promise<void>;
}) {
  const [items, setItems] =
    useState<{ siteUrl: string; permissionLevel: string }[]>();
  const [selected, setSelected] = useState(data.settings.siteUrls);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(
        (
          await request<{
            items: { siteUrl: string; permissionLevel: string }[];
          }>(`${endpoint}/properties`, "POST", { revision: data.revision })
        ).items,
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [data.revision, endpoint, request]);
  useEffect(() => {
    void load();
  }, [load]);
  const choices = [
    ...new Set([...(items?.map((item) => item.siteUrl) ?? []), ...selected]),
  ];
  return (
    <Modal title="Edit Search Console properties" busy={busy} onClose={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await save({ enabled: data.settings.enabled, siteUrls: selected });
          } catch (cause) {
            setError(message(cause));
          }
        }}
      >
        <p className="muted">
          Select up to 20 properties. Discovery does not grant access until you
          save this selection and enable the plugin.
        </p>
        <label className="field">
          <span>Search properties</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {loading ? (
          <p role="status">Loading properties…</p>
        ) : choices.length ? (
          <div className="cloudflare-domain-list">
            {choices
              .filter((site) =>
                site.toLowerCase().includes(search.toLowerCase()),
              )
              .map((site) => (
                <label className="check" key={site}>
                  <input
                    type="checkbox"
                    checked={selected.includes(site)}
                    disabled={!selected.includes(site) && selected.length >= 20}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, site]
                          : selected.filter((value) => value !== site),
                      )
                    }
                  />
                  <span>
                    {site}
                    {items && !items.some((item) => item.siteUrl === site)
                      ? " (no longer available)"
                      : ""}
                  </span>
                </label>
              ))}
          </div>
        ) : items ? (
          <p>
            No properties found. Add the saved service account email as a user
            in Search Console, then retry.
          </p>
        ) : null}
        {!loading &&
          items &&
          !choices.filter((site) =>
            site.toLowerCase().includes(search.toLowerCase()),
          ).length &&
          choices.length > 0 && <p>No matching properties.</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !items?.length && (
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
          >
            Retry loading properties
          </button>
        )}
        <ModalActions>
          <button type="submit" disabled={busy || loading || !items}>
            {busy ? "Saving…" : "Save properties"}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
