import { describe, expect, test } from "bun:test";
import {
  duckResults,
  type SearchTransport,
  searchWeb,
} from "../../src/search/providers.ts";

describe("web search adapters", () => {
  test("DuckDuckGo decodes redirects, entities and snippets and rejects unsafe URLs", () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fa%3D1%26b%3D2">News &amp; <b>updates</b></a><a class="result__snippet">A &#x1f680; &#39;release&#39;</a><a class="result__a" href="javascript:alert(1)">Bad</a>`;
    expect(duckResults(html, 5)).toEqual([
      {
        title: "News & updates",
        url: "https://example.com/news?a=1&b=2",
        snippet: "A 🚀 'release'",
      },
    ]);
    expect(
      duckResults('<div class="no-results">No results found</div>', 5),
    ).toEqual([]);
    expect(() =>
      duckResults('<form id="challenge-form">Challenge</form>', 5),
    ).toThrow("search_provider_rate_limited");
    expect(() => duckResults("Unexpected page", 5)).toThrow(
      "search_provider_invalid",
    );
    expect(
      duckResults(
        '<a class="result__a" href="https://example.com/captcha">CAPTCHA guide</a><div class="result__snippet">How CAPTCHA works</div>',
        5,
      ),
    ).toHaveLength(1);
  });
  for (const type of ["deepseek", "exa"] as const)
    test(`${type} uses its official endpoint and bounded search format`, async () => {
      let request: { url: string; init: RequestInit } | undefined;
      const transport: SearchTransport = async (url, init) => {
        request = { url, init };
        return Response.json({
          results: [
            {
              title: "Release",
              url: "https://example.com/release",
              summary: "DeepSeek summary",
              text: "Exa excerpt",
            },
            { title: "Unsafe", url: "file:///etc/passwd" },
          ],
        });
      };
      const result = await searchWeb(
        type,
        "fixture-key",
        "release notes",
        3,
        undefined,
        transport,
      );
      expect(request?.url).toBe(
        type === "deepseek"
          ? "https://api.deepseek.com/v1/tools/search"
          : "https://api.exa.ai/search",
      );
      expect(
        new Headers(request?.init.headers).get(
          type === "deepseek" ? "authorization" : "x-api-key",
        ),
      ).toBe(type === "deepseek" ? "Bearer fixture-key" : "fixture-key");
      expect(request?.init.redirect).toBe("error");
      expect(JSON.parse(String(request?.init.body))).toEqual(
        type === "deepseek"
          ? { query: "release notes", count: 3, need_content: false }
          : {
              query: "release notes",
              numResults: 3,
              type: "auto",
              contents: { text: { maxCharacters: 1600 } },
            },
      );
      expect(result).toEqual([
        {
          title: "Release",
          url: "https://example.com/release",
          snippet: type === "deepseek" ? "DeepSeek summary" : "Exa excerpt",
        },
      ]);
    });
  test("free search never sends credentials", async () => {
    await searchWeb(
      "duckduckgo",
      undefined,
      "a & b",
      5,
      undefined,
      async (url, init) => {
        expect(new URL(url).searchParams.get("q")).toBe("a & b");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(init.body).toBeUndefined();
        return new Response('<div class="no-results">No results found</div>');
      },
    );
  });
  test("provider errors and malformed/oversized replies never expose response secrets", async () => {
    for (const status of [401, 402, 429, 500]) {
      await expect(
        searchWeb(
          "exa",
          "secret",
          "query",
          5,
          undefined,
          async () => new Response("secret", { status }),
        ),
      ).rejects.toThrow(
        status === 401
          ? "search_provider_auth_failed"
          : status === 429
            ? "search_provider_rate_limited"
            : "search_provider_failed",
      );
    }
    await expect(
      searchWeb(
        "exa",
        "secret",
        "query",
        5,
        undefined,
        async () => new Response("secret"),
      ),
    ).rejects.toThrow("search_provider_failed");
    await expect(
      searchWeb("exa", "secret", "query", 5, undefined, async () =>
        Response.json({ unexpected: true }),
      ),
    ).rejects.toThrow("search_provider_invalid");
    await expect(
      searchWeb(
        "exa",
        "secret",
        "query",
        5,
        undefined,
        async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      ),
    ).rejects.toThrow("search_response_too_large");
  });
  test("cancellation is preserved", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      searchWeb(
        "exa",
        "secret",
        "query",
        5,
        controller.signal,
        async (_url, init) => {
          init.signal?.throwIfAborted();
          return Response.json({ results: [] });
        },
      ),
    ).rejects.toThrow("cancelled");
  });
});
