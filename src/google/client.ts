import { Fault, requireThat } from "../domain.ts";

export type GoogleTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type Row = Record<string, unknown>;
export const row = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
export const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
export function pick(v: unknown, keys: string[]) {
  const source = row(v);
  return Object.fromEntries(
    keys.filter((k) => k in source).map((k) => [k, source[k]]),
  );
}
/** Fixed Google endpoints, bounded responses, no redirects/retries or upstream error text. */
export class GoogleClient {
  constructor(private transport: GoogleTransport = fetch) {}
  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Row> {
    let response: Response;
    let data: Row;
    try {
      response = await this.transport(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
      });
      requireThat(
        !response.redirected &&
          (response.status < 300 || response.status >= 400),
        "google_unavailable",
        502,
      );
      const reader = response.body?.getReader();
      requireThat(reader, "google_invalid_response", 502);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireThat(size <= 1024 * 1024, "google_response_too_large", 502);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      data = row(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (cause) {
      if (cause instanceof Fault) throw cause;
      throw new Fault("google_unavailable", 502);
    }
    if (!response.ok)
      throw new Fault(
        data.error === "invalid_grant" || response.status === 401
          ? "google_reconnect_required"
          : response.status === 403
            ? "google_access_denied"
            : response.status === 429
              ? "google_rate_limited"
              : "google_request_failed",
        409,
      );
    requireThat(!data.error, "google_request_failed", 502);
    return data;
  }
  token(parameters: Record<string, string>, signal?: AbortSignal) {
    return this.request(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters).toString(),
      },
      signal,
    );
  }
  async get(
    url: URL,
    token: string,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    requireThat(
      [
        "https://docs.googleapis.com",
        "https://sheets.googleapis.com",
        "https://www.googleapis.com",
        "https://gmail.googleapis.com",
        "https://openidconnect.googleapis.com",
      ].includes(url.origin),
      "google_invalid_request",
    );
    await guard();
    signal?.throwIfAborted();
    const data = await this.request(
      url.toString(),
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      signal,
    );
    await guard();
    signal?.throwIfAborted();
    return data;
  }
}
