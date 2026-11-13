import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicWebAddress, publicWebUrl } from "../web-reader/service.ts";
import { assertJson, type Json, PluginError } from "./contract.ts";

type Address = { address: string; family: number };
export type PluginHttpTransport = (
  url: URL,
  address: Address,
  bearer: string | undefined,
  signal: AbortSignal,
) => Promise<{
  status: number;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  cancel: () => void;
}>;
const transport: PluginHttpTransport = (url, address, bearer, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        signal,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": "RepoDesk plugin broker",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          body: response,
          cancel: () => response.destroy(),
        }),
    );
    req.on("error", reject);
    req.end();
  });
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PluginError("plugin_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export class PluginHttpReader {
  constructor(
    private resolve: (host: string) => Promise<Address[]> = (host) =>
      lookup(host, { all: true, verbatim: true }),
    private send: PluginHttpTransport = transport,
  ) {}
  async read(
    origin: string,
    path: string,
    query: Record<string, string>,
    bearer: string | undefined,
    external: AbortSignal,
  ): Promise<{ status: number; data: Json }> {
    const signal = AbortSignal.any([external, AbortSignal.timeout(10000)]);
    try {
      if (!path.startsWith("/") || /[%\\?#]/.test(path))
        throw new PluginError("plugin_permission_denied");
      const url = publicWebUrl(new URL(path, origin).href);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.pathname !== path
      )
        throw new PluginError("plugin_permission_denied");
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, value);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      signal.throwIfAborted();
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await abortable(this.resolve(host), signal);
      signal.throwIfAborted();
      if (
        !addresses.length ||
        !addresses.every((entry) => publicWebAddress(entry.address))
      )
        throw new PluginError("plugin_permission_denied");
      const selected = addresses[0];
      if (!selected) throw new PluginError("plugin_permission_denied");
      const response = await this.send(url, selected, bearer, signal);
      try {
        // No redirect or authentication-header/cookie forwarding to the plugin.
        if (response.status < 200 || response.status >= 300)
          throw new PluginError("plugin_execution_failed");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          size += chunk.length;
          if (size > 100000) throw new PluginError("plugin_result_invalid");
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (bearer && text.includes(bearer))
          throw new PluginError("plugin_result_invalid");
        const data: unknown = JSON.parse(text);
        assertJson(data, 100000);
        return { status: response.status, data };
      } finally {
        response.cancel();
      }
    } catch (error) {
      external.throwIfAborted();
      if (signal.aborted) throw new PluginError("plugin_timeout");
      if (error instanceof PluginError) throw error;
      throw new PluginError("plugin_execution_failed");
    }
  }
}
