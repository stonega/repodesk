import { expect, test } from "bun:test";
import { verify } from "node:crypto";
import { workHandoff } from "../../src/agent/work-handoff.ts";
import {
  parseServiceAccount,
  SearchConsoleClient,
  searchConsoleScope,
} from "../../src/search-console/client.ts";
import {
  inspectionInProperty,
  searchConsoleQuery,
} from "../../src/search-console/config.ts";
import { searchConsoleReadAllowed } from "../../src/search-console/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { retainedSource } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";
import { account, publicKey, siteUrl } from "../search-console-fixture.ts";

test("service account exchange signs a read-only JWT and ignores credential endpoints", async () => {
  const parsed = parseServiceAccount(
    JSON.stringify({
      ...account,
      token_uri: "http://private.example/token",
      project_id: "ignored",
    }),
  );
  expect(parsed).toEqual(account);
  const client = new SearchConsoleClient(async (url, init) => {
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.redirect).toBe("error");
    const assertion = new URLSearchParams(String(init.body)).get(
      "assertion",
    ) as string;
    const [head, body, signature] = assertion.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${head}.${body}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(payload.scope).toBe(searchConsoleScope);
    expect(payload.iss).toBe(account.client_email);
    expect(payload.aud).toBe(url);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload.sub).toBeUndefined();
    return Response.json({
      access_token: "fixture-token",
      token_type: "Bearer",
    });
  });
  expect(await client.token(parsed, { guard: async () => {} })).toBe(
    "fixture-token",
  );
  expect(() =>
    parseServiceAccount(
      JSON.stringify({ ...account, private_key: "secret-invalid-key" }),
    ),
  ).toThrow("search_console_invalid_credential");
});
test("Google client fences both sides of requests and redacts upstream failures", async () => {
  let calls = 0;
  const guard = async () => {};
  for (const [status, code] of [
    [403, "search_console_access_denied"],
    [429, "search_console_rate_limited"],
    [500, "search_console_request_failed"],
  ] as const) {
    const client = new SearchConsoleClient(async () => {
      calls++;
      return Response.json({ error: "private-secret" }, { status });
    });
    await expect(client.api("secret", "sites", { guard })).rejects.toThrow(
      code,
    );
  }
  expect(calls).toBe(3);
  const client = new SearchConsoleClient(async () => {
    calls++;
    return Response.json({});
  });
  await expect(
    client.api("secret", "sites", {
      guard: async () => {
        throw Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  expect(calls).toBe(3);
  let guards = 0;
  await expect(
    client.api("secret", "sites", {
      guard: async () => {
        if (++guards === 2) throw Error("late-revocation");
      },
    }),
  ).rejects.toThrow("late-revocation");
  expect(calls).toBe(4);
  for (const response of [
    new Response("x".repeat(1024 * 1024 + 1)),
    new Response("invalid-json"),
  ]) {
    await expect(
      new SearchConsoleClient(async () => response).api("secret", "sites", {
        guard,
      }),
    ).rejects.toThrow("search_console_unavailable");
  }
  await expect(
    client.api("secret", "https://evil.example", { guard }),
  ).rejects.toThrow("search_console_invalid_request");
});
test("Search Console validates date ranges, output bounds and property containment", () => {
  for (const input of [
    {
      resource: "analytics",
      siteUrl,
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    },
    {
      resource: "analytics",
      siteUrl,
      startDate: "2026-03-02",
      endDate: "2026-03-01",
    },
    {
      resource: "analytics",
      siteUrl,
      startDate: "2024-01-01",
      endDate: "2026-01-01",
    },
    { resource: "analytics", siteUrl, startDate: "2026-01-01" },
    { resource: "sitemaps" },
    { resource: "inspect_url", siteUrl },
    { resource: "properties", path: "/secret", method: "DELETE" },
    { resource: "properties", rowLimit: 101 },
    { resource: "properties", dimensions: ["page", "page"] },
  ])
    expect(searchConsoleQuery.safeParse(input).success).toBe(false);
  expect(inspectionInProperty(siteUrl, "https://blog.example.com/page")).toBe(
    true,
  );
  for (const url of [
    "https://example.com.evil.test/",
    "https://notexample.com/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ])
    expect(inspectionInProperty(siteUrl, url)).toBe(false);
  expect(
    inspectionInProperty(
      "https://example.com/blog/",
      "https://example.com/blog/page",
    ),
  ).toBe(true);
  expect(
    inspectionInProperty(
      "https://example.com/blog/",
      "https://example.com/blog/../secret",
    ),
  ).toBe(false);
  expect(
    inspectionInProperty("https://example.com/", "http://example.com/"),
  ).toBe(false);
});
test("retained Search Console answers and handoffs respect revocation and private destinations", () => {
  const w = workspace();
  w.plugins = {
    revision: 1,
    entries: [],
    google: {
      google: {
        settings: { enabled: true },
        clientId: "fixture",
        clientSecret: "fixture",
      },
    },
  };
  w.googleUsers = {
    "101": {
      botId: "999",
      siteUrls: [siteUrl],
      siteRevision: 1,
      connection: {
        id: "personal",
        account: "fixture@example.test",
        subject: "fixture",
        accessToken: "encrypted",
        refreshToken: "encrypted",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  };
  const original = createRun(
    w,
    "101",
    "Search traffic",
    "101",
    0,
    "gpt-4.1-mini",
  );
  original.searchConsoleRead = {
    revision: 1,
    connectionId: "personal",
    selectionRevision: 1,
  };
  original.status = "succeeded";
  original.result = "private search data";
  const source = {
    id: "search-answer",
    runId: original.id,
    role: "assistant" as const,
    chatId: "101",
    topicId: 0,
    author: "assistant",
    text: original.result,
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    directed: true,
  };
  w.messages.push(source);
  const derived = createRun(w, "101", "Summarize", "101", 0, "gpt-4.1-mini");
  derived.sources = [source];
  expect(searchConsoleReadAllowed(w, derived)).toBe(true);
  expect(retainedSource(w, source)).toBe(true);
  const group = createRun(
    w,
    "101",
    "Search traffic",
    "-100100",
    0,
    "gpt-4.1-mini",
  );
  expect(
    workHandoff(w, group, [], { query: "Search traffic" }).entries.some(
      (entry) => entry.runId === original.id,
    ),
  ).toBe(false);
  w.plugins.revision++;
  expect(searchConsoleReadAllowed(w, original)).toBe(false);
  expect(searchConsoleReadAllowed(w, derived)).toBe(false);
  expect(retainedSource(w, source)).toBe(false);
});
