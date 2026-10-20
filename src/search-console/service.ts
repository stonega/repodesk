import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import {
  audit,
  authorize,
  revokeWork,
  runAllowed,
} from "../workspaces/policy.ts";
import {
  parseServiceAccount,
  SearchConsoleClient,
  type SearchConsoleTransport,
} from "./client.ts";
import {
  emptySearchConsole,
  inspectionInProperty,
  propertyUrl,
  type SearchConsolePage,
  searchConsoleQuery,
  searchConsoleSave,
  searchConsoleTool,
} from "./config.ts";

const aad = (id: string) => `search-console:${id}`;
function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
const siteSchema = z.object({
  siteUrl: propertyUrl,
  permissionLevel: z.enum([
    "siteOwner",
    "siteFullUser",
    "siteRestrictedUser",
    "siteUnverifiedUser",
  ]),
});
function scope(w: Workspace, runId: string, revision: number) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run && runAllowed(w, run), "run_revoked", 403);
  authorize(w, run.actor);
  requireThat(
    run.chatId === run.actor && !run.workflowId,
    "search_console_private_request_required",
    403,
  );
  const config = w.plugins?.searchConsole;
  requireThat(
    config?.settings.enabled && config.credential,
    "search_console_not_configured",
    409,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  return { run, config };
}
export class SearchConsoleService {
  private client: SearchConsoleClient;
  constructor(
    private store: Store,
    private key: string,
    transport?: SearchConsoleTransport,
  ) {
    this.client = new SearchConsoleClient(transport);
  }
  async view(admin: Admin, id: string): Promise<SearchConsolePage> {
    const w = await this.store.read(id);
    authority(admin, w);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: structuredClone(
        w.plugins?.searchConsole?.settings ?? emptySearchConsole,
      ),
      credentialConfigured: !!w.plugins?.searchConsole?.credential,
      email: w.plugins?.searchConsole?.email,
    };
  }
  private async adminAccess(
    admin: Admin,
    id: string,
    revision: number,
    sessionHash?: string,
  ) {
    const guard = async () => {
      const w = await this.store.read(id);
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === revision,
        "version_conflict",
        409,
      );
      const result = await this.store.pool.query(
        sessionHash
          ? "SELECT 1 FROM admins a JOIN sessions s ON a.id=s.admin_id WHERE a.id=$1 AND a.operator=true AND s.token_hash=$2 AND s.expires_at>now()"
          : "SELECT 1 FROM admins WHERE id=$1 AND operator=true",
        sessionHash ? [admin.id, sessionHash] : [admin.id],
      );
      requireThat(result.rowCount, "access_denied", 403);
      requireThat(
        w.plugins?.searchConsole?.credential,
        "search_console_credential_required",
        409,
      );
      return w.plugins.searchConsole.credential;
    };
    const credential = await guard();
    const account = parseServiceAccount(decrypt(this.key, aad(id), credential));
    const options = {
      guard: async () => {
        await guard();
      },
    };
    return { token: await this.client.token(account, options), options };
  }
  async properties(
    admin: Admin,
    id: string,
    sessionHash: string,
    value: unknown,
  ) {
    operator(admin);
    const { revision } = z
      .object({ revision: z.number().int().nonnegative() })
      .strict()
      .parse(value);
    const { token, options } = await this.adminAccess(
      admin,
      id,
      revision,
      sessionHash,
    );
    const data = z
      .object({ siteEntry: z.array(siteSchema).max(5000).default([]) })
      .safeParse(await this.client.api(token, "sites", options));
    requireThat(data.success, "search_console_invalid_response", 502);
    return {
      items: data.data.siteEntry.filter(
        (site) => site.permissionLevel !== "siteUnverifiedUser",
      ),
    };
  }
  async save(
    admin: Admin,
    id: string,
    value: unknown,
    fallback: PluginRecord[] = [],
    sessionHash?: string,
  ) {
    operator(admin);
    const input = searchConsoleSave.parse(value);
    const snapshot = await this.store.read(id);
    authority(admin, snapshot);
    requireThat(
      (snapshot.plugins?.revision ?? 0) === input.revision,
      "version_conflict",
      409,
    );
    requireThat(this.key, "search_console_credentials_unavailable", 503);
    const account = input.serviceAccount
      ? parseServiceAccount(input.serviceAccount)
      : undefined;
    let access:
      | Awaited<ReturnType<SearchConsoleService["adminAccess"]>>
      | undefined;
    if (
      !account &&
      !input.removeCredential &&
      input.settings.siteUrls.length &&
      (input.settings.enabled ||
        JSON.stringify(input.settings.siteUrls) !==
          JSON.stringify(snapshot.plugins?.searchConsole?.settings.siteUrls))
    ) {
      access = await this.adminAccess(admin, id, input.revision, sessionHash);
      for (const site of input.settings.siteUrls) {
        const result = siteSchema.safeParse(
          await this.client.api(
            access.token,
            `sites/${encodeURIComponent(site)}`,
            access.options,
          ),
        );
        requireThat(
          result.success &&
            result.data.siteUrl === site &&
            result.data.permissionLevel !== "siteUnverifiedUser",
          "search_console_property_denied",
          403,
        );
      }
    }
    await this.store.change(id, async (w) => {
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      if (access) await access.options.guard();
      const previous = w.plugins?.searchConsole;
      const credential = input.removeCredential
        ? undefined
        : account
          ? encrypt(this.key, aad(id), JSON.stringify(account))
          : previous?.credential;
      const settings =
        account || input.removeCredential
          ? { ...emptySearchConsole, siteUrls: [] }
          : input.settings;
      requireThat(
        !settings.enabled || (credential && settings.siteUrls.length),
        "search_console_not_configured",
        409,
      );
      requireThat(
        !settings.enabled ||
          !(w.plugins?.entries ?? fallback).some(
            (entry) =>
              entry.enabled &&
              (entry.id === "search-console" ||
                entry.tools.includes(searchConsoleTool)),
          ),
        "extension_tool_collision",
        409,
      );
      w.plugins = {
        ...w.plugins,
        entries: w.plugins?.entries ?? fallback,
        revision: input.revision + 1,
        searchConsole: {
          settings,
          credential,
          email: input.removeCredential
            ? undefined
            : (account?.client_email ?? previous?.email),
        },
      };
      revokeWork(w);
      audit(
        w,
        admin.id,
        "plugins.updated",
        "search-console",
        w.plugins.revision,
      );
    });
    return this.view(admin, id);
  }
  async query(
    id: string,
    runId: string,
    revision: number,
    value: unknown,
    signal?: AbortSignal,
    guard = async () => {},
  ) {
    const input = searchConsoleQuery.parse(value);
    const check = async () => {
      signal?.throwIfAborted();
      await guard();
      const w = await this.store.read(id);
      const current = scope(w, runId, revision);
      const d = await this.store.deployment();
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      if (input.siteUrl)
        requireThat(
          current.config.settings.siteUrls.includes(input.siteUrl),
          "search_console_property_denied",
          403,
        );
      return current;
    };
    const { config } = await check();
    if (input.resource === "inspect_url")
      requireThat(
        inspectionInProperty(
          input.siteUrl as string,
          input.inspectionUrl as string,
        ),
        "search_console_property_denied",
        403,
      );
    await this.store.change(id, (w) => {
      scope(w, runId, revision).run.searchConsoleRead = { revision };
    });
    if (input.resource === "properties") {
      await check();
      return { resource: "properties", siteUrls: config.settings.siteUrls };
    }
    const options = {
      signal,
      guard: async () => {
        await check();
      },
    };
    const token = await this.client.token(
      parseServiceAccount(
        decrypt(this.key, aad(id), config.credential as string),
      ),
      options,
    );
    const path = `sites/${encodeURIComponent(input.siteUrl as string)}`;
    let result: unknown;
    if (input.resource === "analytics") {
      const data = z
        .object({
          rows: z
            .array(
              z.object({
                keys: z.array(z.string().max(4096)).max(6).optional(),
                clicks: z.number().nonnegative(),
                impressions: z.number().nonnegative(),
                ctr: z.number().nonnegative(),
                position: z.number().nonnegative(),
              }),
            )
            .max(input.rowLimit)
            .default([]),
          responseAggregationType: z.string().max(100).optional(),
        })
        .safeParse(
          await this.client.api(
            token,
            `${path}/searchAnalytics/query`,
            options,
            {
              startDate: input.startDate,
              endDate: input.endDate,
              dimensions: input.dimensions,
              type: input.type,
              dataState: "final",
              rowLimit: input.rowLimit,
              startRow: input.startRow,
            },
          ),
        );
      requireThat(data.success, "search_console_invalid_response", 502);
      result = {
        ...data.data,
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        type: input.type,
        timezone: "America/Los_Angeles",
        nextStartRow:
          data.data.rows.length === input.rowLimit &&
          input.startRow + input.rowLimit <= 50000
            ? input.startRow + input.rowLimit
            : null,
        coverage:
          "Google returns top rows, not every query. Empty results do not establish zero traffic.",
      };
    } else if (input.resource === "sitemaps") {
      const data = z
        .object({
          sitemap: z
            .array(
              z.object({
                path: z.string().max(2048),
                lastSubmitted: z.string().max(100).optional(),
                lastDownloaded: z.string().max(100).optional(),
                isPending: z.boolean().optional(),
                isSitemapsIndex: z.boolean().optional(),
                type: z.string().max(100).optional(),
                warnings: z.string().max(30).optional(),
                errors: z.string().max(30).optional(),
                contents: z
                  .array(
                    z.object({
                      type: z.string().max(100),
                      submitted: z.string().max(30).optional(),
                      indexed: z.string().max(30).optional(),
                    }),
                  )
                  .max(20)
                  .optional(),
              }),
            )
            .max(5000)
            .default([]),
        })
        .safeParse(await this.client.api(token, `${path}/sitemaps`, options));
      requireThat(data.success, "search_console_invalid_response", 502);
      result = {
        sitemaps: data.data.sitemap.slice(0, 100),
        truncated: data.data.sitemap.length > 100,
      };
    } else {
      const text = z.string().max(4096).optional();
      const data = z
        .object({
          inspectionResult: z.object({
            inspectionResultLink: text,
            indexStatusResult: z
              .object({
                verdict: text,
                coverageState: text,
                robotsTxtState: text,
                indexingState: text,
                lastCrawlTime: text,
                pageFetchState: text,
                googleCanonical: text,
                userCanonical: text,
                crawledAs: text,
                sitemap: z.array(z.string().max(2048)).max(100).optional(),
              })
              .optional(),
          }),
        })
        .safeParse(
          await this.client.api(
            token,
            "urlInspection/index:inspect",
            options,
            { siteUrl: input.siteUrl, inspectionUrl: input.inspectionUrl },
            true,
          ),
        );
      requireThat(data.success, "search_console_invalid_response", 502);
      result = data.data.inspectionResult;
    }
    await check();
    return { resource: input.resource, siteUrl: input.siteUrl, result };
  }
}
