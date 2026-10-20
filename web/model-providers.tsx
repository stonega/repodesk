import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_MODEL_MAX_OUTPUT,
  type ModelCurrency,
  modelCurrencies,
  modelLimitOverridesSchema,
  modelOptionsSchema,
  type ThinkingLevel,
  thinkingLevels,
} from "../src/agent/model-settings.ts";
import { withPriceTier } from "../src/model-metadata/normalize.ts";
import {
  type ProviderType,
  providerTypes,
} from "../src/model-metadata/types.ts";
import type {
  ModelSelection,
  ProviderCatalog,
  ProviderView,
  WorkspaceModels,
} from "../src/models/config.ts";
import type { SearchCatalog } from "../src/search/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { modelError } from "./model-errors.ts";
import { AutomaticModelInfo, providerLabels } from "./model-metadata.tsx";
import { SearchProvidersPanel } from "./search-providers.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const catalogPath = "/api/admin/operator/model-providers";

export { modelError } from "./model-errors.ts";
export function selectionFromForm(
  selection: ModelSelection | undefined,
  form: HTMLFormElement,
): ModelSelection {
  if (!selection?.providerId || !selection.model)
    throw new Error("Choose a provider and a model.");
  const values = new FormData(form);
  const context = String(values.get("modelContextWindow") ?? "");
  const output = String(values.get("modelMaxOutput") ?? "");
  const inputPrice = String(values.get("modelInputPrice") ?? "");
  const outputPrice = String(values.get("modelOutputPrice") ?? "");
  const cacheRead = String(values.get("modelCacheReadPrice") ?? "");
  const cacheWrite = String(values.get("modelCacheWritePrice") ?? "");
  const currency = String(
    values.get("modelCurrency") ?? "USD",
  ) as ModelCurrency;
  const usdRate = String(values.get("modelUsdRate") ?? "");
  if (context || output) {
    const parsed = modelLimitOverridesSchema.safeParse({
      ...(context ? { contextWindow: Number(context) } : {}),
      ...(output ? { maxOutputTokens: Number(output) } : {}),
    });
    if (!parsed.success)
      throw new Error(
        parsed.error.issues[0]?.message ?? "Check the model limits.",
      );
  }
  const result = {
    ...selection,
    modelLimits:
      context || output
        ? {
            ...(context ? { contextWindow: Number(context) } : {}),
            ...(output ? { maxOutputTokens: Number(output) } : {}),
          }
        : undefined,
    modelPricing:
      inputPrice || outputPrice || cacheRead || cacheWrite || currency !== "USD"
        ? {
            ...(inputPrice ? { input: Number(inputPrice) } : {}),
            ...(outputPrice ? { output: Number(outputPrice) } : {}),
            ...(cacheRead ? { cacheRead: Number(cacheRead) } : {}),
            ...(cacheWrite ? { cacheWrite: Number(cacheWrite) } : {}),
            ...(currency !== "USD"
              ? { currency, ...(usdRate ? { usdRate: Number(usdRate) } : {}) }
              : {}),
          }
        : undefined,
  };
  const pricing = modelOptionsSchema.shape.modelPricing.safeParse(
    result.modelPricing,
  );
  if (!pricing.success)
    throw new Error(
      pricing.error.issues[0]?.message ?? "Check the token prices.",
    );
  return result;
}
export function ModelPicker({
  request,
  value,
  onChange,
  disabled = false,
  advanced = false,
  autoFocus = false,
}: {
  request: Request;
  value?: ModelSelection;
  onChange: (value: ModelSelection | undefined) => void;
  disabled?: boolean;
  advanced?: boolean;
  autoFocus?: boolean;
}) {
  const fieldId = useId();
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the saved catalog.
  useEffect(() => {
    let active = true;
    setError("");
    void request<ProviderCatalog>(catalogPath)
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((error) => {
        if (active) setError(modelError(error));
      });
    return () => {
      active = false;
    };
  }, [request, retry]);
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || !catalog || focused.current) return;
    focused.current = true;
    const active = document.activeElement;
    if (
      active?.tagName === "DIALOG" ||
      active?.getAttribute("aria-label")?.startsWith("Close")
    ) {
      document.getElementById(`${fieldId}-provider`)?.focus();
    }
  }, [autoFocus, catalog, fieldId]);
  const provider = catalog?.providers?.find((p) => p.id === value?.providerId);
  const currency = value?.modelPricing?.currency ?? "USD";
  const metadata = withPriceTier(
    provider?.modelMetadata?.find((m) => m.id === value?.model),
    value?.modelPriceTier,
  );
  return (
    <>
      <label className="field" htmlFor={`${fieldId}-provider`}>
        <span>Model provider</span>
        <Select
          id={`${fieldId}-provider`}
          aria-label="Model provider"
          value={value?.providerId ?? ""}
          disabled={disabled || !catalog}
          onChange={(event) => {
            onChange(
              event.target.value
                ? {
                    providerId: event.target.value,
                    model: "",
                    ...(advanced ? { thinkingLevel: "off" as const } : {}),
                  }
                : undefined,
            );
          }}
        >
          <option value="">
            {catalog ? "Choose a provider" : "Loading providers…"}
          </option>
          {catalog?.providers?.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="field" htmlFor={`${fieldId}-model`}>
        <span>Model</span>
        <Select
          id={`${fieldId}-model`}
          aria-label="Model"
          value={value?.model ?? ""}
          disabled={disabled || !provider || !provider.models.length}
          onChange={(event) => {
            if (provider)
              onChange({
                providerId: provider.id,
                model: event.target.value,
                ...(advanced
                  ? { thinkingLevel: value?.thinkingLevel ?? ("off" as const) }
                  : {}),
              });
          }}
        >
          <option value="">
            {provider && !provider.models.length
              ? "No models returned"
              : "Choose a model"}
          </option>
          {value?.model &&
            provider &&
            !provider.models.includes(value.model) && (
              <option value={value.model}>{value.model} · unavailable</option>
            )}
          {provider?.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </Select>
      </label>
      {catalog && !catalog.providers?.length && (
        <p className="muted">
          Add a provider in Model settings to fetch its available models.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}{" "}
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {advanced && value && <AutomaticModelInfo metadata={metadata} />}
      {advanced && value && (
        <details
          className="setup-advanced"
          key={`${value.providerId}:${value.model}`}
        >
          <summary>Advanced model settings</summary>
          <p className="muted">
            All overrides are optional. Leave blank to use fetched or catalog
            values. A blank context window lets the provider enforce its limit.
            Unknown models use up to {DEFAULT_MODEL_MAX_OUTPUT.toLocaleString()}{" "}
            output tokens unless overridden. Missing prices remain unknown;
            dollar budgets require both prices. Use 0 for a free model.
          </p>
          {metadata?.pricingTiers && (
            <label className="field" htmlFor={`${fieldId}-price-tier`}>
              <span>Price estimate tier</span>
              <Select
                id={`${fieldId}-price-tier`}
                aria-label="Price estimate tier"
                value={value.modelPriceTier ?? "peak"}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    modelPriceTier: event.target.value as "peak" | "off_peak",
                  })
                }
              >
                {metadata.pricingTiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.label}
                  </option>
                ))}
              </Select>
              <span className="muted">
                Peak is the conservative default. Choose Off-peak only for
                discounted usage estimates; the actual rate depends on the
                provider’s billing time.
              </span>
            </label>
          )}
          <label className="field" htmlFor={`${fieldId}-thinking`}>
            <span>Thinking level</span>
            <Select
              id={`${fieldId}-thinking`}
              aria-label="Thinking level"
              value={value.thinkingLevel ?? "off"}
              onChange={(event) =>
                onChange({
                  ...value,
                  thinkingLevel: event.target.value as ThinkingLevel,
                })
              }
              disabled={disabled}
            >
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </label>
          <div className="columns">
            <label className="field">
              <span>Model context window (tokens)</span>
              <input
                name="modelContextWindow"
                type="number"
                min="1"
                step="1"
                disabled={disabled}
                defaultValue={value.modelLimits?.contextWindow ?? ""}
                placeholder="Provider default (optional)"
              />
            </label>
            <label className="field">
              <span>Model maximum output (tokens)</span>
              <input
                name="modelMaxOutput"
                type="number"
                min="1"
                step="1"
                disabled={disabled}
                defaultValue={value.modelLimits?.maxOutputTokens ?? ""}
                placeholder="Automatic (optional)"
              />
            </label>
            <label className="field" htmlFor={`${fieldId}-currency`}>
              <span>Price currency</span>
              <Select
                id={`${fieldId}-currency`}
                name="modelCurrency"
                aria-label="Price currency"
                value={currency}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    modelPricing: {
                      ...value.modelPricing,
                      currency: event.target.value as ModelCurrency,
                      usdRate: undefined,
                    },
                  })
                }
              >
                {modelCurrencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </label>
            {currency !== "USD" && (
              <label className="field">
                <span>USD exchange rate (1 {currency} = USD)</span>
                <input
                  key={currency}
                  name="modelUsdRate"
                  type="number"
                  min="0"
                  max="10000"
                  step="any"
                  disabled={disabled}
                  defaultValue={value.modelPricing?.usdRate ?? ""}
                  aria-describedby={`${fieldId}-currency-help`}
                />
              </label>
            )}
            <label className="field">
              <span>Input price ({currency} / million tokens)</span>
              <input
                name="modelInputPrice"
                type="number"
                min="0"
                step="any"
                disabled={disabled}
                defaultValue={value.modelPricing?.input ?? ""}
                placeholder="Automatic (optional)"
              />
            </label>
            <label className="field">
              <span>Output price ({currency} / million tokens)</span>
              <input
                name="modelOutputPrice"
                type="number"
                min="0"
                step="any"
                disabled={disabled}
                defaultValue={value.modelPricing?.output ?? ""}
                placeholder="Automatic (optional)"
              />
            </label>
            {(["cacheRead", "cacheWrite"] as const).map((key) => (
              <label className="field" key={key}>
                <span>
                  {key === "cacheRead" ? "Input cache-hit" : "Cache write"}{" "}
                  price ({currency} / million tokens)
                </span>
                <input
                  name={
                    key === "cacheRead"
                      ? "modelCacheReadPrice"
                      : "modelCacheWritePrice"
                  }
                  type="number"
                  min="0"
                  step="any"
                  disabled={disabled}
                  defaultValue={value.modelPricing?.[key] ?? ""}
                  placeholder="Automatic (optional)"
                />
              </label>
            ))}
          </div>
          <p className="muted" id={`${fieldId}-currency-help`}>
            Currency applies to entered prices. Catalog prices, budgets and
            usage totals use USD. For another currency, enter the USD value of
            one unit; the saved exchange rate is used for accounting until you
            edit it.
          </p>
        </details>
      )}
    </>
  );
}
export function ModelProvidersPanel({
  request,
  workspaceId,
  legacyModel,
  onContinue,
  onPending,
  onSaved,
}: {
  request: Request;
  workspaceId: string;
  legacyModel?: string;
  onContinue?: () => void;
  onPending?: (pending: boolean) => void;
  onSaved?: () => void;
}) {
  const path = `/api/admin/workspaces/${workspaceId}/models`;
  const [page, setPage] = useState<WorkspaceModels>();
  const [searchCatalog, setSearchCatalog] = useState<SearchCatalog>();
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const modelFeedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) modelFeedback.current?.scrollIntoView({ block: "nearest" });
  }, [formError]);
  const [busy, setBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState<{
    original?: ProviderView;
    version: number;
    type?: ProviderType;
  }>();
  const [removing, setRemoving] = useState<ProviderView>();
  const [editingModel, setEditingModel] = useState(false);
  const [selection, setSelection] = useState<ModelSelection>();
  const [retry, setRetry] = useState(0);
  const notify = useToast();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the saved workspace configuration.
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setSearchCatalog(undefined);
    setError("");
    setProviderDraft(undefined);
    setRemoving(undefined);
    setEditingModel(false);
    void Promise.all([
      request<WorkspaceModels>(path),
      request<SearchCatalog>("/api/admin/operator/search-providers"),
    ])
      .then(([value, searches]) => {
        if (active) {
          setPage(value);
          setSearchCatalog(searches);
          setSelection(value.selection ?? undefined);
        }
      })
      .catch((error) => {
        if (active) setError(modelError(error));
      });
    return () => {
      active = false;
    };
  }, [path, request, retry]);
  const pending = (value: boolean) => {
    setBusy(value);
    onPending?.(value);
  };
  const saveChat = async (form: HTMLFormElement) => {
    if (!page || busy) return;
    pending(true);
    setFormError("");
    try {
      const result = await request<WorkspaceModels>(path, "PUT", {
        revision: page.revision,
        selection: selectionFromForm(selection, form),
        searchProviderId: new FormData(form).get("searchProviderId") || null,
      });
      setPage(result);
      setSearchCatalog((current) =>
        current ? { ...current, version: result.version } : current,
      );
      setSelection(result.selection ?? undefined);
      setEditingModel(false);
      notify("Chat model saved.");
      onSaved?.();
      onContinue?.();
    } catch (error) {
      setFormError(modelError(error));
    } finally {
      pending(false);
    }
  };
  const selectedProvider = page?.providers.find(
    (p) => p.id === page.selection?.providerId,
  );
  const modelForm = (
    <form
      id="setup-model-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void saveChat(event.currentTarget);
      }}
    >
      <fieldset className="plugin-fields" disabled={busy || !page}>
        <ModelPicker
          key={page?.version ?? "loading"}
          request={request}
          value={selection}
          onChange={setSelection}
          advanced
          autoFocus={!onContinue}
          disabled={busy}
        />
        <label className="field" htmlFor="chat-search-provider">
          <span>Search provider</span>
          <Select
            id="chat-search-provider"
            name="searchProviderId"
            aria-label="Search provider"
            defaultValue={page?.searchProviderId ?? ""}
            disabled={busy || !searchCatalog}
          >
            <option value="">Disabled</option>
            {searchCatalog?.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
          <small className="muted">
            Allows the chat model to search the public web when needed.
          </small>
        </label>
        <div ref={modelFeedback}>
          {formError && (
            <p className="notice" role="alert">
              {formError}
            </p>
          )}
          {!onContinue && (
            <ModalActions>
              <button type="submit" disabled={!selection?.model || busy}>
                {busy ? "Saving…" : "Save chat model"}
              </button>
            </ModalActions>
          )}
        </div>
      </fieldset>
    </form>
  );
  return (
    <>
      {error && (
        <ErrorToast message={error}>
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card model-settings-card"
        aria-label="Model providers"
        aria-busy={!page}
      >
        <div className="card-heading">
          <h2>Model providers</h2>
          <IconButton
            icon="add"
            label="New model provider"
            showLabel
            disabled={!page || busy}
            onClick={() => {
              if (page) {
                setProviderDraft({ version: page.version });
                setFormError("");
              }
            }}
          />
        </div>
        <p className="muted">
          Save each OpenAI-compatible API provider once. Chat, Codex and Code
          Review can reuse its models across your workspaces.
        </p>
        {!page ? (
          <SkeletonRows label="Model providers" />
        ) : page.providers.length ? (
          <ul className="settings-list">
            {page.providers.map((provider) => (
              <li
                className="settings-item model-provider-item"
                key={provider.id}
              >
                <div className="settings-item-details">
                  <h3>{provider.name}</h3>
                  <p className="settings-item-value">{provider.baseUrl}</p>
                  <p className="muted">
                    {providerLabels[provider.type ?? "auto"]} · API key
                    configured · {provider.models.length} models
                  </p>
                  {provider.metadataWarning && (
                    <p className="muted">
                      {provider.metadataWarning === "newapi_group_required"
                        ? "Choose the API key’s billing group in Edit to fetch token prices."
                        : "Pricing API unavailable. Models remain available; use price overrides."}
                    </p>
                  )}
                </div>
                <div className="row">
                  <IconButton
                    icon="edit"
                    label={`Edit ${provider.name}`}
                    disabled={busy}
                    onClick={() => {
                      setProviderDraft({
                        original: provider,
                        version: page.version,
                      });
                      setFormError("");
                    }}
                  />
                  <IconButton
                    icon="delete"
                    label={`Remove ${provider.name}`}
                    disabled={busy}
                    onClick={() => {
                      setRemoving(provider);
                      setFormError("");
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No providers yet. Choose New to enter an API URL and key, then fetch
            its models.
          </p>
        )}
      </section>
      <SearchProvidersPanel
        request={request}
        catalog={searchCatalog}
        busy={busy}
        onPending={pending}
        onSaved={(catalog) => {
          setSearchCatalog(catalog);
          setPage((current) =>
            current ? { ...current, version: catalog.version } : current,
          );
        }}
      />
      <section className="card" aria-label="Bot chat model" aria-busy={!page}>
        <div className="row team-card-heading">
          <h2>Bot chat model</h2>
          {!onContinue && (
            <IconButton
              icon="edit"
              label="Edit chat model"
              disabled={!page || busy}
              onClick={() => {
                setSelection(page?.selection ?? undefined);
                setFormError("");
                setEditingModel(true);
              }}
            />
          )}
        </div>
        {onContinue ? (
          modelForm
        ) : (
          <>
            <dl className="plugin-summary">
              <div>
                <dt>Search provider</dt>
                <dd>
                  {page && searchCatalog ? (
                    (searchCatalog.providers.find(
                      (p) => p.id === page.searchProviderId,
                    )?.name ??
                    (page.searchProviderId ? "Unavailable" : "Disabled"))
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>
                  {page ? (
                    (selectedProvider?.name ??
                    (page.legacy
                      ? "Previous deployment configuration"
                      : "Not selected"))
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  {page ? (
                    (page.selection?.model ??
                    (page.legacy ? legacyModel : "Not selected"))
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Thinking</dt>
                <dd>
                  {page ? (
                    (page.selection?.thinkingLevel ?? "off")
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              {selectedProvider?.modelMetadata?.find(
                (m) => m.id === page?.selection?.model,
              )?.pricingTiers && (
                <div>
                  <dt>Price estimate tier</dt>
                  <dd>
                    {page?.selection?.modelPriceTier === "off_peak"
                      ? "Off-peak"
                      : "Peak (default)"}
                  </dd>
                </div>
              )}
              <div>
                <dt>Context window</dt>
                <dd>
                  {page ? (
                    (page.selection?.modelLimits?.contextWindow?.toLocaleString() ??
                    "Provider default")
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Maximum output</dt>
                <dd>
                  {page ? (
                    (page.selection?.modelLimits?.maxOutputTokens?.toLocaleString() ??
                    "Automatic")
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Input price</dt>
                <dd>
                  {page ? (
                    page.selection?.modelPricing?.input !== undefined ? (
                      `${page.selection.modelPricing.input} ${page.selection.modelPricing.currency ?? "USD"} / million tokens`
                    ) : (
                      "Automatic"
                    )
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              <div>
                <dt>Output price</dt>
                <dd>
                  {page ? (
                    page.selection?.modelPricing?.output !== undefined ? (
                      `${page.selection.modelPricing.output} ${page.selection.modelPricing.currency ?? "USD"} / million tokens`
                    ) : (
                      "Automatic"
                    )
                  ) : (
                    <Skeleton />
                  )}
                </dd>
              </div>
              {(["cacheRead", "cacheWrite"] as const).map((key) => (
                <div key={key}>
                  <dt>
                    {key === "cacheRead"
                      ? "Cache-hit input price"
                      : "Cache write price"}
                  </dt>
                  <dd>
                    {!page ? (
                      <Skeleton />
                    ) : page.selection?.modelPricing?.[key] === undefined ? (
                      "Automatic"
                    ) : (
                      `${page.selection.modelPricing[key]} ${page.selection.modelPricing.currency ?? "USD"} / million tokens`
                    )}
                  </dd>
                </div>
              ))}
              {(!page ||
                (page.selection?.modelPricing?.currency !== undefined &&
                  page.selection.modelPricing.currency !== "USD")) && (
                <div>
                  <dt>USD exchange rate</dt>
                  <dd>
                    {page ? (
                      `1 ${page.selection?.modelPricing?.currency} = ${page.selection?.modelPricing?.usdRate} USD`
                    ) : (
                      <Skeleton />
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <AutomaticModelInfo
              metadata={withPriceTier(
                selectedProvider?.modelMetadata?.find(
                  (m) => m.id === page?.selection?.model,
                ),
                page?.selection?.modelPriceTier,
              )}
            />
          </>
        )}
      </section>
      {editingModel && (
        <Modal
          title="Edit chat model"
          busy={busy}
          onClose={() => setEditingModel(false)}
        >
          {modelForm}
        </Modal>
      )}
      {providerDraft && (
        <Modal
          title={
            providerDraft.original
              ? "Edit model provider"
              : "New model provider"
          }
          busy={busy}
          onClose={() => setProviderDraft(undefined)}
        >
          <p className="muted">
            Saving fetches models and available prices and context metadata.
            Choose New API for a self-hosted New API server. The API key is
            encrypted and is never shown after saving.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              const values = new FormData(event.currentTarget);
              const key = String(values.get("apiKey") ?? "").trim();
              pending(true);
              setFormError("");
              try {
                const catalog = await request<ProviderCatalog>(
                  catalogPath,
                  "PUT",
                  {
                    version: providerDraft.version,
                    id: providerDraft.original?.id,
                    name: values.get("name"),
                    baseUrl: values.get("baseUrl"),
                    type: values.get("type"),
                    ...(String(values.get("pricingGroup") ?? "").trim()
                      ? {
                          pricingGroup: String(
                            values.get("pricingGroup"),
                          ).trim(),
                        }
                      : {}),
                    ...(key ? { apiKey: key } : {}),
                  },
                );
                if (page) setPage({ ...page, ...catalog });
                setSearchCatalog((current) =>
                  current ? { ...current, version: catalog.version } : current,
                );
                if (!providerDraft.original && !selection) {
                  const created = catalog.providers.find(
                    (p) => !page?.providers.some((old) => old.id === p.id),
                  );
                  if (created)
                    setSelection({
                      providerId: created.id,
                      model: "",
                      thinkingLevel: "off",
                    });
                }
                setProviderDraft(undefined);
                notify("Model provider saved.");
              } catch (error) {
                setFormError(modelError(error));
              } finally {
                pending(false);
              }
            }}
          >
            <fieldset className="plugin-fields" disabled={busy}>
              <label className="field" htmlFor="provider-type">
                <span>Provider type</span>
                <Select
                  id="provider-type"
                  name="type"
                  aria-label="Provider type"
                  value={
                    providerDraft.type ?? providerDraft.original?.type ?? "auto"
                  }
                  onChange={(event) =>
                    setProviderDraft({
                      ...providerDraft,
                      type: event.target.value as ProviderType,
                    })
                  }
                >
                  {providerTypes.map((type) => (
                    <option key={type} value={type}>
                      {providerLabels[type]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="field">
                <span>Provider name</span>
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={providerDraft.original?.name ?? ""}
                  placeholder="My provider"
                />
              </label>
              <label className="field">
                <span>API base URL</span>
                <input
                  name="baseUrl"
                  type="url"
                  required
                  maxLength={2048}
                  defaultValue={
                    providerDraft.original?.baseUrl ??
                    "https://api.openai.com/v1"
                  }
                />
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  required={!providerDraft.original}
                  maxLength={8192}
                  placeholder={
                    providerDraft.original
                      ? "Leave blank to keep saved key"
                      : "Provider API key"
                  }
                />
              </label>
              {(providerDraft.type ?? providerDraft.original?.type) ===
                "newapi" && (
                <label className="field">
                  <span>New API billing group (optional)</span>
                  <input
                    name="pricingGroup"
                    maxLength={100}
                    defaultValue={providerDraft.original?.pricingGroup ?? ""}
                    placeholder="For example: default"
                  />
                  <span className="muted">
                    Enter the group assigned to this API key. Group multipliers
                    affect prices. Leave blank to keep prices unknown. The
                    public pricing endpoint must be enabled.
                  </span>
                </label>
              )}
              {formError && (
                <p className="notice" role="alert">
                  {formError}
                </p>
              )}
              <ModalActions>
                <button type="submit">
                  {busy ? "Fetching models…" : "Save provider"}
                </button>
              </ModalActions>
            </fieldset>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Remove model provider"
          busy={busy}
          onClose={() => setRemoving(undefined)}
        >
          <p>
            Remove {removing.name}? Choose another provider in any service using
            it first.
          </p>
          {formError && (
            <p className="notice" role="alert">
              {formError}
            </p>
          )}
          <ModalActions>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                if (!page || busy) return;
                pending(true);
                setFormError("");
                try {
                  const catalog = await request<ProviderCatalog>(
                    `${catalogPath}/${removing.id}`,
                    "DELETE",
                    { version: page.version },
                  );
                  setPage({ ...page, ...catalog });
                  setSearchCatalog((current) =>
                    current
                      ? { ...current, version: catalog.version }
                      : current,
                  );
                  setRemoving(undefined);
                  notify("Model provider removed.");
                } catch (error) {
                  setFormError(modelError(error));
                } finally {
                  pending(false);
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
