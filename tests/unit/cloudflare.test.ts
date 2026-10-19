import { expect, test } from "bun:test";
import { workHandoff } from "../../src/agent/work-handoff.ts";
import { CloudflareClient, project } from "../../src/cloudflare/client.ts";
import {
  cloudflareAction,
  cloudflareQuery,
} from "../../src/cloudflare/config.ts";
import { cloudflareReadAllowed } from "../../src/cloudflare/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { retainedSource } from "../../src/workspaces/threads.ts";
import { workspace } from "../fixtures.ts";

test("Cloudflare inputs reject arbitrary paths/methods, ambiguous targets and unsupported record types", () => {
  const zoneId = "a".repeat(32);
  for (const input of [
    { resource: "dns_records" },
    { resource: "zones", zoneId },
    { resource: "pages_deployments", projectName: "../secrets" },
    { resource: "zones", path: "/accounts", method: "POST" },
    { resource: "pages_projects", page: 0 },
  ])
    expect(cloudflareQuery.safeParse(input).success).toBe(false);
  for (const input of [
    { action: "purge_cache", zoneId },
    {
      action: "purge_cache",
      zoneId,
      files: ["https://example.com"],
      purgeEverything: true,
    },
    {
      action: "create_dns_record",
      zoneId,
      record: { type: "SRV", name: "a.example.com", content: "target", ttl: 1 },
    },
    {
      action: "create_dns_record",
      zoneId,
      record: {
        type: "MX",
        name: "example.com",
        content: "mx.example.com",
        ttl: 1,
      },
    },
  ])
    expect(cloudflareAction.safeParse(input).success).toBe(false);
});
test("Cloudflare client guards requests, never retries writes, and exposes fixed failure codes", async () => {
  let calls = 0;
  const client = new CloudflareClient(async () => {
    calls++;
    throw Error("private token and body");
  });
  await expect(
    client.request("token", "/zones", {
      guard: async () => {
        throw Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  expect(calls).toBe(0);
  await expect(
    client.request("token", "/zones", {
      method: "POST",
      body: {},
      guard: async () => {},
    }),
  ).rejects.toThrow("cloudflare_outcome_unknown");
  expect(calls).toBe(1);
  const denied = new CloudflareClient(async () =>
    Response.json(
      { success: false, errors: [{ message: "secret body" }] },
      { status: 403 },
    ),
  );
  await expect(
    denied.request("token", "/zones", { guard: async () => {} }),
  ).rejects.toThrow("cloudflare_access_denied");
  const oversized = new CloudflareClient(
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await expect(
    oversized.request("token", "/zones", { guard: async () => {} }),
  ).rejects.toThrow("cloudflare_unavailable");
});
test("Pages projection excludes configuration and nested deployment secrets", () => {
  expect(
    project({
      name: "site",
      env_vars: { secret: "hidden" },
      source: { config: "hidden" },
      latest_deployment: {
        id: "deploy",
        env_vars: { secret: "hidden" },
        build_config: { key: "hidden" },
        latest_stage: { status: "success", other: "hidden" },
      },
    }),
  ).toEqual({
    name: "site",
    latest_deployment: { id: "deploy", latest_stage: { status: "success" } },
  });
});

test("Cloudflare evidence revocation follows retained answers and prevents group handoffs", () => {
  const w = workspace();
  w.plugins = {
    revision: 1,
    entries: [],
    cloudflare: {
      settings: { enabled: true, accountId: "a".repeat(32), zoneIds: [] },
      credential: "encrypted-fixture",
    },
  };
  const original = createRun(w, "101", "Query Pages", "101", 0, "gpt-4.1-mini");
  original.cloudflareRead = { revision: 1, accountId: "a".repeat(32) };
  original.status = "succeeded";
  original.result = "private Cloudflare result";
  const source = {
    id: "cf-answer",
    runId: original.id,
    role: "assistant" as const,
    chatId: "101",
    topicId: 0,
    author: "assistant",
    text: "Pages result",
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    directed: true,
  };
  const derived = createRun(
    w,
    "101",
    "Summarize the result",
    "101",
    0,
    "gpt-4.1-mini",
  );
  derived.sources = [source];
  expect(cloudflareReadAllowed(w, original)).toBe(true);
  expect(cloudflareReadAllowed(w, derived)).toBe(true);
  expect(retainedSource(w, source)).toBe(true);
  const group = createRun(
    w,
    "101",
    "Read the old result",
    "-100100",
    0,
    "gpt-4.1-mini",
  );
  group.handoffRead = {
    references: { sourceIds: [], sourceHash: "fixture" },
    runIds: [original.id],
    chatIds: ["101"],
    repositoryIds: [],
  };
  expect(cloudflareReadAllowed(w, group)).toBe(false);
  expect(
    workHandoff(w, derived, [], { query: "Query Pages" }).entries.some(
      (e) => e.runId === original.id,
    ),
  ).toBe(true);
  expect(
    workHandoff(w, group, [], { query: "Query Pages" }).entries.some(
      (e) => e.runId === original.id,
    ),
  ).toBe(false);
  w.plugins.revision++;
  expect(cloudflareReadAllowed(w, original)).toBe(false);
  expect(cloudflareReadAllowed(w, derived)).toBe(false);
  expect(retainedSource(w, source)).toBe(false);
});

test("expanded Cloudflare schema binds each resource to its identifiers and rejects unrelated arguments", () => {
  const zoneId = "b".repeat(32);
  for (const input of [
    {
      resource: "zone_analytics",
      zoneId,
      since: "2026-09-01",
      until: "2026-09-07",
      dimension: "country",
    },
    { resource: "worker_schedules", scriptName: "my-worker" },
    { resource: "r2_buckets", cursor: "next-token" },
    { resource: "ruleset", zoneId, resourceId: "a".repeat(32) },
    {
      resource: "d1_database",
      resourceId: "12345678-abcd-abcd-abcd-123456789abc",
    },
  ])
    expect(cloudflareQuery.safeParse(input).success).toBe(true);
  for (const input of [
    { resource: "zone_analytics" },
    { resource: "zone_settings", zoneId, projectName: "site" },
    { resource: "workers", zoneId },
    { resource: "worker_schedules", scriptName: "../secrets" },
    { resource: "r2_bucket", bucketName: "a/b" },
    { resource: "r2_buckets", page: 2 },
    { resource: "account", page: 2 },
    { resource: "workers", since: "2026-09-01" },
    { resource: "zone_analytics", zoneId, since: "2026-02-30" },
    { resource: "zone_analytics", zoneId, query: "mutation {}" },
  ])
    expect(cloudflareQuery.safeParse(input).success).toBe(false);
});

test("reviewed zone settings and Worker routes have closed action inputs", () => {
  const zoneId = "b".repeat(32);
  expect(
    cloudflareAction.safeParse({
      action: "update_zone_setting",
      zoneId,
      settingId: "ssl",
      value: "strict",
    }).success,
  ).toBe(true);
  expect(
    cloudflareAction.safeParse({
      action: "update_zone_setting",
      zoneId,
      settingId: "ssl",
      value: "arbitrary",
    }).success,
  ).toBe(false);
  expect(
    cloudflareAction.safeParse({
      action: "update_zone_setting",
      zoneId,
      settingId: "unknown",
      value: "on",
    }).success,
  ).toBe(false);
  expect(
    cloudflareAction.safeParse({
      action: "update_zone_setting",
      zoneId,
      settingId: "browser_cache_ttl",
      value: "on",
    }).success,
  ).toBe(false);
  for (const pattern of ["https://*.example.com/*", "example.com/api/*"])
    expect(
      cloudflareAction.safeParse({
        action: "create_worker_route",
        zoneId,
        pattern,
        scriptName: "my-worker",
      }).success,
    ).toBe(true);
  for (const pattern of [
    "https://user@example.com/*",
    "https://example.com:443/*",
    "https://example.com/?a=b",
  ])
    expect(
      cloudflareAction.safeParse({
        action: "create_worker_route",
        zoneId,
        pattern,
        scriptName: "my-worker",
      }).success,
    ).toBe(false);
});
