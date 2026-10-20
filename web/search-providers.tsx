import { useState } from "react";
import {
  type SearchCatalog,
  type SearchProviderView,
  type SearchType,
  searchLabels,
  searchTypes,
} from "../src/search/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { modelError } from "./model-errors.ts";
import { Select } from "./select.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const path = "/api/admin/operator/search-providers";
export function SearchProvidersPanel({
  request,
  catalog,
  busy,
  onPending,
  onSaved,
}: {
  request: Request;
  catalog?: SearchCatalog;
  busy: boolean;
  onPending: (pending: boolean) => void;
  onSaved: (catalog: SearchCatalog) => void;
}) {
  const [draft, setDraft] = useState<{
    original?: SearchProviderView;
    type: SearchType;
    version: number;
  }>();
  const [removing, setRemoving] = useState<SearchProviderView>();
  const [error, setError] = useState("");
  const notify = useToast();
  return (
    <>
      <section
        className="card model-settings-card"
        aria-label="Search providers"
        aria-busy={!catalog}
      >
        <div className="card-heading">
          <h2>Search providers</h2>
          <IconButton
            icon="add"
            label="New search provider"
            showLabel
            disabled={!catalog || busy}
            onClick={() => {
              if (catalog) {
                setError("");
                setDraft({ type: "duckduckgo", version: catalog.version });
              }
            }}
          />
        </div>
        <p className="muted">
          Connect a search provider, then choose it for the bot chat model.
          DuckDuckGo is free; DeepSeek and Exa use an API key.
        </p>
        {!catalog ? (
          <SkeletonRows label="Search providers" />
        ) : catalog.providers.length ? (
          <ul className="settings-list">
            {catalog.providers.map((p) => (
              <li className="settings-item model-provider-item" key={p.id}>
                <div className="settings-item-details">
                  <h3>{p.name}</h3>
                  <p className="muted">
                    {searchLabels[p.type]} ·{" "}
                    {p.type === "duckduckgo"
                      ? "No API key required"
                      : "API key configured"}
                  </p>
                </div>
                <div className="row">
                  <IconButton
                    icon="edit"
                    label={`Edit search provider ${p.name}`}
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setDraft({
                        original: p,
                        type: p.type,
                        version: catalog.version,
                      });
                    }}
                  />
                  <IconButton
                    icon="delete"
                    label={`Remove search provider ${p.name}`}
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setRemoving(p);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>No search providers yet. Choose New to add one.</p>
        )}
      </section>
      {draft && (
        <Modal
          title={
            draft.original ? "Edit search provider" : "New search provider"
          }
          busy={busy}
          onClose={() => setDraft(undefined)}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              const values = new FormData(event.currentTarget);
              const key = String(values.get("apiKey") ?? "").trim();
              onPending(true);
              setError("");
              try {
                const result = await request<SearchCatalog>(path, "PUT", {
                  version: draft.version,
                  id: draft.original?.id,
                  name: values.get("name"),
                  type: draft.type,
                  ...(key ? { apiKey: key } : {}),
                });
                onSaved(result);
                setDraft(undefined);
                notify("Search provider saved.");
              } catch (error) {
                setError(modelError(error));
              } finally {
                onPending(false);
              }
            }}
          >
            <fieldset className="plugin-fields" disabled={busy}>
              <label className="field">
                <span>Provider name</span>
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={draft.original?.name ?? ""}
                  placeholder="Web search"
                />
              </label>
              <label className="field" htmlFor="search-provider-type">
                <span>Search provider type</span>
                <Select
                  id="search-provider-type"
                  aria-label="Search provider type"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft({ ...draft, type: e.target.value as SearchType })
                  }
                >
                  {searchTypes.map((type) => (
                    <option key={type} value={type}>
                      {searchLabels[type]}
                    </option>
                  ))}
                </Select>
              </label>
              {draft.type !== "duckduckgo" && (
                <label className="field">
                  <span>API key</span>
                  <input
                    key={draft.type}
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    required={
                      !draft.original || draft.original.type !== draft.type
                    }
                    placeholder={
                      draft.original?.type === draft.type
                        ? "Leave blank to keep saved key"
                        : "Provider API key"
                    }
                  />
                </label>
              )}
              <p className="muted">
                {draft.type === "duckduckgo"
                  ? "Free search uses DuckDuckGo’s public results page. Rate limits or challenges can temporarily prevent searches."
                  : "The API key is encrypted and never shown after saving. Search request fees are billed by the provider separately from model token budgets."}
              </p>
              {error && (
                <p className="notice" role="alert">
                  {error}
                </p>
              )}
              <ModalActions>
                <button type="submit">
                  {busy ? "Saving…" : "Save search provider"}
                </button>
              </ModalActions>
            </fieldset>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Remove search provider"
          busy={busy}
          onClose={() => setRemoving(undefined)}
        >
          <p>
            Remove {removing.name}? Choose another search provider or disable
            search in each chat model using it first.
          </p>
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <ModalActions>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                if (!catalog || busy) return;
                onPending(true);
                setError("");
                try {
                  onSaved(
                    await request<SearchCatalog>(
                      `${path}/${removing.id}`,
                      "DELETE",
                      { version: catalog.version },
                    ),
                  );
                  setRemoving(undefined);
                  notify("Search provider removed.");
                } catch (error) {
                  setError(modelError(error));
                } finally {
                  onPending(false);
                }
              }}
            >
              {busy ? "Removing…" : "Remove provider"}
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
