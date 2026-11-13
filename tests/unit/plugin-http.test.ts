import { expect, test } from "bun:test";
import {
  PluginHttpReader,
  type PluginHttpTransport,
} from "../../src/plugins/http-reader.ts";

test("HTTP broker pins a public IP and returns only bounded JSON", async () => {
  let observed = "";
  const send: PluginHttpTransport = async (url, address, bearer) => {
    expect(address.address).toBe("93.184.216.34");
    expect(bearer).toBe("fixture-secret");
    observed = url.href;
    return {
      status: 200,
      body: [Buffer.from('{"count":3}')],
      cancel: () => {},
    };
  };
  const reader = new PluginHttpReader(
    async () => [{ address: "93.184.216.34", family: 4 }],
    send,
  );
  expect(
    await reader.read(
      "https://api.example.com",
      "/v1/items",
      { page: "2" },
      "fixture-secret",
      new AbortController().signal,
    ),
  ).toEqual({ status: 200, data: { count: 3 } });
  expect(observed).toBe("https://api.example.com/v1/items?page=2");
});
test("private/mixed DNS, encoded paths, redirects, excessive data and secret echoes fail closed", async () => {
  let calls = 0;
  const send: PluginHttpTransport = async () => {
    calls++;
    return { status: 200, body: [], cancel: () => {} };
  };
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
  ]) {
    const reader = new PluginHttpReader(
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ],
      send,
    );
    await expect(
      reader.read(
        "https://api.example.com",
        "/v1/items",
        {},
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow("plugin_permission_denied");
  }
  expect(calls).toBe(0);
  const reader = new PluginHttpReader(
    async () => [{ address: "93.184.216.34", family: 4 }],
    send,
  );
  await expect(
    reader.read(
      "https://api.example.com",
      "/v1/%2e%2e/private",
      {},
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("plugin_permission_denied");
  for (const [status, text] of [
    [302, "{}"],
    [200, "x".repeat(100001)],
    [200, '{"echo":"fixture-secret"}'],
  ] as const) {
    const value = new PluginHttpReader(
      async () => [{ address: "93.184.216.34", family: 4 }],
      async () => ({ status, body: [Buffer.from(text)], cancel: () => {} }),
    );
    await expect(
      value.read(
        "https://api.example.com",
        "/v1/items",
        {},
        "fixture-secret",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/plugin_(execution_failed|result_invalid)/);
  }
});
