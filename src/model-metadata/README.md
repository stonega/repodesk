# Model metadata module

This standalone module discovers model IDs, context/output limits and token prices
without depending on RepoDesk's database, admin services, credentials or UI. Its
transport is injectable; deterministic tests supply HTTP fixtures. The bundled Pi
catalogs are the only library dependency. `index.ts` exports its public API.

```ts
import { discoverModels } from "./index.ts";

const catalog = await discoverModels({
  type: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "KEY_RESOLVED_BY_CALLER",
});
```

Pass an inference API base URL and a credential resolved by the caller. `auto`
recognizes exact OpenRouter, OpenAI, DeepSeek, Mistral, Groq and xAI hostnames.
Select `newapi` explicitly for a self-hosted instance. Other hosts are
OpenAI-compatible; a model ID alone never assigns an official provider's prices.

All prices are **USD per million tokens**. Available context/output/price fields
identify their source: `api`, `catalog` or `reference`. Missing prices remain
unknown; zero is a known free rate. APIs may return only some limits or prices.
Callers store snapshots and choose refresh policy; there is no background poller
or inference call. RepoDesk refreshes when saving a provider and pins the cached
metadata with each chat run. Later edits never revalue historical runs.

| Adapter | Live API data | Fallback / limits |
| --- | --- | --- |
| OpenRouter | `/models`: token prices converted to per-million units, cached read/write rates, context/output and input modalities | Per-request and conditional pricing remain unknown |
| New API | `/models`, public `/api/pricing`: model, completion, cache and group ratios | Requires the key's configured billing group; inaccessible prices, per-call billing and expressions remain unknown |
| OpenAI | `/models`: availability | Bundled provider-specific Pi catalog for prices/limits; model-list API has neither |
| DeepSeek | `/models`: context/output and input modalities when supplied | Bundled catalog plus dated official price reference for current Flash/Pro aliases |
| Mistral, Groq, xAI | `/models`: available IDs and context/output fields when supplied | Provider-specific bundled Pi catalog |
| Other compatible APIs | `/models`: IDs and context/output fields if present | Missing values stay unknown |

New API input price is `model_ratio × 2 × group_ratio`; output, cache read and
cache write multiply it by their respective ratios. Only models in the credential's
`/models` list and enabled for the chosen group receive prices. The inference key
is sent only to `/models`; public pricing receives no credential. Reverse-proxy
prefixes are preserved when replacing the final `/v1` with `/api/pricing`.
Account-only pricing requires manual overrides.

DeepSeek metadata keeps **Peak** and **Off-peak** prices, each with separate
cache-hit input, cache-miss input and output rates. The reference was checked
2026-10-14. Default accounting uses Peak conservatively. A caller can use
`withPriceTier(metadata, "off_peak")` for an explicitly selected discounted estimate.
RepoDesk's advanced chat model settings retain that choice. Holidays and requests
crossing rate boundaries make clock-only billing unreliable; verified-charge
reconciliation remains the source for actual discounted billing.

Requests deny redirects, time out after 15 seconds, reject more than 5,000 models
and cap responses at 1 MiB (8 MiB for richer OpenRouter/New API catalogs). Failures
expose stable error codes, never upstream bodies or credentials. Unsupported
metadata does not prevent model discovery; model-list failures do.

Sources checked 2026-10-14:

- [OpenRouter model API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [New API public pricing endpoint](https://doc.newapi.pro/api/fei-public-info/)
- [New API ratio units](https://docs.newapi.ai/en/docs/guide/console/settings/rate-settings)
- [OpenAI model-list contract](https://developers.openai.com/api/reference/resources/models/methods/list)
- [DeepSeek model-list contract](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek price tiers](https://api-docs.deepseek.com/quick_start/pricing/)
- [Mistral model-list contract](https://docs.mistral.ai/api/endpoint/models)
- [Groq model-list contract](https://console.groq.com/docs/api-reference)
