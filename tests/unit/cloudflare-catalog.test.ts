import { expect, test } from "bun:test";
import {
  analyticsOutput,
  analyticsRequest,
} from "../../src/cloudflare/analytics.ts";
import {
  projectFields,
  resourceDefinition,
  resourceOutput,
  resourcePath,
} from "../../src/cloudflare/catalog.ts";
import { CloudflareClient } from "../../src/cloudflare/client.ts";

test("metadata projections never include object-valued leaves or nested credentials", () => {
  expect(
    projectFields(
      {
        name: "safe",
        value: { password: "hidden" },
        secret: "hidden",
        origins: [
          { name: "origin", password: "hidden", headers: { token: "hidden" } },
        ],
        config: { metric: "cosine", token: "hidden" },
      },
      "name value origins.name config.metric",
    ),
  ).toEqual({
    name: "safe",
    origins: [{ name: "origin" }],
    config: { metric: "cosine" },
  });
});
test("Pages uses ten results while unpaged catalogs paginate locally", () => {
  const pages = resourceDefinition("pages_projects");
  const workers = resourceDefinition("workers");
  if (!pages || !workers) throw Error("missing definition");
  expect(resourcePath(pages, { page: 2 }, "account")).toBe(
    "/accounts/account/pages/projects?page=2&per_page=10",
  );
  expect(resourcePath(workers, { page: 2 }, "account")).toBe(
    "/accounts/account/workers/scripts",
  );
  const result = resourceOutput(
    "workers",
    workers,
    Array.from({ length: 23 }, (_, i) => ({ id: String(i), secret: "hidden" })),
    2,
  );
  expect(result.result).toEqual([{ id: "20" }, { id: "21" }, { id: "22" }]);
  expect(result.localPagination).toMatchObject({
    page: 2,
    total_count: 23,
    total_pages: 2,
  });
});
test("analytics uses fixed scoped queries, bounds UTC dates and excludes unrequested fields", () => {
  const query = analyticsRequest("zone", "2026-09-01", "2026-09-07", "country");
  expect(query.variables).toEqual({
    zoneTag: "zone",
    start: "2026-09-01",
    end: "2026-09-07",
  });
  expect(query.query).toContain("countryMap");
  for (const [start, end] of [
    ["2026-09-07", "2026-09-01"],
    ["2026-01-01", "2026-03-01"],
    ["2999-01-01", "2999-01-02"],
  ])
    expect(() => analyticsRequest("zone", start, end)).toThrow(
      "cloudflare_analytics_range_invalid",
    );
  const data = {
    viewer: {
      zones: [
        {
          zoneTag: "zone",
          httpRequests1dGroups: [
            {
              dimensions: { date: "2026-09-01", secret: "hidden" },
              sum: {
                requests: 23,
                secret: "hidden",
                countryMap: [
                  { clientCountryName: "TW", requests: 23, clientIP: "hidden" },
                ],
              },
              uniq: { uniques: 3 },
            },
          ],
        },
      ],
    },
  };
  expect(
    JSON.stringify(analyticsOutput(data, "zone", "country")),
  ).not.toContain("hidden");
  expect(() => analyticsOutput(data, "other-zone")).toThrow(
    "cloudflare_analytics_unavailable",
  );
  expect(() => analyticsOutput({ viewer: { zones: [] } }, "zone")).toThrow(
    "cloudflare_analytics_unavailable",
  );
});
test("GraphQL POSTs retain read guards, reject partial errors and do not report write ambiguity", async () => {
  let calls = 0;
  let guards = 0;
  const client = new CloudflareClient(async () => {
    calls++;
    return Response.json({ data: { viewer: {} }, errors: null });
  });
  const options = {
    method: "POST" as const,
    graphql: true,
    body: { query: "query {}" },
    guard: async () => {
      guards++;
    },
  };
  expect((await client.request("token", "/graphql", options)).result).toEqual({
    viewer: {},
  });
  expect(guards).toBe(2);
  await expect(client.request("token", "/zones", options)).rejects.toThrow(
    "cloudflare_invalid_request",
  );
  expect(calls).toBe(1);
  const partial = new CloudflareClient(async () =>
    Response.json({
      data: { viewer: {} },
      errors: [{ message: "hidden token" }],
    }),
  );
  await expect(partial.request("token", "/graphql", options)).rejects.toThrow(
    "cloudflare_analytics_unavailable",
  );
  const offline = new CloudflareClient(async () => {
    throw Error("secret");
  });
  await expect(offline.request("token", "/graphql", options)).rejects.toThrow(
    "cloudflare_unavailable",
  );
  const revoked = new CloudflareClient(async () =>
    Response.json({ data: { viewer: {} } }),
  );
  let checked = 0;
  await expect(
    revoked.request("token", "/graphql", {
      ...options,
      guard: async () => {
        if (++checked > 1) throw Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
});

test("pagination preserves cursor tokens and excludes malformed provider metadata", async () => {
  const client = new CloudflareClient(async () =>
    Response.json({
      success: true,
      result: { buckets: [] },
      result_info: {
        cursor: "next-page",
        page: 1,
        per_page: { secret: "hidden" },
        unknown: "hidden",
      },
    }),
  );
  const response = await client.request(
    "token",
    "/accounts/account/r2/buckets",
    { guard: async () => {} },
  );
  expect(response.result_info).toEqual({ cursor: "next-page", page: 1 });
  const definition = resourceDefinition("r2_buckets");
  if (!definition) throw Error("missing definition");
  expect(
    resourcePath(definition, { cursor: "a+b/c=", page: 1 }, "account"),
  ).toBe("/accounts/account/r2/buckets?per_page=20&cursor=a%2Bb%2Fc%3D");
});
