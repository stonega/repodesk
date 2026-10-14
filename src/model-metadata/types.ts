// Transport-independent contracts. Prices are USD per million tokens.
export const providerTypes = [
  "auto",
  "openrouter",
  "newapi",
  "openai",
  "deepseek",
  "mistral",
  "groq",
  "xai",
  "openai-compatible",
] as const;
export type ProviderType = (typeof providerTypes)[number];
export type MetadataSource = "api" | "catalog" | "reference";
export interface TokenPrices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface PriceTier {
  id: string;
  label: string;
  prices: TokenPrices;
}
export interface ModelMetadata {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: ("text" | "image")[];
  pricing?: TokenPrices;
  pricingTiers?: PriceTier[];
  // Reference tiers are estimates; callers choose a tier explicitly and reconcile
  // actual billing when holidays or requests cross a pricing boundary.
  pricingNote?: string;
  sources: {
    contextWindow?: MetadataSource;
    maxOutputTokens?: MetadataSource;
    pricing?: MetadataSource;
  };
  reference?: string;
  referenceCheckedAt?: string;
}
export type MetadataTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
export interface DiscoveryOptions {
  baseUrl: string;
  apiKey: string;
  type?: ProviderType;
  pricingGroup?: string;
}
export interface ModelDiscovery {
  type: Exclude<ProviderType, "auto">;
  models: string[];
  modelMetadata: ModelMetadata[];
  fetchedAt: string;
  metadataWarning?: "newapi_pricing_unavailable" | "newapi_group_required";
}
