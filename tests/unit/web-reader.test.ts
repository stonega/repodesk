import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import {
  extractWebPage,
  publicWebAddress,
  publicWebUrl,
  requestPage,
  WebReader,
  type WebResponse,
  type WebTransport,
} from "../../src/web-reader/service.ts";

const article = `<!doctype html><html><head><title>Reading pages</title>
<meta name="author" content="A Writer"><meta name="description" content="Article description">
<meta property="article:published_time" content="2026-10-20T00:00:00Z"></head>
<body><nav>Unrelated navigation</nav><main><h1>Reading pages</h1>
<p>Here is a <strong>useful article</strong> with enough words to explain the important details of reading public web pages safely.</p>
<p>Read the <a href="/reference">reference guide</a> for further information and examples of the extraction process.</p>
<script>throw new Error('page scripts must never run')</script></main><footer>Unrelated footer</footer></body></html>`;
const response = (
  body: string | Uint8Array = article,
  status = 200,
  headers: Record<string, string> = {},
): WebResponse => ({
  status,
  headers: new Headers({
    "content-type": "text/html; charset=utf-8",
    ...headers,
  }),
  body: (async function* () {
    yield typeof body === "string" ? Buffer.from(body) : body;
  })(),
  cancel() {},
});
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];

describe("public web reader", () => {
  test("HTTP transport pins the socket while preserving Host and sends no cookies or credentials", async () => {
    const requests: {
      host?: string;
      cookie?: string;
      authorization?: string;
    }[] = [];
    const server = createServer((req, res) => {
      requests.push({
        host: req.headers.host,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "session=private",
      });
      res.end(article);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("missing fixture address");
      const url = new URL(
        `http://unresolvable.invalid:${address.port}/article`,
      );
      for (let call = 0; call < 2; call++) {
        // Test the low-level transport directly; the reader separately rejects
        // loopback addresses and nonstandard ports before invoking it.
        const result = await requestPage(
          url,
          { address: "127.0.0.1", family: 4 },
          AbortSignal.timeout(1000),
        );
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of result.body) chunks.push(chunk);
          expect(Buffer.concat(chunks).toString()).toBe(article);
        } finally {
          result.cancel();
        }
      }
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          host: url.host,
          cookie: undefined,
          authorization: undefined,
        })),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("Defuddle extracts Markdown and metadata without scripts or navigation", async () => {
    const page = await new WebReader(
      async () => response(),
      resolvePublic,
    ).read("https://example.com/article#section");
    expect(page.url).toBe("https://example.com/article");
    expect(page.title).toBe("Reading pages");
    expect(page.author).toBe("A Writer");
    expect(page.description).toBe("Article description");
    expect(page.published).toContain("2026-10-20");
    expect(page.markdown).toContain("**useful article**");
    expect(page.markdown).toContain("https://example.com/reference");
    expect(page.markdown).not.toContain("Unrelated");
    expect(page.markdown).not.toContain("throw new Error");
    expect(page.truncated).toBe(false);
  });

  test("reserved IPv4, IPv6, mapped IPv4 and unusual numeric IPs are denied", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.2.3",
      "192.168.1.1",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.1.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.1.1.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "64:ff9b::a00:1",
      "2001::1",
      "2001:db8::1",
      "2002:a00:1::1",
      "3fff::1",
    ])
      expect(publicWebAddress(address)).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(publicWebAddress(address)).toBe(true);
    for (const url of [
      "http://2130706433",
      "http://0177.0.0.1",
      "http://0x7f000001",
      "http://[::ffff:7f00:1]",
      "http://localhost.",
      "http://a.local",
      "http://metadata.google.internal",
    ])
      expect(() => publicWebUrl(url)).toThrow("web_read_destination_denied");
  });

  test("URLs reject credentials, arbitrary ports, non-web schemes and excessive length", () => {
    for (const url of [
      "not a url",
      "file:///etc/passwd",
      "ftp://example.com/file",
      "data:text/html,hello",
      "https://user:secret@example.com",
      "https://example.com:8443",
      `https://example.com/${"x".repeat(2048)}`,
    ])
      expect(() => publicWebUrl(url)).toThrow("web_read_invalid_url");
    expect(publicWebUrl("https://example.com:443/a#b").href).toBe(
      "https://example.com/a",
    );
  });

  test("every DNS answer must be public, including mixed public/private answers", async () => {
    let requests = 0;
    for (const addresses of [
      [],
      [{ address: "10.0.0.1", family: 4 }],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "::1", family: 6 },
      ],
    ]) {
      const reader = new WebReader(
        async () => {
          requests++;
          return response();
        },
        async () => addresses,
      );
      await expect(reader.read("https://example.com")).rejects.toThrow(
        "web_read_destination_denied",
      );
    }
    expect(requests).toBe(0);
  });

  test("redirects are revalidated, use a pinned address and preserve the final citation URL", async () => {
    const requests: string[] = [],
      dns: string[] = [],
      cancelled: string[] = [];
    const transport: WebTransport = async (url, address) => {
      requests.push(url.href);
      expect(address).toEqual({ address: "93.184.216.34", family: 4 });
      const result =
        requests.length === 1
          ? response("", 302, {
              location: "https://other.example/article#part",
            })
          : response();
      result.cancel = () => {
        cancelled.push(url.href);
      };
      return result;
    };
    const reader = new WebReader(transport, async (host) => {
      dns.push(host);
      return resolvePublic();
    });
    expect((await reader.read("https://example.com/start")).url).toBe(
      "https://other.example/article",
    );
    expect(dns).toEqual(["example.com", "other.example"]);
    expect(cancelled).toHaveLength(2);
    for (const location of [
      "http://127.0.0.1",
      "file:///etc/passwd",
      "https://private.example",
    ]) {
      let calls = 0;
      const denied = new WebReader(
        async () => {
          calls++;
          return response("", 302, { location });
        },
        async (host) =>
          host === "private.example"
            ? [{ address: "10.0.0.1", family: 4 }]
            : resolvePublic(),
      );
      await expect(denied.read("https://example.com")).rejects.toThrow(
        /web_read_(destination_denied|invalid_url)/,
      );
      expect(calls).toBe(1);
    }
  });

  test("redirect loops, missing locations, HTTP failures and non-HTML responses fail safely", async () => {
    for (const [fixture, error] of [
      [response("", 301, { location: "/loop" }), "web_read_redirect_failed"],
      [response("", 302), "web_read_redirect_failed"],
      [response("private upstream error", 401), "web_read_http_failed"],
      [
        response("%PDF", 200, { "content-type": "application/pdf" }),
        "web_read_unsupported_content",
      ],
      [
        response("{}", 200, { "content-type": "application/json" }),
        "web_read_unsupported_content",
      ],
    ] as const) {
      await expect(
        new WebReader(async () => fixture, resolvePublic).read(
          "https://example.com",
        ),
      ).rejects.toThrow(error);
    }
  });

  test("compressed HTML works and compressed/decompressed/streamed limits apply", async () => {
    const reader = new WebReader(
      async () =>
        response(gzipSync(article), 200, { "content-encoding": "gzip" }),
      resolvePublic,
    );
    expect((await reader.read("https://example.com")).markdown).toContain(
      "**useful article**",
    );
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
    for (const [fixture, error] of [
      [
        response("", 200, { "content-length": String(huge.length) }),
        "web_read_too_large",
      ],
      [response(huge), "web_read_too_large"],
      [
        response(gzipSync(huge), 200, { "content-encoding": "gzip" }),
        "web_read_decode_failed",
      ],
    ] as const)
      await expect(
        new WebReader(async () => fixture, resolvePublic).read(
          "https://example.com",
        ),
      ).rejects.toThrow(error);
  });

  test("extraction truncates content explicitly and fails empty pages", async () => {
    const content = `<html><head><title>Long page</title></head><body><main>${"<p>A long paragraph with several words about this particular example and its interesting details.</p>".repeat(400)}</main></body></html>`;
    const page = await new WebReader(
      async () => response(content),
      resolvePublic,
    ).read("https://example.com");
    expect(page.markdown.length).toBe(24000);
    expect(page.truncated).toBe(true);
    await expect(
      new WebReader(
        async () => response("<html><body></body></html>"),
        resolvePublic,
      ).read("https://example.com"),
    ).rejects.toThrow("web_read_empty");
  });

  test("DNS deadlines and cancellation stop work and sanitize low-level errors", async () => {
    const stalled = new WebReader(
      async () => response(),
      () => new Promise(() => {}),
      undefined,
      10,
    );
    await expect(stalled.read("https://example.com")).rejects.toThrow(
      "web_read_timeout",
    );
    const controller = new AbortController();
    const promise = stalled.read("https://example.com", controller.signal);
    controller.abort(new Error("cancelled by caller"));
    await expect(promise).rejects.toThrow("cancelled by caller");
    const failed = new WebReader(async () => {
      throw new Error("sensitive upstream exception");
    }, resolvePublic);
    await expect(failed.read("https://example.com")).rejects.toThrow(
      "web_read_failed",
    );
    const extraction = new AbortController();
    const pending = extractWebPage(
      article,
      "https://example.com",
      extraction.signal,
    );
    extraction.abort(new Error("stop extraction"));
    await expect(pending).rejects.toThrow("stop extraction");
  });
});
