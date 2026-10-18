import { requireThat } from "../domain.ts";
import { type CloudflareClient, row } from "./client.ts";
import {
  type CloudflareResourcePage,
  type CloudflareResources,
  cloudflareResource,
} from "./config.ts";

/** Provider inventory is for operator selection only; it never grants tool access. */
export async function listCloudflareResources(
  api: CloudflareClient,
  token: string,
  resource: "accounts" | "zones",
  page: number,
  guard: () => Promise<void>,
  accountId?: string,
): Promise<CloudflareResourcePage> {
  const query = new URLSearchParams({ page: String(page), per_page: "50" });
  if (accountId) query.set("account.id", accountId);
  const response = await api.request(token, `/${resource}?${query}`, { guard });
  requireThat(Array.isArray(response.result), "cloudflare_unavailable", 502);
  const items = cloudflareResource.array().max(50).parse(response.result);
  if (resource === "zones")
    requireThat(
      response.result.every((item) => row(row(item).account).id === accountId),
      "cloudflare_zone_denied",
      403,
    );
  const total = response.result_info.total_count;
  return {
    items,
    page,
    hasMore:
      typeof total === "number" ? page * 50 < total : items.length === 50,
  };
}

export async function selectedCloudflareResources(
  api: CloudflareClient,
  token: string,
  accountId: string,
  zoneIds: string[],
  guard: () => Promise<void>,
): Promise<CloudflareResources> {
  const result = await api.request(token, `/accounts/${accountId}`, { guard });
  const account = cloudflareResource.parse(result.result);
  requireThat(account.id === accountId, "cloudflare_oauth_account_denied", 403);
  const zones = await Promise.all(
    zoneIds.map(async (id) => {
      const response = await api.request(token, `/zones/${id}`, { guard });
      const zone = cloudflareResource.parse(response.result);
      requireThat(
        zone.id === id && row(row(response.result).account).id === accountId,
        "cloudflare_zone_denied",
        403,
      );
      return zone;
    }),
  );
  return { account, zones };
}
