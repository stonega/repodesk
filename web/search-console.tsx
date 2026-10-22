import { useCallback, useEffect, useState } from "react";
import type { SearchConsolePage } from "../src/search-console/config.ts";
import { Modal, ModalActions } from "./modal.tsx";
import { Skeleton } from "./skeleton.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function message(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  if (code.startsWith("version_conflict"))
    return "Google settings changed in another session. Close this dialog and reload saved settings before retrying.";
  if (code === "search_console_property_denied")
    return "A selected property is no longer available to this Google account. Check its Search Console permissions.";
  if (code === "search_console_access_denied")
    return "Google denied access. Enable the Search Console API and check the connected account’s property permissions.";
  return "Could not load or save Search Console properties. Check the Google connection and try again.";
}
export function PropertyEditor({
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
          save this selection and enable Google.
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
          <div role="status" aria-label="Loading properties">
            <Skeleton width="100%" />
          </div>
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
            No properties found. Give the connected Google account access in
            Search Console, then retry.
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
