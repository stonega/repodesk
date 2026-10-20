import { randomUUID } from "node:crypto";
import { operator } from "../admin/auth.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import {
  type SearchCatalog,
  type SearchPin,
  type SearchProvider,
  searchInput,
} from "./config.ts";
import { type SearchTransport, searchWeb } from "./providers.ts";

export class SearchProviders {
  constructor(
    private store: Store,
    private key: string,
    private transport: SearchTransport = fetch,
  ) {}
  private aad(p: Pick<SearchProvider, "id" | "operatorId" | "type">) {
    return `search-provider:${p.operatorId}:${p.id}:${p.type}`;
  }
  async catalog(admin: Admin): Promise<SearchCatalog> {
    operator(admin);
    const d = await this.store.deployment();
    return {
      version: d.version,
      providers: (d.searchProviders ?? [])
        .filter((p) => p.operatorId === admin.id)
        .map(({ credential, operatorId: _owner, ...p }) => ({
          ...p,
          apiKeyConfigured: !!credential,
        })),
    };
  }
  async save(admin: Admin, value: unknown) {
    operator(admin);
    const input = searchInput.parse(value);
    await transaction(this.store.pool, async (sql) => {
      const d = await this.store.deployment(sql, true);
      requireThat(d.version === input.version, "version_conflict", 409);
      const old = d.searchProviders?.find(
        (p) => p.id === input.id && p.operatorId === admin.id,
      );
      requireThat(!input.id || old, "search_provider_not_found", 404);
      requireThat(
        input.type !== "duckduckgo" || !input.apiKey,
        "search_key_not_required",
      );
      requireThat(
        input.type === "duckduckgo" ||
          input.apiKey ||
          (old?.type === input.type && old.credential),
        "search_provider_key_required",
      );
      const id = old?.id ?? randomUUID();
      const p: SearchProvider = {
        id,
        operatorId: admin.id,
        version: (old?.version ?? 0) + 1,
        name: input.name,
        type: input.type,
      };
      if (input.type !== "duckduckgo")
        p.credential = input.apiKey
          ? encrypt(this.key, this.aad(p), input.apiKey)
          : old?.credential;
      d.searchProviders = [
        ...(d.searchProviders ?? []).filter((p) => p.id !== id),
        p,
      ];
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'search_provider.saved',$2)",
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
        d.searchProviders?.some(
          (p) => p.id === id && p.operatorId === admin.id,
        ),
        "search_provider_not_found",
        404,
      );
      const workspaces = await sql.query(
        "SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE",
        [admin.id],
      );
      requireThat(
        !workspaces.rows.some(
          ({ data: w }: { data: Workspace }) =>
            !w.deletion && w.chatModel?.searchProviderId === id,
        ),
        "search_provider_in_use",
        409,
      );
      d.searchProviders = d.searchProviders?.filter((p) => p.id !== id);
      d.version++;
      await this.store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'search_provider.removed',$2)",
        [admin.id, id],
      );
    });
    return this.catalog(admin);
  }
  async pin(w: Workspace): Promise<SearchPin | undefined> {
    const id = w.chatModel?.searchProviderId;
    if (!id) return undefined;
    const d = await this.store.deployment();
    const p = d.searchProviders?.find(
      (p) => p.id === id && p.operatorId === w.operatorId,
    );
    requireThat(!w.deletion && p, "search_provider_not_found", 409);
    return {
      id: p.id,
      operatorId: p.operatorId,
      version: p.version,
      type: p.type,
      chatRevision: w.chatModel?.revision ?? 0,
    };
  }
  async current(pin: SearchPin) {
    const d = await this.store.deployment();
    const p = d.searchProviders?.find(
      (p) => p.id === pin.id && p.operatorId === pin.operatorId,
    );
    requireThat(
      p && p.version === pin.version && p.type === pin.type,
      "search_provider_changed",
      409,
    );
    return p;
  }
  async search(
    pin: SearchPin,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) {
    const p = await this.current(pin);
    const key = p.credential
      ? decrypt(this.key, this.aad(p), p.credential)
      : undefined;
    return searchWeb(p.type, key, query, limit, signal, this.transport);
  }
}
