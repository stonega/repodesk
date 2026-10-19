import { useEffect, useState } from "react";
import type {
  CloudflarePage,
  CloudflareResource,
  CloudflareResourcePage,
  CloudflareSettings,
} from "../src/cloudflare/config.ts";
import { cloudflareError } from "./cloudflare-errors.ts";
import { ModalActions } from "./modal.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const merge = (old: CloudflareResource[], added: CloudflareResource[]) => [
  ...new Map([...old, ...added].map((item) => [item.id, item])).values(),
];

export function CloudflareResourceEditor({
  data,
  request,
  endpoint,
  busy,
  save,
}: {
  data: CloudflarePage;
  request: Request;
  endpoint: string;
  busy: boolean;
  save: (settings: CloudflareSettings) => Promise<void>;
}) {
  const [accounts, setAccounts] = useState<CloudflareResource[]>([]);
  const [accountId, setAccountId] = useState(data.settings.accountId);
  const [accountQuery, setAccountQuery] = useState({ page: 1 });
  const [moreAccounts, setMoreAccounts] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountError, setAccountError] = useState("");
  const [zones, setZones] = useState<CloudflareResource[]>([]);
  const [selected, setSelected] = useState(data.settings.zoneIds);
  const [zoneQuery, setZoneQuery] = useState({ page: 1 });
  const [moreZones, setMoreZones] = useState(false);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [zoneError, setZoneError] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setAccountsLoading(true);
    setAccountError("");
    void request<CloudflareResourcePage>(`${endpoint}/resources`, "POST", {
      revision: data.revision,
      resource: "accounts",
      page: accountQuery.page,
    })
      .then((result) => {
        if (cancelled) return;
        setAccounts((old) =>
          merge(accountQuery.page === 1 ? [] : old, result.items),
        );
        setMoreAccounts(result.hasMore);
        if (
          !data.settings.accountId &&
          accountQuery.page === 1 &&
          result.items.length === 1 &&
          !result.hasMore
        )
          setAccountId((current) => current || result.items[0]?.id || "");
      })
      .catch((cause) => {
        if (!cancelled) setAccountError(cloudflareError(cause));
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, endpoint, data.revision, data.settings.accountId, accountQuery]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setZonesLoading(true);
    setZoneError("");
    void request<CloudflareResourcePage>(`${endpoint}/resources`, "POST", {
      revision: data.revision,
      resource: "zones",
      accountId,
      page: zoneQuery.page,
    })
      .then((result) => {
        if (cancelled) return;
        setZones((old) => merge(zoneQuery.page === 1 ? [] : old, result.items));
        setMoreZones(result.hasMore);
      })
      .catch((cause) => {
        if (!cancelled) setZoneError(cloudflareError(cause));
      })
      .finally(() => {
        if (!cancelled) setZonesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, endpoint, data.revision, accountId, zoneQuery]);
  const accountChoices = merge(
    data.resources?.account ? [data.resources.account] : [],
    accounts,
  );
  const zoneChoices = merge(
    selected.map(
      (id) =>
        data.resources?.zones.find((z) => z.id === id) ?? { id, name: id },
    ),
    zones,
  );
  const account = accountChoices.find((item) => item.id === accountId);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!accountId || busy || accountsLoading || zonesLoading) return;
        setError("");
        try {
          await save({
            ...data.settings,
            authMethod: "api_token",
            accountId,
            zoneIds: selected,
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
      <div className="field" aria-busy={accountsLoading}>
        <span>Account</span>
        {accountsLoading && !accountChoices.length ? (
          <Skeleton width="12rem" />
        ) : accountChoices.length === 1 && account ? (
          <p>{account.name}</p>
        ) : (
          <Select
            aria-label="Account"
            value={accountId}
            disabled={busy || accountsLoading}
            onChange={(event) => {
              setAccountId(event.target.value);
              setSelected([]);
              setZones([]);
              setZoneQuery({ page: 1 });
              setMoreZones(false);
              setSearch("");
              setZonesLoading(!!event.target.value);
            }}
          >
            <option value="">Choose an account</option>
            {accountChoices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        )}
        {accountError && (
          <p className="notice" role="alert">
            {accountError}{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => setAccountQuery((query) => ({ ...query }))}
            >
              Retry
            </button>
          </p>
        )}
        {!accountsLoading && !accountError && !accounts.length && (
          <p className="muted">
            No accounts are available. Check the token’s account restrictions.
            User tokens need User Memberships Read for discovery. If accounts
            cannot be listed, enter IDs manually.
          </p>
        )}
        {moreAccounts && (
          <button
            type="button"
            className="secondary"
            disabled={accountsLoading || busy}
            onClick={() =>
              setAccountQuery((query) => ({ page: query.page + 1 }))
            }
          >
            More accounts
          </button>
        )}
      </div>
      <fieldset
        className="cloudflare-domain-fields"
        disabled={!accountId || busy}
        aria-busy={zonesLoading}
      >
        <legend>Allowed domains</legend>
        <p className="muted">
          Optional. Select up to 20 domains for traffic, DNS and other domain
          features. Leave all unchecked for account resources only.
        </p>
        <label className="field">
          <span>Search domains</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {zonesLoading && !zones.length && <Skeleton width="14rem" />}
        {zoneError && (
          <p className="notice" role="alert">
            Couldn’t load domains. Check Zone Read permission, or continue with
            account resources only.{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => setZoneQuery((query) => ({ ...query }))}
            >
              Retry domains
            </button>
          </p>
        )}
        {!zonesLoading && !zoneError && accountId && !zoneChoices.length && (
          <p className="muted">
            No domains available in this account. You can use account resources
            only.
          </p>
        )}
        <div className="cloudflare-domain-list">
          {zoneChoices
            .filter((zone) =>
              zone.name.toLowerCase().includes(search.toLowerCase()),
            )
            .map((zone) => (
              <label className="check" key={zone.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(zone.id)}
                  disabled={
                    busy ||
                    (!selected.includes(zone.id) && selected.length >= 20)
                  }
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, zone.id]
                        : old.filter((id) => id !== zone.id),
                    )
                  }
                />
                <span>{zone.name}</span>
              </label>
            ))}
        </div>
        {search &&
          !zonesLoading &&
          !zoneChoices.some((zone) =>
            zone.name.toLowerCase().includes(search.toLowerCase()),
          ) && <p className="muted">No matching domains in the loaded list.</p>}
        {moreZones && (
          <button
            type="button"
            className="secondary"
            disabled={zonesLoading || busy}
            onClick={() => setZoneQuery((query) => ({ page: query.page + 1 }))}
          >
            More domains
          </button>
        )}
        <small className="muted">
          {selected.length} of 20 domains selected
          {moreZones ? ". More domains are available." : "."}
        </small>
      </fieldset>
      <ModalActions>
        <button
          type="submit"
          disabled={
            busy ||
            accountsLoading ||
            zonesLoading ||
            !accountId ||
            selected.length > 20
          }
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </form>
  );
}
