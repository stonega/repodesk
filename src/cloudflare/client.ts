import { Fault, requireThat } from "../domain.ts";

export type CloudflareTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
type Row = Record<string, unknown>;
export const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export function pick(value: unknown, keys: string[]) {
  const source = row(value);
  return Object.fromEntries(
    keys.filter((k) => k in source).map((k) => [k, source[k]]),
  );
}
export function dnsRecord(value: unknown) {
  return pick(value, [
    "id",
    "type",
    "name",
    "content",
    "ttl",
    "proxied",
    "priority",
    "modified_on",
  ]);
}
function deployment(value: unknown): Row {
  const source = row(value);
  return {
    ...pick(source, [
      "id",
      "project_name",
      "environment",
      "url",
      "created_on",
      "modified_on",
    ]),
    latest_stage: pick(source.latest_stage, [
      "name",
      "status",
      "started_on",
      "ended_on",
    ]),
  };
}
export function project(value: unknown): Row {
  const source = row(value);
  return {
    ...pick(source, [
      "id",
      "name",
      "subdomain",
      "domains",
      "production_branch",
    ]),
    latest_deployment: source.latest_deployment
      ? deployment(source.latest_deployment)
      : null,
  };
}
export { deployment };

/** Fixed API origin, no redirects/retries, bounded bodies, and no upstream error text. */
export class CloudflareClient {
  constructor(private transport: CloudflareTransport = fetch) {}
  async request(
    token: string,
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      signal?: AbortSignal;
      guard: () => Promise<void>;
    },
  ) {
    await options.guard();
    options.signal?.throwIfAborted();
    const writing = options.method && options.method !== "GET";
    let response: Response;
    let data: Row;
    try {
      response = await this.transport(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method: options.method ?? "GET",
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
      requireThat(!response.redirected, "cloudflare_unavailable", 502);
      const reader = response.body?.getReader();
      requireThat(reader, "cloudflare_unavailable", 502);
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          requireThat(
            size <= 1024 * 1024,
            "cloudflare_response_too_large",
            502,
          );
          parts.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      data = row(JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch {
      throw new Fault(
        writing ? "cloudflare_outcome_unknown" : "cloudflare_unavailable",
        502,
      );
    }
    if (!response.ok || data.success !== true) {
      if (writing && (response.status >= 500 || response.ok))
        throw new Fault("cloudflare_outcome_unknown", 502);
      throw new Fault(
        response.status === 401 || response.status === 403
          ? "cloudflare_access_denied"
          : response.status === 429
            ? "cloudflare_rate_limited"
            : "cloudflare_request_failed",
        409,
      );
    }
    if (!writing) {
      await options.guard();
      options.signal?.throwIfAborted();
    }
    return {
      result: data.result,
      result_info: pick(data.result_info, [
        "page",
        "per_page",
        "count",
        "total_count",
        "total_pages",
      ]),
    };
  }
}
