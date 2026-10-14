import { describe, expect, test } from "bun:test";
import { modelCapabilities, selectedModel } from "../../src/agent/runtime.ts";
import {
  detectProvider,
  discoverModels,
  type MetadataTransport,
  withPriceTier,
} from "../../src/model-metadata/index.ts";
import { providerBaseUrl } from "../../src/models/config.ts";

const key = "fixture-key-never-returned";
const routerModel = {
  id: "deepseek/example",
  context_length: 131072,
  top_provider: { max_completion_tokens: 8192 },
  pricing: {
    prompt: "0.0000003",
    completion: "0.0000012",
    input_cache_read: "0.000000006",
    input_cache_write: "0.0000004",
  },
};
function transport(models: unknown[], pricing?: unknown): MetadataTransport {
  return async (url) =>
    Response.json(url.endsWith("/api/pricing") ? pricing : { data: models });
}
describe("standalone model metadata", () => {
  test("detects exact official hosts, supports explicit self-hosted types and preserves API prefixes", () => {
    expect(detectProvider("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(detectProvider("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectProvider("https://api.openai.com.attacker.test/v1")).toBe(
      "openai-compatible",
    );
    expect(detectProvider("http://localhost:3000/v1", "newapi")).toBe("newapi");
    expect(providerBaseUrl.parse("https://openrouter.ai")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(providerBaseUrl.parse("https://api.groq.com")).toBe(
      "https://api.groq.com/openai/v1",
    );
    expect(providerBaseUrl.parse("https://proxy.test/service/v1/")).toBe(
      "https://proxy.test/service/v1",
    );
  });
  test("fetches and normalizes OpenRouter token prices and independent context/output metadata", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await discoverModels(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: key },
      async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          data: [
            routerModel,
            { id: "free", pricing: { prompt: "0", completion: "0" } },
            routerModel,
          ],
        });
      },
    );
    expect(result.models).toEqual(["deepseek/example", "free"]);
    expect(result.modelMetadata[0]).toMatchObject({
      contextWindow: 131072,
      maxOutputTokens: 8192,
      pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.4 },
      sources: { contextWindow: "api", maxOutputTokens: "api", pricing: "api" },
    });
    expect(result.modelMetadata[1]?.pricing).toEqual({ input: 0, output: 0 });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
  });
  test("missing, negative, nonfinite and non-token prices remain unknown instead of free", async () => {
    const result = await discoverModels(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: key },
      transport([
        { id: "missing" },
        { id: "negative", pricing: { prompt: "-1", completion: "NaN" } },
        {
          id: "bad",
          context_length: false,
          top_provider: { max_completion_tokens: "0" },
          pricing: { prompt: "", completion: false },
        },
        {
          id: "per-request",
          pricing: { prompt: "0", completion: "0", request: "0.1" },
        },
        {
          id: "conditional",
          pricing: { prompt: "0.1", completion: "0.1", overrides: [{}] },
        },
      ]),
    );
    for (const metadata of result.modelMetadata)
      expect(metadata.pricing).toBeUndefined();
    expect(
      result.modelMetadata.find((m) => m.id === "bad")?.contextWindow,
    ).toBeUndefined();
  });
  test("official lists retain provider-specific catalog fallbacks while API limits take precedence", async () => {
    const result = await discoverModels(
      { baseUrl: "https://api.openai.com/v1", apiKey: key },
      transport([
        {
          id: "gpt-4.1-mini",
          context_window: 777777,
          max_output_tokens: 12345,
        },
        { id: "new-model" },
      ]),
    );
    expect(result.modelMetadata[0]).toMatchObject({
      contextWindow: 777777,
      maxOutputTokens: 12345,
      sources: {
        contextWindow: "api",
        maxOutputTokens: "api",
        pricing: "catalog",
      },
    });
    expect(result.modelMetadata[0]?.pricing?.input).toBeGreaterThan(0);
    expect(result.modelMetadata[1]?.pricing).toBeUndefined();
    const proxy = await discoverModels(
      { baseUrl: "https://proxy.test/v1", apiKey: key },
      transport([{ id: "gpt-4.1-mini" }]),
    );
    const selected = selectedModel("gpt-4.1-mini", {
      modelMetadata: proxy.modelMetadata[0],
    });
    expect(selected.pricingKnown).toBe(false);
    expect(selected.contextWindow).toBe(Number.MAX_SAFE_INTEGER);
  });
  test("Mistral and Groq expose their own API context/output fields", async () => {
    const mistral = await discoverModels(
      { baseUrl: "https://api.mistral.ai/v1", apiKey: key },
      transport([{ id: "custom", max_context_length: 32768 }]),
    );
    expect(mistral.modelMetadata[0]).toMatchObject({
      contextWindow: 32768,
      sources: { contextWindow: "api" },
    });
    const groq = await discoverModels(
      { baseUrl: "https://api.groq.com/openai/v1", apiKey: key },
      transport([
        { id: "custom", context_window: 8192, max_completion_tokens: 4096 },
      ]),
    );
    expect(groq.modelMetadata[0]).toMatchObject({
      contextWindow: 8192,
      maxOutputTokens: 4096,
      sources: { maxOutputTokens: "api" },
    });
  });
  test("DeepSeek retains both time tiers and cached/uncached rates with dated provenance", async () => {
    const result = await discoverModels(
      { baseUrl: "https://api.deepseek.com/v1", apiKey: key },
      transport([
        {
          id: "deepseek-flash",
          context_window: 1048576,
          max_output_tokens: 393216,
          input_modalities: ["text", "image"],
        },
        { id: "deepseek-v4-pro" },
      ]),
    );
    expect(result.modelMetadata[0]).toMatchObject({
      contextWindow: 1048576,
      pricing: { input: 0.3, cacheRead: 0.006, output: 1.2 },
      sources: { contextWindow: "api", pricing: "reference" },
      referenceCheckedAt: "2026-10-14",
    });
    expect(
      result.modelMetadata[0]?.pricingTiers?.map((t) => t.prices.input),
    ).toEqual([0.3, 0.15]);
    expect(
      result.modelMetadata[1]?.pricingTiers?.map((t) => t.prices.cacheRead),
    ).toEqual([0.044, 0.022]);
    expect(
      selectedModel("deepseek-flash", {
        modelMetadata: result.modelMetadata[0],
      }).cost.cacheRead,
    ).toBe(0.006);
    const discounted = withPriceTier(result.modelMetadata[0], "off_peak");
    expect(
      selectedModel("deepseek-flash", { modelMetadata: discounted }).cost,
    ).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.003 });
    expect(result.modelMetadata[0]?.pricing?.input).toBe(0.3);
  });
  test("New API fetches same-origin public pricing under the reverse-proxy prefix and applies the chosen group", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const pricing = {
      success: true,
      group_ratio: { vip: 0.5 },
      data: [
        {
          model_name: "custom",
          quota_type: 0,
          model_ratio: 0.14,
          completion_ratio: 1.5,
          cache_ratio: 0.1,
          create_cache_ratio: 1.25,
          enable_group: ["vip"],
        },
        {
          model_name: "not-in-model-list",
          quota_type: 0,
          model_ratio: 1,
          completion_ratio: 2,
          enable_group: ["vip"],
        },
      ],
    };
    const result = await discoverModels(
      {
        baseUrl: "http://localhost:3000/proxy/v1",
        type: "newapi",
        pricingGroup: "vip",
        apiKey: key,
      },
      async (url, init) => {
        seen.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return transport([{ id: "custom", context_window: 100000 }], pricing)(
          url,
          init,
        );
      },
    );
    expect(seen).toEqual([
      {
        url: "http://localhost:3000/proxy/v1/models",
        authorization: `Bearer ${key}`,
      },
      { url: "http://localhost:3000/proxy/api/pricing", authorization: null },
    ]);
    expect(result.models).toEqual(["custom"]);
    expect(result.modelMetadata[0]?.pricing?.input).toBeCloseTo(0.14);
    expect(result.modelMetadata[0]?.pricing?.output).toBeCloseTo(0.21);
    expect(result.modelMetadata[0]?.pricing?.cacheRead).toBeCloseTo(0.014);
    expect(result.modelMetadata[0]?.pricing?.cacheWrite).toBeCloseTo(0.175);
  });
  test("New API price failure is recoverable without losing model discovery or exposing upstream errors", async () => {
    const result = await discoverModels(
      { baseUrl: "http://localhost/v1", type: "newapi", apiKey: key },
      async (url) =>
        url.endsWith("/models")
          ? Response.json({ data: [{ id: "custom" }] })
          : Response.json({ error: key }, { status: 403 }),
    );
    expect(result.models).toEqual(["custom"]);
    expect(result.metadataWarning).toBe("newapi_pricing_unavailable");
    expect(result.modelMetadata[0]?.pricing).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(key);
  });
  test("New API missing/invalid group, per-call and expression prices stay unknown; zero ratios remain free", async () => {
    const rows = [
      {
        model_name: "free",
        quota_type: 0,
        model_ratio: 0,
        completion_ratio: 1,
        enable_group: ["default"],
      },
      {
        model_name: "per-call",
        quota_type: 1,
        model_price: 0.1,
        enable_group: ["default"],
      },
      {
        model_name: "expression",
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        billing_mode: "tiered_expr",
        enable_group: ["default"],
      },
    ];
    const fetcher = transport(
      rows.map((m) => ({ id: m.model_name })),
      { success: true, group_ratio: { default: 1 }, data: rows },
    );
    const options = {
      baseUrl: "http://localhost/v1",
      type: "newapi" as const,
      apiKey: key,
    };
    const missing = await discoverModels(options, fetcher);
    expect(missing.metadataWarning).toBe("newapi_group_required");
    expect(missing.modelMetadata.every((m) => !m.pricing)).toBe(true);
    const invalid = await discoverModels(
      { ...options, pricingGroup: "unknown" },
      fetcher,
    );
    expect(invalid.modelMetadata.every((m) => !m.pricing)).toBe(true);
    const result = await discoverModels(
      { ...options, pricingGroup: "default" },
      fetcher,
    );
    expect(result.modelMetadata.find((m) => m.id === "free")?.pricing).toEqual({
      input: 0,
      output: 0,
    });
    expect(
      result.modelMetadata.find((m) => m.id === "expression")?.pricing,
    ).toBeUndefined();
    expect(
      result.modelMetadata.find((m) => m.id === "per-call")?.pricing,
    ).toBeUndefined();
  });
  test("invalid, oversized, unauthorized and failed model lists produce sanitized errors", async () => {
    const options = { baseUrl: "https://proxy.test/v1", apiKey: key };
    for (const [response, error] of [
      [
        Response.json({ data: [{ id: "with space" }] }),
        "model_discovery_invalid",
      ],
      [
        Response.json({
          data: Array.from({ length: 5001 }, () => ({ id: "x" })),
        }),
        "model_discovery_invalid",
      ],
      [new Response("x".repeat(1024 * 1024 + 1)), "model_discovery_too_large"],
      [
        Response.json({ error: key }, { status: 401 }),
        "model_provider_auth_failed",
      ],
      [
        Response.json({ error: key }, { status: 500 }),
        "model_discovery_failed",
      ],
    ] as const)
      await expect(
        discoverModels(options, async () => response),
      ).rejects.toThrow(error);
    await expect(
      discoverModels(options, async () => {
        throw Error(key);
      }),
    ).rejects.toThrow("model_discovery_failed");
  });
  test("runtime merges independent manual overrides, converts cached prices and leaves provider context enforcement intact", () => {
    const metadata = {
      id: "custom",
      contextWindow: 100000,
      maxOutputTokens: 20000,
      pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.4 },
      sources: { contextWindow: "api" as const, pricing: "api" as const },
    };
    const automatic = selectedModel("custom", { modelMetadata: metadata });
    expect(automatic.cost).toEqual(metadata.pricing);
    expect(automatic.providerContext).toBe(true);
    expect(
      modelCapabilities("custom", { modelMetadata: metadata }).limits,
    ).toEqual({ contextWindow: 100000, maxOutputTokens: 20000 });
    const model = selectedModel("custom", {
      modelMetadata: metadata,
      modelLimits: { maxOutputTokens: 1000 },
      modelPricing: {
        output: 30,
        cacheRead: 1,
        currency: "CNY",
        usdRate: 0.14,
      },
    });
    expect(model.cost.input).toBe(0.3);
    expect(model.cost.output).toBeCloseTo(4.2);
    expect(model.cost.cacheRead).toBe(0.14);
    expect(model.cost.cacheWrite).toBe(0.4);
    expect(model.maxTokens).toBe(1000);
  });
});
