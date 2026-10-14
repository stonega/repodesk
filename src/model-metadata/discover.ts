import {
  apiMetadata,
  detectProvider,
  mergeMetadata,
  newApiPricing,
  number,
  object,
} from "./normalize.ts";
import { officialMetadata } from "./official.ts";
import type {
  DiscoveryOptions,
  MetadataTransport,
  ModelDiscovery,
} from "./types.ts";
import { providerTypes } from "./types.ts";

export class MetadataError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new MetadataError("model_provider_auth_failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MetadataError("model_discovery_failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MetadataError("model_discovery_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new MetadataError("model_discovery_too_large");
      chunks.push(part.value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(joined));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function pricingUrl(baseUrl: string) {
  // Preserve reverse-proxy prefixes; remove only the inference /v1 suffix.
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/pricing`;
  return url.toString();
}
export async function discoverModels(
  options: DiscoveryOptions,
  transport: MetadataTransport = fetch,
): Promise<ModelDiscovery> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MetadataError("model_discovery_invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (options.type && !providerTypes.includes(options.type))
  )
    throw new MetadataError("model_discovery_invalid");
  const type = detectProvider(baseUrl, options.type);
  const request = async (url: string, authenticated: boolean) =>
    readJson(
      await transport(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          accept: "application/json",
          ...(authenticated
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
      }),
      (type === "openrouter" || type === "newapi" ? 8 : 1) * 1024 * 1024,
    );
  try {
    const raw = object(await request(`${baseUrl}/models`, true));
    if (!Array.isArray(raw.data) || raw.data.length > 5000)
      throw new MetadataError("model_discovery_invalid");
    const byId = new Map<string, ReturnType<typeof apiMetadata>>();
    for (const item of raw.data) {
      const row = object(item);
      if (
        typeof row.id !== "string" ||
        !row.id.length ||
        row.id.length > 200 ||
        /\s/.test(row.id)
      )
        throw new MetadataError("model_discovery_invalid");
      byId.set(
        row.id,
        mergeMetadata(
          officialMetadata(type, row.id),
          apiMetadata(row, row.id, type),
        ),
      );
    }
    let metadataWarning: ModelDiscovery["metadataWarning"];
    if (type === "newapi") {
      try {
        // New API's public pricing endpoint uses account/session auth rather than
        // inference tokens. Do not send the inference credential to it.
        const pricing = object(await request(pricingUrl(baseUrl), false));
        if (
          pricing.success !== true ||
          !Array.isArray(pricing.data) ||
          pricing.data.length > 5000
        )
          throw new MetadataError("model_discovery_invalid");
        const groups = object(pricing.group_ratio);
        if (!options.pricingGroup) metadataWarning = "newapi_group_required";
        for (const item of pricing.data) {
          const row = object(item);
          const model =
            typeof row.model_name === "string"
              ? byId.get(row.model_name)
              : undefined;
          if (
            !model ||
            !options.pricingGroup ||
            !Array.isArray(row.enable_group) ||
            !row.enable_group.includes(options.pricingGroup)
          )
            continue;
          const group = number(groups[options.pricingGroup]);
          const prices =
            group === undefined ? undefined : newApiPricing(row, group);
          if (prices) {
            model.pricing = prices;
            model.sources.pricing = "api";
          }
        }
      } catch {
        metadataWarning = "newapi_pricing_unavailable";
      }
    }
    const models = [...byId.keys()].sort();
    return {
      type,
      models,
      modelMetadata: [...byId.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      fetchedAt: new Date().toISOString(),
      ...(metadataWarning ? { metadataWarning } : {}),
    };
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    throw new MetadataError("model_discovery_failed");
  }
}
