import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { hash } from "../setup/credentials.ts";
import type { CloudflareTransport } from "./client.ts";

const secret = z
  .string()
  .min(1)
  .max(16000)
  .regex(/^[\x21-\x7e]+$/);
const tokens = z.object({
  access_token: secret,
  refresh_token: secret.optional(),
  token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
});
export type OAuthTokens = z.infer<typeof tokens>;

/** Only Cloudflare's published OAuth endpoints; no discovery, redirects or retries. */
export class CloudflareOAuthClient {
  constructor(private transport: CloudflareTransport = fetch) {}
  authorizationUrl(
    clientId: string,
    scopes: string[],
    state: string,
    verifier: string,
    redirectUri: string,
  ) {
    const url = new URL("https://dash.cloudflare.com/oauth2/auth");
    for (const [key, value] of Object.entries({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
      scope: [...new Set([...scopes, "offline_access"])].join(" "),
      code_challenge: Buffer.from(hash(verifier), "hex").toString("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }
  private async request(
    clientId: string,
    clientSecret: string,
    endpoint: "token" | "revoke",
    fields: Record<string, string>,
  ) {
    try {
      const response = await this.transport(
        `https://dash.cloudflare.com/oauth2/${endpoint}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
          },
          body: new URLSearchParams(fields).toString(),
        },
      );
      requireThat(
        response.ok && !response.redirected,
        "cloudflare_oauth_failed",
        409,
      );
      if (endpoint === "revoke") {
        await response.body?.cancel();
        return;
      }
      const reader = response.body?.getReader();
      requireThat(reader, "cloudflare_oauth_failed", 409);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireThat(size <= 65536, "cloudflare_oauth_failed", 409);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return tokens.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new Fault("cloudflare_oauth_failed", 409);
    }
  }
  async exchange(
    clientId: string,
    clientSecret: string,
    code: string,
    verifier: string,
    redirectUri: string,
  ) {
    const result = await this.request(clientId, clientSecret, "token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    requireThat(result, "cloudflare_oauth_failed", 409);
    return result;
  }
  async refresh(clientId: string, clientSecret: string, refreshToken: string) {
    const result = await this.request(clientId, clientSecret, "token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    requireThat(result, "cloudflare_oauth_failed", 409);
    return result;
  }
  async revoke(
    clientId: string,
    clientSecret: string,
    value: string,
    refresh = true,
  ) {
    await this.request(clientId, clientSecret, "revoke", {
      token: value,
      token_type_hint: refresh ? "refresh_token" : "access_token",
    });
  }
}
