import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import { modelCapabilities, selectedModel } from "../agent/runtime.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import { discoverModels, MetadataError } from "../model-metadata/discover.ts";
import { withPriceTier } from "../model-metadata/normalize.ts";
import {
  DUCKDUCKGO_PRESET_ID,
  searchProviderIdSchema,
} from "../search/config.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import {
  discoveryInput,
  type ModelProvider,
  type ModelSelection,
  modelSelectionSchema,
  type ProviderCatalog,
  providerInput,
  type RuntimeProvider,
  type WorkspaceModels,
} from "./config.ts";

export type ModelTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export function providerView(provider: ModelProvider) {
  const { credential, operatorId: _operatorId, ...safe } = provider;
  return { ...safe, apiKeyConfigured: !!credential };
}
export function providerModelOptions(
  provider: ModelProvider,
  selection: ModelSelection,
) {
  return {
    ...selection,
    modelBaseUrl: provider.baseUrl,
    modelMetadata: withPriceTier(
      provider.modelMetadata?.find((m) => m.id === selection.model),
      selection.modelPriceTier,
    ),
  };
}
export class ModelProviders {
  constructor(
    private store: Store,
    private key: string,
    private transport: ModelTransport = fetch,
  ) {}
  private aad(provider: Pick<ModelProvider, "id" | "operatorId">) {
    return `model-provider:${provider.operatorId}:${provider.id}`;
  }
  async catalog(admin: Admin): Promise<ProviderCatalog> {
    operator(admin);
    const d = await this.store.deployment();
    return {
      version: d.version,
      providers: (d.modelProviders ?? [])
        .filter((p) => p.operatorId === admin.id)
        .map(providerView),
    };
  }
  async discover(admin: Admin, value: unknown) {
    operator(admin);
    const input = discoveryInput.parse(value);
    const d = await this.store.deployment();
    requireThat(d.version === input.version, "version_conflict", 409);
    const existing = input.id
      ? d.modelProviders?.find(
          (p) => p.id === input.id && p.operatorId === admin.id,
        )
      : undefined;
    requireThat(!input.id || existing, "model_provider_not_found", 404);
    requireThat(
      !existing || input.baseUrl === existing.baseUrl || input.apiKey,
      "new_endpoint_requires_api_key",
    );
    const key =
      input.apiKey ??
      (existing
        ? decrypt(this.key, this.aad(existing), existing.credential)
        : undefined);
    requireThat(key, "model_provider_key_required");
    try {
      return await discoverModels(
        {
          baseUrl: input.baseUrl,
          apiKey: key,
          type: input.type ?? existing?.type,
          pricingGroup: input.pricingGroup,
        },
        this.transport,
      );
    } catch (error) {
      if (error instanceof MetadataError)
        throw new Fault(
          error.code,
          error.code === "model_provider_auth_failed" ? 400 : 502,
        );
      if (error instanceof Fault) throw error;
      throw new Fault("model_discovery_failed", 502);
    }
  }
  async save(admin: Admin, value: unknown) {
    operator(admin);
    const input = providerInput.parse(value);
    const discovered = await this.discover(admin, {
      version: input.version,
      id: input.id,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      type: input.type,
      pricingGroup: input.pricingGroup,
    });
    await transaction(this.store.pool, async (sql) => {
      const d = await this.store.deployment(sql, true);
      requireThat(d.version === input.version, "version_conflict", 409);
      const existing = d.modelProviders?.find(
        (p) => p.id === input.id && p.operatorId === admin.id,
      );
      const id = existing?.id ?? randomUUID();
      const provider: ModelProvider = {
        id,
        operatorId: admin.id,
        version: (existing?.version ?? 0) + 1,
        name: input.name,
        pricingGroup: input.pricingGroup,
        baseUrl: input.baseUrl,
        credential: input.apiKey
          ? encrypt(
              this.key,
              this.aad({ id, operatorId: admin.id }),
              input.apiKey,
            )
          : (existing?.credential ?? ""),
        ...discovered,
      };
      d.modelProviders = [
        ...(d.modelProviders ?? []).filter((p) => p.id !== id),
        provider,
      ];
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'model_provider.saved',$2)",
        [admin.id, id],
      );
    });
    return this.catalog(admin);
  }
  async remove(admin: Admin, id: string, version: number) {
    operator(admin);
    await transaction(this.store.pool, async (sql) => {
      const d = await this.store.deployment(sql, true);
      requireThat(d.version === version, "version_conflict", 409);
      requireThat(
        d.modelProviders?.some((p) => p.id === id && p.operatorId === admin.id),
        "model_provider_not_found",
        404,
      );
      const workspaces = await sql.query(
        "SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE",
        [admin.id],
      );
      requireThat(
        !workspaces.rows.some(
          ({ data: w }: { data: Workspace }) =>
            !w.deletion &&
            [
              w.chatModel?.selection,
              w.coding?.settings.authMode === "provider_key"
                ? w.coding.settings.model
                : undefined,
              w.reviewBot?.settings.model,
            ].some((m) => m?.providerId === id),
        ),
        "model_provider_in_use",
        409,
      );
      d.modelProviders = d.modelProviders?.filter((p) => p.id !== id);
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'model_provider.removed',$2)",
        [admin.id, id],
      );
    });
    return this.catalog(admin);
  }
  async selected(workspace: Workspace, selection: ModelSelection) {
    const parsed = modelSelectionSchema.parse(selection);
    const d = await this.store.deployment();
    const provider = d.modelProviders?.find(
      (p) =>
        p.id === parsed.providerId && p.operatorId === workspace.operatorId,
    );
    requireThat(
      !workspace.deletion && provider,
      "model_provider_not_found",
      404,
    );
    requireThat(
      provider.models.includes(parsed.model),
      "model_not_available",
      409,
    );
    requireThat(
      !parsed.modelPriceTier ||
        provider.modelMetadata
          ?.find((m) => m.id === parsed.model)
          ?.pricingTiers?.some((tier) => tier.id === parsed.modelPriceTier),
      "model_price_tier_unavailable",
      409,
    );
    return { provider, selection: parsed };
  }
  async workspace(admin: Admin, id: string): Promise<WorkspaceModels> {
    operator(admin);
    const w = await this.store.read(id);
    requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
    const d = await this.store.deployment();
    const selection = w.chatModel?.selection ?? null;
    return {
      ...(await this.catalog(admin)),
      revision: w.chatModel?.revision ?? 0,
      selection,
      searchProviderId: w.chatModel?.searchProviderId ?? null,
      legacy: !selection && !!d.credentials.model,
      configured: !!selection || !!d.credentials.model,
    };
  }
  async saveChat(admin: Admin, id: string, value: unknown) {
    operator(admin);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        selection: modelSelectionSchema,
        searchProviderId: searchProviderIdSchema.nullable().optional(),
      })
      .strict()
      .parse(value);
    const w = await this.store.read(id);
    requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
    await this.store.change(id, async (current) => {
      requireThat(
        current.operatorId === admin.id && !current.deletion,
        "access_denied",
        403,
      );
      requireThat(
        (current.chatModel?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const { provider } = await this.selected(current, input.selection);
      const searchProviderId =
        input.searchProviderId === undefined
          ? current.chatModel?.searchProviderId
          : (input.searchProviderId ?? undefined);
      if (searchProviderId && searchProviderId !== DUCKDUCKGO_PRESET_ID) {
        const d = await this.store.deployment();
        requireThat(
          d.searchProviders?.some(
            (p) =>
              p.id === searchProviderId && p.operatorId === current.operatorId,
          ),
          "search_provider_not_found",
          404,
        );
      }
      selectedModel(
        input.selection.model,
        providerModelOptions(provider, input.selection),
      );
      current.chatModel = {
        revision: input.revision + 1,
        selection: input.selection,
        searchProviderId,
      };
    });
    return this.workspace(admin, id);
  }
  async chat(workspace: Workspace) {
    if (!workspace.chatModel) return undefined;
    const { provider, selection } = await this.selected(
      workspace,
      workspace.chatModel.selection,
    );
    const options = providerModelOptions(provider, selection);
    const capabilities = modelCapabilities(selection.model, options);
    return {
      model: selection.model,
      options: {
        ...options,
        modelLimits: capabilities?.limits,
        providerContext: selection.modelLimits?.contextWindow === undefined,
      },
      provider: {
        id: provider.id,
        version: provider.version,
        operatorId: provider.operatorId,
        chatRevision: workspace.chatModel.revision,
      },
    };
  }
  async modelKey(operatorId: string, id: string, version: number) {
    const d = await this.store.deployment();
    const provider = d.modelProviders?.find(
      (p) => p.id === id && p.operatorId === operatorId,
    );
    requireThat(
      provider && provider.version === version,
      "model_provider_changed",
      409,
    );
    return decrypt(this.key, this.aad(provider), provider.credential);
  }
  async runner(
    workspace: Workspace,
    selection?: ModelSelection,
    pinned?: RuntimeProvider,
  ) {
    if (!selection) return {};
    const { provider } = await this.selected(workspace, selection);
    if (pinned)
      requireThat(
        pinned.id === provider.id &&
          pinned.version === provider.version &&
          pinned.baseUrl === provider.baseUrl &&
          pinned.model === selection.model,
        "model_provider_changed",
        409,
      );
    const thinking = selection.thinkingLevel;
    const modelProvider: RuntimeProvider = pinned ?? {
      id: provider.id,
      version: provider.version,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: selection.model,
      reasoningEffort: thinking && thinking !== "off" ? thinking : undefined,
    };
    return {
      modelProvider,
      providerApiKey: decrypt(
        this.key,
        this.aad(provider),
        provider.credential,
      ),
    };
  }
}
