import { expect, test } from "bun:test";
import { deploymentOrigin, siteDomain } from "../../src/admin/site.ts";
import type { Deployment } from "../../src/domain.ts";

test("normalizes custom domains and rejects ambiguous or unsafe hosts", () => {
  expect(siteDomain.parse(" ADMIN.Example.COM ")).toBe("admin.example.com");
  expect(siteDomain.parse("bücher.example")).toBe("xn--bcher-kva.example");
  for (const domain of [
    "",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "admin.localhost",
    "admin.local",
    "admin.internal",
    "https://admin.example.com",
    "admin.example.com/",
    "admin.example.com/path",
    "admin.example.com:443",
    "admin.example.com?query",
    "admin.example.com#fragment",
    "user@admin.example.com",
    "*.example.com",
    "admin_example.com",
    "-admin.example.com",
    "admin-.example.com",
    "admin..example.com",
    "admin.example.com.",
    "admin.example.com\\path",
    "admin.example.com\nother.example.com",
    `${"a".repeat(64)}.example.com`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
  ])
    expect(siteDomain.safeParse(domain).success).toBe(false);
});

test("saved domains override the environment address, removal restores it", () => {
  const fallback = "http://localhost:3000";
  const deployment = {} as Deployment;
  expect(deploymentOrigin(deployment, fallback)).toBe(fallback);
  deployment.site = { revision: 1, domain: "admin.example.com" };
  expect(deploymentOrigin(deployment, fallback)).toBe(
    "https://admin.example.com",
  );
  deployment.site = { revision: 2, domain: null };
  expect(deploymentOrigin(deployment, fallback)).toBe(fallback);
});
