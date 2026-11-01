import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { BrowserEgress, browserDestination } from "../../src/browser/egress.ts";

describe("headed browser network boundary", () => {
  const policy = {
    origins: ["https://example.com"],
    previewOrigins: [] as string[],
    interact: false,
  };
  test("pins a validated DNS answer and rejects mixed/rebinding answers", async () => {
    expect(
      await browserDestination(
        new URL("https://example.com"),
        policy,
        async () => [{ address: "93.184.216.34", family: 4 }],
      ),
    ).toEqual({ address: "93.184.216.34", family: 4, port: 443 });
    await expect(
      browserDestination(new URL("https://example.com"), policy, async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("browser_destination_denied");
  });
  test("blocks local/private/metadata ranges and non-web protocols", async () => {
    for (const url of [
      "http://127.0.0.1",
      "http://169.254.169.254",
      "http://10.0.0.1",
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",
      "file:///etc/passwd",
      "http://localhost",
      "http://a.internal",
      "https://name:password@example.com",
    ])
      await expect(browserDestination(new URL(url), policy)).rejects.toThrow(
        "browser_destination_denied",
      );
  });
  test("allows only exact authorized loopback preview origins", async () => {
    const local = {
      ...policy,
      origins: ["http://127.0.0.1:3100"],
      previewOrigins: ["http://127.0.0.1:3100"],
    };
    expect(
      (await browserDestination(new URL("http://127.0.0.1:3100/app"), local))
        .port,
    ).toBe(3100);
    await expect(
      browserDestination(new URL("http://127.0.0.1:3101"), local),
    ).rejects.toThrow();
    await expect(
      browserDestination(new URL("http://169.254.169.254"), {
        ...local,
        previewOrigins: ["http://169.254.169.254"],
      }),
    ).rejects.toThrow();
  });
  test("released or ungranted sessions have no network access", async () => {
    await expect(
      browserDestination(new URL("https://example.com"), {
        ...policy,
        origins: [],
      }),
    ).rejects.toThrow("browser_destination_denied");
    let dnsCalls = 0;
    await expect(
      browserDestination(
        new URL("https://another.example"),
        policy,
        async () => {
          dnsCalls++;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      ),
    ).rejects.toThrow("browser_destination_denied");
    expect(dnsCalls).toBe(0);
    await expect(
      browserDestination(new URL("http://127.0.0.1:3100"), {
        ...policy,
        previewOrigins: ["http://127.0.0.1:3100"],
      }),
    ).rejects.toThrow("browser_destination_denied");
  });

  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  async function site() {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      expect(req.headers["proxy-authorization"]).toBeUndefined();
      res.end("fixture page");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test listener");
    return { origin: `http://127.0.0.1:${address.port}`, calls: () => calls };
  }
  async function proxy(origins: string[]) {
    const egress = new BrowserEgress({
      origins,
      previewOrigins: origins,
      interact: false,
    });
    const endpoint = await egress.start();
    cleanup.push(() => egress.close());
    return { ...endpoint, egress };
  }
  function get(
    endpoint: { port: number; password: string },
    url: string,
    authenticated = true,
  ) {
    return new Promise<{ status?: number; text: string }>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: endpoint.port });
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("connect", () =>
        socket.write(
          `GET ${url}/ HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n${authenticated ? `Proxy-Authorization: Basic ${Buffer.from(`browser:${endpoint.password}`).toString("base64")}\r\n` : ""}\r\n`,
        ),
      );
      socket.on("data", (part) => {
        raw += part;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        const [headers, text = ""] = raw.split("\r\n\r\n");
        resolve({ status: Number(headers?.split(" ")[1]), text });
      });
    });
  }
  test("authenticates the per-profile proxy and never forwards its credentials", async () => {
    const fixture = await site(),
      endpoint = await proxy([fixture.origin]);
    expect((await get(endpoint, fixture.origin, false)).status).toBe(407);
    expect(fixture.calls()).toBe(0);
    expect(await get(endpoint, fixture.origin)).toEqual({
      status: 200,
      text: "fixture page",
    });
    expect(fixture.calls()).toBe(1);
  });
  test("revoking preview authority blocks the next request without contacting the target", async () => {
    const fixture = await site(),
      endpoint = await proxy([fixture.origin]);
    endpoint.egress.update({
      origins: [],
      previewOrigins: [],
      interact: false,
    });
    expect((await get(endpoint, fixture.origin)).status).toBe(403);
    expect(fixture.calls()).toBe(0);
  });
  test("a request awaiting DNS cannot connect after revocation", async () => {
    let finish!: (value: { address: string; family: number }[]) => void;
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => {
      resolving = resolve;
    });
    const egress = new BrowserEgress(policy, () => {
      resolving();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const endpoint = await egress.start();
    cleanup.push(() => egress.close());
    // This helper sends GET through a plain HTTP proxy, so use an HTTP grant.
    egress.update({ ...policy, origins: ["http://example.com"] });
    const pending = get(endpoint, "http://example.com");
    await started;
    egress.update({ ...policy, origins: [] });
    finish([{ address: "93.184.216.34", family: 4 }]);
    // Revocation destroys an accepted connection; no target response is exposed.
    expect((await pending).status).not.toBe(200);
  });
});
