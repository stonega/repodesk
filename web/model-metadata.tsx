import type {
  ModelMetadata,
  ProviderType,
  TokenPrices,
} from "../src/model-metadata/types.ts";

export const providerLabels: Record<ProviderType, string> = {
  auto: "Detect from URL",
  openrouter: "OpenRouter",
  newapi: "New API (self-hosted)",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  "openai-compatible": "Other OpenAI-compatible API",
};
export function AutomaticModelInfo({ metadata }: { metadata?: ModelMetadata }) {
  if (!metadata) return null;
  if (!metadata.contextWindow && !metadata.maxOutputTokens && !metadata.pricing)
    return (
      <p className="muted">
        Automatic model information is unavailable. Use optional overrides for
        this provider’s documented limits and prices.
      </p>
    );
  const price = (value?: number) =>
    value === undefined ? "Unknown" : `${value} USD / million tokens`;
  const source = (value?: string) =>
    value === "api"
      ? "API"
      : value === "reference"
        ? "Dated official reference"
        : value === "catalog"
          ? "Bundled catalog"
          : "Unavailable";
  const prices = (value?: TokenPrices) =>
    [
      ["Input (cache miss)", value?.input],
      ["Output", value?.output],
      ["Input (cache hit)", value?.cacheRead],
      ["Cache write", value?.cacheWrite],
    ] as const;
  return (
    <div>
      <h3>Automatic model information</h3>
      <dl className="plugin-summary" aria-label="Automatic model information">
        <div>
          <dt>Context metadata</dt>
          <dd>
            {metadata.contextWindow?.toLocaleString() ?? "Unknown"} ·{" "}
            {source(metadata.sources.contextWindow)}
          </dd>
        </div>
        <div>
          <dt>Output metadata</dt>
          <dd>
            {metadata.maxOutputTokens?.toLocaleString() ?? "Unknown"} ·{" "}
            {source(metadata.sources.maxOutputTokens)}
          </dd>
        </div>
        {prices(metadata.pricing).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{price(value)}</dd>
          </div>
        ))}
        <div>
          <dt>Price source</dt>
          <dd>
            {source(metadata.sources.pricing)}
            {metadata.referenceCheckedAt
              ? ` · ${metadata.referenceCheckedAt}`
              : ""}
          </dd>
        </div>
      </dl>
      {metadata.pricingTiers && (
        <details className="setup-advanced">
          <summary>Compare price tiers</summary>
          {metadata.pricingTiers.map((tier) => (
            <div key={tier.id}>
              <h4>{tier.label} prices</h4>
              <dl
                className="plugin-summary"
                aria-label={`${tier.label} prices`}
              >
                {prices(tier.prices)
                  .filter(([, value]) => value !== undefined)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{price(value)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
          {metadata.pricingNote && (
            <p className="muted">{metadata.pricingNote}</p>
          )}
        </details>
      )}
    </div>
  );
}
