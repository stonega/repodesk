import { Fault, requireThat } from "../domain.ts";
import type { SearchType } from "./config.ts";

export type SearchTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
const MAX_BYTES = 2 * 1024 * 1024;

async function body(response: Response) {
  requireThat(response.body, "search_provider_invalid", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      size += next.value.byteLength;
      requireThat(size <= MAX_BYTES, "search_response_too_large", 502);
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}
function plain(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
      (entity, code: string) => {
        const named: Record<string, string> = {
          amp: "&",
          quot: '"',
          apos: "'",
          lt: "<",
          gt: ">",
          nbsp: " ",
        };
        if (named[code]) return named[code];
        const number = code.toLowerCase().startsWith("#x")
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
        return Number.isInteger(number) && number > 0 && number <= 0x10ffff
          ? String.fromCodePoint(number)
          : entity;
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}
function safeUrl(value: string) {
  if (value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function duckResults(html: string, limit: number): SearchResult[] {
  requireThat(
    !/class=["'][^"']*anomaly-modal|id=["']challenge-form/i.test(html),
    "search_provider_rate_limited",
    429,
  );
  const results: SearchResult[] = [];
  const links = [
    ...html.matchAll(
      /<a\b([^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi,
    ),
  ];
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const link = links[i];
    if (!link) continue;
    const href = /href=["']([^"']*)["']/i.exec(link[1] ?? "")?.[1];
    if (!href) continue;
    let target = plain(href);
    const redirect = new URL(target, "https://duckduckgo.com");
    if (["duckduckgo.com", "html.duckduckgo.com"].includes(redirect.hostname))
      target = redirect.searchParams.get("uddg") ?? target;
    const url = safeUrl(target);
    if (!url) continue;
    const section = html.slice(
      (link.index ?? 0) + link[0].length,
      links[i + 1]?.index,
    );
    const snippet =
      /<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(
        section,
      )?.[1] ?? "";
    results.push({
      title: plain(link[2] ?? "").slice(0, 300),
      url,
      snippet: plain(snippet).slice(0, 1600),
    });
  }
  requireThat(
    links.length > 0 || /no-results|No results found/i.test(html),
    "search_provider_invalid",
    502,
  );
  return results;
}
export async function searchWeb(
  type: SearchType,
  apiKey: string | undefined,
  query: string,
  limit: number,
  signal?: AbortSignal,
  transport: SearchTransport = fetch,
) {
  const bounded = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(signal ? [signal] : []),
  ]);
  try {
    const response = await transport(
      type === "duckduckgo"
        ? `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`
        : type === "deepseek"
          ? "https://api.deepseek.com/v1/tools/search"
          : "https://api.exa.ai/search",
      {
        method: type === "duckduckgo" ? "GET" : "POST",
        redirect: "error",
        signal: bounded,
        headers:
          type === "duckduckgo"
            ? { "user-agent": "RepoDesk/1.0", accept: "text/html" }
            : {
                "content-type": "application/json",
                ...(type === "deepseek"
                  ? { authorization: `Bearer ${apiKey}` }
                  : { "x-api-key": apiKey ?? "" }),
              },
        ...(type === "duckduckgo"
          ? {}
          : {
              body: JSON.stringify(
                type === "deepseek"
                  ? { query, count: limit, need_content: false }
                  : {
                      query,
                      numResults: limit,
                      type: "auto",
                      contents: { text: { maxCharacters: 1600 } },
                    },
              ),
            }),
      },
    );
    if (!response.ok || response.status === 202) {
      await response.body?.cancel();
      throw new Fault(
        response.status === 401 || response.status === 403
          ? "search_provider_auth_failed"
          : response.status === 429 || response.status === 202
            ? "search_provider_rate_limited"
            : "search_provider_failed",
        502,
      );
    }
    const text = await body(response);
    if (type === "duckduckgo") return duckResults(text, limit);
    const data = JSON.parse(text) as { results?: unknown };
    requireThat(Array.isArray(data.results), "search_provider_invalid", 502);
    return data.results
      .slice(0, limit)
      .flatMap((row: unknown): SearchResult[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const url = typeof r.url === "string" ? safeUrl(r.url) : undefined;
        if (!url || typeof r.title !== "string") return [];
        const snippet = type === "deepseek" ? (r.summary ?? r.snippet) : r.text;
        return [
          {
            title: r.title.slice(0, 300),
            url,
            snippet: typeof snippet === "string" ? snippet.slice(0, 1600) : "",
          },
        ];
      });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Fault) throw error;
    throw new Fault(
      bounded.aborted ? "search_provider_timeout" : "search_provider_failed",
      502,
    );
  }
}
