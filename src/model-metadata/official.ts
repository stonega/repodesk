import type { Api, Model } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import type { ModelMetadata, ProviderType } from "./types.ts";

const catalogs: Partial<Record<ProviderType, Record<string, Model<Api>>>> = {
  openai: OPENAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  groq: GROQ_MODELS,
  mistral: MISTRAL_MODELS,
  xai: XAI_MODELS,
};
export function officialMetadata(
  type: ProviderType,
  id: string,
): ModelMetadata | undefined {
  const catalog = catalogs[type];
  const model = catalog && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  const result: ModelMetadata | undefined = model
    ? {
        id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        input: [...model.input],
        pricing: { ...model.cost },
        sources: {
          contextWindow: "catalog",
          maxOutputTokens: "catalog",
          pricing: "catalog",
        },
      }
    : undefined;
  if (type !== "deepseek") return result;
  // DeepSeek has no documented pricing API. This dated reference is intentionally
  // distinct from live /models metadata and never applied to a reseller endpoint.
  const flash = [
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
  ].includes(id);
  if (!flash && id !== "deepseek-v4-pro") return result;
  const peak = flash
    ? { input: 0.3, cacheRead: 0.006, output: 1.2 }
    : { input: 1.32, cacheRead: 0.044, output: 3.96 };
  const offPeak = flash
    ? { input: 0.15, cacheRead: 0.003, output: 0.6 }
    : { input: 0.66, cacheRead: 0.022, output: 1.98 };
  return {
    ...result,
    id,
    pricing: peak,
    pricingTiers: [
      { id: "peak", label: "Peak", prices: peak },
      { id: "off_peak", label: "Off-peak", prices: offPeak },
    ],
    pricingNote:
      "Peak: weekdays 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays. Off-peak: all other hours. Peak is the default estimate; choose a tier or use overrides, and reconcile verified billing for actual discounts.",
    sources: { ...result?.sources, pricing: "reference" },
    reference: "https://api-docs.deepseek.com/quick_start/pricing/",
    referenceCheckedAt: "2026-10-14",
  };
}
