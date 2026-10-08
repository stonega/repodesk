import { useEffect, useId, useRef, useState } from "react";
import {
  modelLimitsSchema,
  type ThinkingLevel,
  thinkingLevels,
} from "../src/agent/model-settings.ts";
import type {
  ModelSelection,
  ProviderCatalog,
  ProviderView,
  WorkspaceModels,
} from "../src/models/config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const catalogPath = "/api/admin/operator/model-providers";
export function modelError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    {
      model_provider_auth_failed:
        "The provider rejected the API key. Check the key and try again.",
      model_discovery_failed:
        "Could not fetch models. Check the API base URL and try again.",
      model_discovery_invalid: "The provider did not return a model list.",
      model_provider_in_use:
        "Choose another provider for each service before removing this one.",
      model_not_available:
        "The selected model is no longer in the provider's model list.",
      custom_model_pricing_required:
        "Enter both token prices in Advanced model settings for this custom model.",
      model_limits_required:
        "Enter the context window and maximum output in Advanced model settings for this custom model.",
      new_endpoint_requires_api_key:
        "Enter the API key again when changing the provider URL.",
      version_conflict:
        "Settings changed. Reload saved settings and try again.",
    }[code.split(".")[0] ?? code] ?? code
  );
}
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
  if (!!context !== !!output) throw new Error("Enter both model limits.");
  if (!!inputPrice !== !!outputPrice)
    throw new Error("Enter both token prices.");
  if (context && output) {
    const parsed = modelLimitsSchema.safeParse({
      contextWindow: Number(context),
      maxOutputTokens: Number(output),
    });
    if (!parsed.success)
      throw new Error(
        parsed.error.issues[0]?.message ?? "Check the model limits.",
      );
  }
  return {
    ...selection,
    modelLimits:
      context && output
        ? { contextWindow: Number(context), maxOutputTokens: Number(output) }
        : undefined,
    modelPricing:
      inputPrice && outputPrice
        ? { input: Number(inputPrice), output: Number(outputPrice) }
        : undefined,
  };
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
      {advanced && value && (
        <details
          className="setup-advanced"
          key={`${value.providerId}:${value.model}`}
        >
          <summary>Advanced model settings</summary>
          <p className="muted">
            Known models use catalog capacity and token prices. For a custom
            model, enter its documented limits and prices. Use 0 for a free
            model.
          </p>
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
                placeholder="Catalog value"
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
                placeholder="Catalog value"
              />
            </label>
            <label className="field">
              <span>Input price (USD / million tokens)</span>
              <input
                name="modelInputPrice"
                type="number"
                min="0"
                step="any"
                disabled={disabled}
                defaultValue={value.modelPricing?.input ?? ""}
                placeholder="Catalog price"
              />
            </label>
            <label className="field">
              <span>Output price (USD / million tokens)</span>
              <input
                name="modelOutputPrice"
                type="number"
                min="0"
                step="any"
                disabled={disabled}
                defaultValue={value.modelPricing?.output ?? ""}
                placeholder="Catalog price"
              />
            </label>
          </div>
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
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [providerDraft, setProviderDraft] = useState<{
    original?: ProviderView;
    version: number;
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
    setError("");
    setProviderDraft(undefined);
    setRemoving(undefined);
    setEditingModel(false);
    void request<WorkspaceModels>(path)
      .then((value) => {
        if (active) {
          setPage(value);
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
      });
      setPage(result);
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
      <section className="card" aria-label="Model providers" aria-busy={!page}>
        <div className="row team-card-heading">
          <div>
            <h2>Model providers</h2>
            <p className="muted">
              Save each OpenAI-compatible API provider once. Chat, Codex and
              Code Review can reuse its models across your workspaces.
            </p>
          </div>
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
                    API key configured · {provider.models.length} models
                  </p>
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
          <dl className="plugin-summary">
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
                {page ? (page.selection?.thinkingLevel ?? "off") : <Skeleton />}
              </dd>
            </div>
            <div>
              <dt>Context window</dt>
              <dd>
                {page ? (
                  (page.selection?.modelLimits?.contextWindow.toLocaleString() ??
                  "Catalog")
                ) : (
                  <Skeleton />
                )}
              </dd>
            </div>
            <div>
              <dt>Maximum output</dt>
              <dd>
                {page ? (
                  (page.selection?.modelLimits?.maxOutputTokens.toLocaleString() ??
                  "Catalog")
                ) : (
                  <Skeleton />
                )}
              </dd>
            </div>
            <div>
              <dt>Input price</dt>
              <dd>
                {page ? (
                  page.selection?.modelPricing ? (
                    `$${page.selection.modelPricing.input} / million tokens`
                  ) : (
                    "Catalog"
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
                  page.selection?.modelPricing ? (
                    `$${page.selection.modelPricing.output} / million tokens`
                  ) : (
                    "Catalog"
                  )
                ) : (
                  <Skeleton />
                )}
              </dd>
            </div>
          </dl>
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
            Saving fetches the model list from this provider. The API key is
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
                    ...(key ? { apiKey: key } : {}),
                  },
                );
                if (page) setPage({ ...page, ...catalog });
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
