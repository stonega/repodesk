import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { Fault, requireThat } from "../domain.ts";

const maxBytes = 2 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], // IETF special-purpose addresses, including Teredo.
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can encode private IPv4 destinations.
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

export function publicWebAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function publicWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Fault("web_read_invalid_url");
  }
  requireThat(
    value.length <= 2048 &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port,
    "web_read_invalid_url",
  );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  requireThat(
    !/^(localhost|.*\.(localhost|local|internal|home|lan))\.?$/i.test(
      hostname,
    ) &&
      (!isIP(hostname) || publicWebAddress(hostname)),
    "web_read_destination_denied",
  );
  url.hash = "";
  return url;
}

type Address = { address: string; family: number };
export type WebResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
};
export type WebTransport = (
  url: URL,
  address: Address,
  signal: AbortSignal,
) => Promise<WebResponse>;
export type WebPage = {
  url: string;
  title: string;
  description: string;
  author: string;
  published: string;
  markdown: string;
  truncated: boolean;
};

export const requestPage: WebTransport = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        signal,
        // Keep the original hostname for Host/SNI/certificate verification, but
        // connect only to the checked IP. Never resolve it again in the socket.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          "User-Agent": "RepoDesk/1.0 (web reader)",
          Accept: "text/html, application/xhtml+xml",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
          cancel: () => res.destroy(),
        });
      },
    );
    req.once("error", reject);
    req.end();
  });

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export function extractWebPage(html: string, url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Omit<WebPage, "url">>((resolve, reject) => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./web-reader-extract.ts"
          : "./web-reader-extract.js",
        import.meta.url,
      ),
      {
        workerData: { html, url },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        stdout: true,
        stderr: true,
      },
    );
    // Extractor diagnostics can include raw page contents. Never forward them
    // into routine logs, including when malformed schema metadata is rejected.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value) => {
      cleanup();
      resolve(value);
    });
    worker.once("error", () => {
      cleanup();
      reject(new Fault("web_read_extraction_failed"));
    });
    worker.once("exit", () => {
      cleanup();
      reject(new Fault("web_read_extraction_failed"));
    });
  });
}

export class WebReader {
  constructor(
    private transport: WebTransport = requestPage,
    private resolve: (hostname: string) => Promise<Address[]> = (hostname) =>
      lookup(hostname, { all: true, verbatim: true }),
    private extract = extractWebPage,
    private timeoutMs = 20000,
  ) {}
  async read(value: string, externalSignal?: AbortSignal): Promise<WebPage> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeout])
      : timeout;
    let url = publicWebUrl(value);
    try {
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await abortable(this.resolve(hostname), signal);
        requireThat(
          addresses.length &&
            addresses.every((a) => publicWebAddress(a.address)),
          "web_read_destination_denied",
        );
        const address = addresses[0];
        requireThat(address, "web_read_destination_denied");
        const response = await this.transport(url, address, signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            requireThat(location && redirects < 5, "web_read_redirect_failed");
            url = publicWebUrl(new URL(location, url).href);
            continue;
          }
          requireThat(
            response.status >= 200 && response.status < 300,
            "web_read_http_failed",
          );
          const contentType = response.headers.get("content-type") ?? "";
          requireThat(
            /^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(
              contentType,
            ),
            "web_read_unsupported_content",
          );
          requireThat(
            Number(response.headers.get("content-length") ?? 0) <= maxBytes,
            "web_read_too_large",
          );
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            size += chunk.length;
            requireThat(size <= maxBytes, "web_read_too_large");
            chunks.push(Buffer.from(chunk));
          }
          let body = Buffer.concat(chunks);
          const encoding = response.headers.get("content-encoding");
          if (encoding && encoding !== "identity") {
            const decompress = {
              gzip: promisify(gunzip),
              deflate: promisify(inflate),
              br: promisify(brotliDecompress),
            }[encoding.toLowerCase()];
            requireThat(decompress, "web_read_unsupported_content");
            try {
              body = await abortable(
                decompress(body, { maxOutputLength: maxBytes }),
                signal,
              );
            } catch {
              signal.throwIfAborted();
              throw new Fault("web_read_decode_failed");
            }
          }
          const charset = contentType.match(
            /charset\s*=\s*["']?([^\s;"']+)/i,
          )?.[1];
          const html = new TextDecoder(charset || "utf-8").decode(body);
          const page = await this.extract(html, url.href, signal);
          signal.throwIfAborted();
          requireThat(page.markdown.trim(), "web_read_empty");
          return { url: url.href, ...page };
        } finally {
          response.cancel();
        }
      }
    } catch (error) {
      externalSignal?.throwIfAborted();
      if (timeout.aborted) throw new Fault("web_read_timeout");
      if (error instanceof Fault && error.code.startsWith("web_read_"))
        throw error;
      throw new Fault("web_read_failed");
    }
  }
}
