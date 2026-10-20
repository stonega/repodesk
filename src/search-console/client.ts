import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { type ServiceAccount, serviceAccountSchema } from "./config.ts";

export type SearchConsoleTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
const tokenUrl = "https://oauth2.googleapis.com/token";
export const searchConsoleScope =
  "https://www.googleapis.com/auth/webmasters.readonly";
export function parseServiceAccount(value: string): ServiceAccount {
  try {
    const account = serviceAccountSchema.parse(JSON.parse(value));
    const key = createPrivateKey(account.private_key);
    requireThat(
      key.asymmetricKeyType === "rsa" &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
      "search_console_invalid_credential",
    );
    return account;
  } catch {
    throw new Fault("search_console_invalid_credential");
  }
}
type Options = { guard: () => Promise<void>; signal?: AbortSignal };
export class SearchConsoleClient {
  constructor(private transport: SearchConsoleTransport = fetch) {}
  private async request(
    url: string,
    init: RequestInit,
    options: Options,
  ): Promise<unknown> {
    await options.guard();
    options.signal?.throwIfAborted();
    let response: Response;
    let data: unknown;
    try {
      response = await this.transport(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      requireThat(!response.redirected, "search_console_unavailable", 502);
      const reader = response.body?.getReader();
      requireThat(reader, "search_console_unavailable", 502);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireThat(
            size <= 1024 * 1024,
            "search_console_response_too_large",
            502,
          );
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Fault("search_console_unavailable", 502);
    }
    await options.guard();
    options.signal?.throwIfAborted();
    if (!response.ok)
      throw new Fault(
        response.status === 401 || response.status === 403
          ? "search_console_access_denied"
          : response.status === 429
            ? "search_console_rate_limited"
            : "search_console_request_failed",
        409,
      );
    return data;
  }
  async token(account: ServiceAccount, options: Options) {
    const encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: searchConsoleScope, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url")}`;
    const data = await this.request(
      tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
      options,
    );
    const result = z
      .object({
        access_token: z.string().min(1).max(8192),
        token_type: z.literal("Bearer"),
      })
      .safeParse(data);
    requireThat(result.success, "search_console_invalid_response", 502);
    return result.data.access_token;
  }
  async api(
    token: string,
    path: string,
    options: Options,
    body?: unknown,
    inspection = false,
  ) {
    requireThat(
      inspection
        ? path === "urlInspection/index:inspect"
        : /^sites(?:\/|$)/.test(path),
      "search_console_invalid_request",
    );
    return this.request(
      `${inspection ? "https://searchconsole.googleapis.com/v1/" : "https://www.googleapis.com/webmasters/v3/"}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      options,
    );
  }
}
