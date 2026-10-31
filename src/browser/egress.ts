import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { requireThat } from "../domain.ts";
import { equal } from "../setup/credentials.ts";
import { publicWebAddress } from "../web-reader/service.ts";
import { browserLimits } from "./config.ts";
import type { BrowserHostPolicy } from "./protocol.ts";

type Address = { address: string; family: number };
export type BrowserDns = (hostname: string) => Promise<Address[]>;

/** Resolve once, reject mixed public/private DNS, then connect to that exact IP. */
export async function browserDestination(
  url: URL,
  policy: BrowserHostPolicy,
  resolve: BrowserDns = (name) => lookup(name, { all: true, verbatim: true }),
) {
  requireThat(
    policy.origins.includes(url.origin),
    "browser_destination_denied",
    403,
  );
  requireThat(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password,
    "browser_destination_denied",
    403,
  );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const preview = policy.previewOrigins.includes(url.origin);
  requireThat(
    !/^(.*\.)?(localhost|local|internal|home|lan)\.?$/i.test(hostname) ||
      preview,
    "browser_destination_denied",
    403,
  );
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  requireThat(
    preview || [80, 443].includes(port) || policy.origins.includes(url.origin),
    "browser_destination_denied",
    403,
  );
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname);
  requireThat(
    addresses.length &&
      addresses.every(
        (address) =>
          publicWebAddress(address.address) ||
          (preview && ["127.0.0.1", "::1"].includes(address.address)),
      ),
    "browser_destination_denied",
    403,
  );
  const address = addresses[0];
  requireThat(address, "browser_destination_denied", 403);
  return { ...address, port };
}

/** The supervisor owns this proxy; the browser UID may connect only to its port. */
export class BrowserEgress {
  readonly password = randomBytes(32).toString("base64url");
  private server?: Server;
  private sockets = new Set<Socket>();
  private policy: BrowserHostPolicy;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(
    policy: BrowserHostPolicy,
    private resolve?: BrowserDns,
    private authorizationMs: number = browserLimits.leaseMs,
  ) {
    this.policy = structuredClone(policy);
    this.renew();
  }
  renew() {
    if (this.expiry) clearTimeout(this.expiry);
    if (!this.policy.origins.length) return false;
    this.expiry = setTimeout(
      () => this.update({ origins: [], previewOrigins: [], interact: false }),
      this.authorizationMs,
    );
    this.expiry.unref();
    return true;
  }
  update(policy: BrowserHostPolicy) {
    this.policy = structuredClone(policy);
    // A handoff cannot retain an older consumer's open authenticated tunnels.
    for (const socket of this.sockets) socket.destroy();
    this.renew();
  }
  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
  private async destination(url: URL) {
    const policy = this.policy;
    const destination = await browserDestination(url, policy, this.resolve);
    requireThat(policy === this.policy, "browser_destination_denied", 403);
    return destination;
  }
  private authorized(req: IncomingMessage) {
    return equal(
      req.headers["proxy-authorization"] ?? "",
      `Basic ${Buffer.from(`browser:${this.password}`).toString("base64")}`,
    );
  }
  async start() {
    const server = createServer(async (req, res) => {
      if (!this.authorized(req)) {
        res.writeHead(407, {
          "proxy-authenticate": 'Basic realm="RepoDesk Browser"',
        });
        res.end();
        return;
      }
      let outgoing: ReturnType<typeof request> | undefined;
      try {
        const url = new URL(req.url ?? "");
        requireThat(
          url.protocol === "http:",
          "browser_destination_denied",
          403,
        );
        const target = await this.destination(url);
        requireThat(!res.destroyed, "browser_destination_denied", 403);
        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
          host: url.host,
        };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        outgoing = request(
          {
            hostname: target.address,
            family: target.family,
            port: target.port,
            path: url.pathname + url.search,
            method: req.method,
            headers,
            agent: false,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.on("error", () => res.destroy());
            response.pipe(res);
          },
        );
        outgoing.setTimeout(30_000, () => outgoing?.destroy());
        outgoing.on("socket", (socket) => this.track(socket));
        outgoing.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.once("aborted", () => outgoing?.destroy());
        res.once("close", () => outgoing?.destroy());
        req.pipe(outgoing);
      } catch {
        outgoing?.destroy();
        res.writeHead(403);
        res.end();
      }
    });
    server.on("connection", (socket) => {
      if (this.sockets.size >= 128) {
        socket.destroy();
        return;
      }
      this.track(socket);
    });
    server.on("connect", async (req, client, head) => {
      client.on("error", () => {});
      if (!this.authorized(req)) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="RepoDesk Browser"\r\n\r\n',
        );
        return;
      }
      try {
        const authority = new URL(`https://${req.url ?? ""}`);
        requireThat(
          authority.pathname === "/" &&
            !authority.search &&
            !authority.hash &&
            !authority.username &&
            !authority.password,
          "browser_destination_denied",
          403,
        );
        // Chrome also uses CONNECT for plain WebSockets. CONNECT carries only
        // host:port, so select the exact already-authorized network endpoint.
        const origin = this.policy.origins.find((value) => {
          const allowed = new URL(value);
          return (
            allowed.hostname === authority.hostname &&
            Number(
              allowed.port || (allowed.protocol === "https:" ? 443 : 80),
            ) === Number(authority.port || 443)
          );
        });
        requireThat(origin, "browser_destination_denied", 403);
        const target = await this.destination(new URL(origin));
        requireThat(!client.destroyed, "browser_destination_denied", 403);
        const upstream = connect({
          host: target.address,
          family: target.family,
          port: target.port,
        });
        this.track(upstream);
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.once("close", () => upstream.destroy());
        client.on("error", () => upstream.destroy());
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    });
    server.on("upgrade", async (req, client, head) => {
      client.on("error", () => {});
      if (!this.authorized(req)) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="RepoDesk Browser"\r\n\r\n',
        );
        return;
      }
      try {
        const url = new URL(req.url ?? "");
        if (url.protocol === "ws:") url.protocol = "http:";
        requireThat(
          url.protocol === "http:" && req.method === "GET",
          "browser_destination_denied",
          403,
        );
        const target = await this.destination(url);
        requireThat(!client.destroyed, "browser_destination_denied", 403);
        const upstream = connect({
          host: target.address,
          family: target.family,
          port: target.port,
        });
        this.track(upstream);
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          const headers = Object.entries(req.headers)
            .filter(([name]) => !name.startsWith("proxy-") && name !== "host")
            .map(
              ([name, value]) =>
                `${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
            )
            .join("\r\n");
          upstream.write(
            `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\n\r\n`,
          );
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const address = server.address();
    requireThat(
      address && typeof address !== "string",
      "browser_service_unavailable",
      503,
    );
    return {
      server: `http://127.0.0.1:${address.port}`,
      port: address.port,
      username: "browser",
      password: this.password,
    };
  }
  async close() {
    this.update({ origins: [], previewOrigins: [], interact: false });
    if (this.server)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
