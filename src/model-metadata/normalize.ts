import type { ModelMetadata, ProviderType, TokenPrices } from "./types.ts";

export function detectProvider(
  baseUrl: string,
  type: ProviderType = "auto",
): Exclude<ProviderType, "auto"> {
  if (type !== "auto") return type;
  const host = new URL(baseUrl).hostname;
  const known: Record<string, Exclude<ProviderType, "auto">> = {
    "openrouter.ai": "openrouter",
    "api.openai.com": "openai",
    "api.deepseek.com": "deepseek",
    "api.mistral.ai": "mistral",
    "api.groq.com": "groq",
    "api.x.ai": "xai",
  };
  return Object.hasOwn(known, host)
    ? (known[host] ?? "openai-compatible")
    : "openai-compatible";
}
export function withPriceTier(
  metadata: ModelMetadata | undefined,
  tier: string | undefined,
): ModelMetadata | undefined {
  if (!metadata || !tier) return metadata;
  const selected = metadata.pricingTiers?.find((v) => v.id === tier);
  return selected ? { ...metadata, pricing: { ...selected.prices } } : metadata;
}
export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function number(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" ||
      !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function tokens(value: unknown) {
  const n = number(value);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
export function apiMetadata(
  raw: Record<string, unknown>,
  id: string,
  type: ProviderType,
): ModelMetadata {
  const top = object(raw.top_provider);
  const pricing = object(raw.pricing);
  const contextWindow = tokens(
    top.context_length ??
      raw.context_length ??
      raw.context_window ??
      raw.max_context_length,
  );
  const maxOutputTokens = tokens(
    top.max_completion_tokens ??
      raw.max_output_tokens ??
      raw.max_completion_tokens,
  );
  const input = Array.isArray(raw.input_modalities)
    ? raw.input_modalities
    : object(raw.architecture).input_modalities;
  const prices: TokenPrices = {};
  // OpenRouter reports dollars per token, unlike the app/Pi's per-million units.
  if (type === "openrouter") {
    for (const [key, field] of Object.entries({
      input: "prompt",
      output: "completion",
      cacheRead: "input_cache_read",
      cacheWrite: "input_cache_write",
    })) {
      const value = number(pricing[field]);
      if (value !== undefined && value * 1_000_000 <= 10_000)
        prices[key as keyof TokenPrices] = Number(
          (value * 1_000_000).toPrecision(15),
        );
    }
    // Non-token fees/conditional prices cannot be represented as flat token costs.
    if (
      (number(pricing.request) ?? 0) > 0 ||
      (Array.isArray(pricing.overrides) && pricing.overrides.length)
    ) {
      for (const key of Object.keys(prices))
        delete prices[key as keyof TokenPrices];
    }
  }
  return {
    id,
    ...(typeof raw.name === "string" && raw.name.length <= 200
      ? { name: raw.name }
      : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(Array.isArray(input) &&
    input.every((v) => v === "text" || v === "image") &&
    input.length
      ? { input: [...new Set(input)] as ("text" | "image")[] }
      : {}),
    ...(Object.keys(prices).length ? { pricing: prices } : {}),
    sources: {
      ...(contextWindow ? { contextWindow: "api" as const } : {}),
      ...(maxOutputTokens ? { maxOutputTokens: "api" as const } : {}),
      ...(Object.keys(prices).length ? { pricing: "api" as const } : {}),
    },
  };
}
export function mergeMetadata(
  fallback: ModelMetadata | undefined,
  api: ModelMetadata,
): ModelMetadata {
  return {
    ...fallback,
    ...api,
    name: api.name ?? fallback?.name,
    contextWindow: api.contextWindow ?? fallback?.contextWindow,
    maxOutputTokens: api.maxOutputTokens ?? fallback?.maxOutputTokens,
    input: api.input ?? fallback?.input,
    pricing: api.pricing ?? fallback?.pricing,
    sources: { ...fallback?.sources, ...api.sources },
  };
}
export function newApiPricing(
  raw: Record<string, unknown>,
  groupRatio: number,
): TokenPrices | undefined {
  // Per-request and expression billing are deliberately left unknown.
  if (raw.quota_type !== 0 || raw.billing_mode === "tiered_expr")
    return undefined;
  const ratio = number(raw.model_ratio);
  const completion = number(raw.completion_ratio);
  if (ratio === undefined || completion === undefined) return undefined;
  const input = ratio * 2 * groupRatio;
  const prices: TokenPrices = { input, output: input * completion };
  for (const [key, field] of Object.entries({
    cacheRead: "cache_ratio",
    cacheWrite: "create_cache_ratio",
  })) {
    const value = number(raw[field]);
    if (value !== undefined) prices[key as keyof TokenPrices] = input * value;
  }
  return Object.values(prices).every((v) => Number.isFinite(v) && v <= 10_000)
    ? prices
    : undefined;
}
