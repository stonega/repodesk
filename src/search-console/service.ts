import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { GoogleService, googleUserScope } from "../google/service.ts";
import { token } from "../setup/credentials.ts";
import { revokeWork, runAllowed } from "../workspaces/policy.ts";
import { SearchConsoleClient, type SearchConsoleTransport } from "./client.ts";
import {
  inspectionInProperty,
  propertyUrl,
  searchConsoleQuery,
} from "./config.ts";

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
  requireThat(
    run.chatId === run.actor && !run.workflowId,
    "search_console_private_request_required",
    403,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  return { run, ...googleUserScope(w, run.actor) };
}
export class SearchConsoleService {
  private client: SearchConsoleClient;
  constructor(
    private store: Store,
    key: string,
    transport?: SearchConsoleTransport,
    private google = new GoogleService(store, key),
  ) {
    this.client = new SearchConsoleClient(transport);
  }
  async properties(w: Workspace, actor: string, botId: string) {
    const { user, connection } = googleUserScope(w, actor, botId);
    const guard = async () => {
      googleUserScope(w, actor, botId);
      await this.google.assertBot(botId);
    };
    const access = await this.google.accountAccess(
      w.id,
      actor,
      guard,
      undefined,
      w,
    );
    const data = z
      .object({ siteEntry: z.array(siteSchema).max(5000).default([]) })
      .safeParse(await this.client.api(access, "sites", { guard }));
    requireThat(data.success, "search_console_invalid_response", 502);
    const items = [
      ...new Set(
        data.data.siteEntry
          .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
          .map((s) => s.siteUrl),
      ),
    ];
    user.properties = {
      key: token(),
      connectionId: connection.id,
      revision: w.plugins?.revision ?? 0,
      items,
      selected: user.siteUrls.filter((site) => items.includes(site)),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
  }
  async saveProperties(
    w: Workspace,
    actor: string,
    botId: string,
    key: string,
  ) {
    const { user, connection } = googleUserScope(w, actor, botId);
    const draft = user.properties;
    requireThat(
      draft?.key === key &&
        draft.connectionId === connection.id &&
        draft.revision === w.plugins?.revision &&
        Date.parse(draft.expiresAt) > Date.now(),
      "google_properties_expired",
      409,
    );
    requireThat(draft.selected.length <= 20, "google_property_limit", 409);
    const guard = async () => {
      googleUserScope(w, actor, botId);
      await this.google.assertBot(botId);
    };
    const access = await this.google.accountAccess(
      w.id,
      actor,
      guard,
      undefined,
      w,
    );
    for (const site of draft.selected) {
      const result = siteSchema.safeParse(
        await this.client.api(access, `sites/${encodeURIComponent(site)}`, {
          guard,
        }),
      );
      requireThat(
        result.success &&
          result.data.siteUrl === site &&
          result.data.permissionLevel !== "siteUnverifiedUser",
        "search_console_property_denied",
        403,
      );
    }
    user.siteUrls = [...draft.selected];
    user.siteRevision++;
    delete user.properties;
    revokeWork(w);
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
    const initial = scope(await this.store.read(id), runId, revision);
    const connectionId = initial.connection.id;
    const selectionRevision = initial.user.siteRevision;
    const check = async () => {
      signal?.throwIfAborted();
      await guard();
      const current = scope(await this.store.read(id), runId, revision);
      const d = await this.store.deployment();
      requireThat(
        d.active && !d.paused && d.bot?.id === current.user.botId,
        "deployment_paused",
        409,
      );
      requireThat(
        current.connection.id === connectionId &&
          current.user.siteRevision === selectionRevision,
        "google_connection_changed",
        409,
      );
      if (input.siteUrl)
        requireThat(
          current.user.siteUrls.includes(input.siteUrl),
          "search_console_property_denied",
          403,
        );
      return current;
    };
    const { user, run } = await check();
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
      const current = scope(w, runId, revision);
      requireThat(
        current.connection.id === connectionId &&
          current.user.siteRevision === selectionRevision,
        "google_connection_changed",
        409,
      );
      current.run.searchConsoleRead = {
        revision,
        connectionId,
        selectionRevision,
      };
    });
    if (input.resource === "properties") {
      await check();
      return { resource: "properties", siteUrls: user.siteUrls };
    }
    const options = {
      signal,
      guard: async () => {
        await check();
      },
    };
    const access = await this.google.accountAccess(
      id,
      run.actor,
      options.guard,
      signal,
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
            access,
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
        .safeParse(await this.client.api(access, `${path}/sitemaps`, options));
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
            access,
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
