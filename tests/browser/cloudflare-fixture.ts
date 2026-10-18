import type { Page } from "@playwright/test";
import type {
  CloudflarePage,
  CloudflareResource,
} from "../../src/cloudflare/config.ts";
export const workspace = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
export const endpoint = `/api/admin/workspaces/${workspace}/plugins/cloudflare`;
export async function fixture(page: Page, connected = false) {
  const data: CloudflarePage = {
    revision: 1,
    settings: {
      enabled: connected,
      accountId: connected ? "a".repeat(32) : "",
      zoneIds: connected ? ["b".repeat(32)] : [],
      authMethod: "api_token",
    },
    resources: connected
      ? {
          account: { id: "a".repeat(32), name: "Fixture account" },
          zones: [{ id: "b".repeat(32), name: "example.com" }],
        }
      : undefined,
    tokenConfigured: connected,
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const controls = {
    loading: Promise.resolve(),
    pending: Promise.resolve(),
    failure: "",
    loadError: "",
    accounts: [
      { id: "a".repeat(32), name: "Fixture account" },
    ] as CloudflareResource[],
    zones: [
      { id: "b".repeat(32), name: "example.com" },
      { id: "c".repeat(32), name: "another.example" },
    ] as CloudflareResource[],
    inventoryPending: Promise.resolve(),
    inventoryFailure: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${endpoint}/resources`) {
      const body = route.request().postDataJSON();
      await controls.inventoryPending;
      if (controls.inventoryFailure) {
        await route.fulfill({
          status: 403,
          json: { error: controls.inventoryFailure },
        });
        return;
      }
      const items =
        body.resource === "accounts" ? controls.accounts : controls.zones;
      await route.fulfill({
        json: {
          items: items.slice((body.page - 1) * 50, body.page * 50),
          page: body.page,
          hasMore: body.page * 50 < items.length,
        },
      });
      return;
    }
    if (path === endpoint) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push({ path, body });
        await controls.pending;
        if (controls.failure) {
          await route.fulfill({
            status: 409,
            json: { error: controls.failure },
          });
          return;
        }
        data.settings = body.settings;
        data.revision++;
        if (body.apiToken) {
          data.tokenConfigured = true;
          delete data.oauth;
          delete data.resources;
        }
        if (body.removeToken) {
          data.tokenConfigured = false;
          delete data.oauth;
          delete data.resources;
        }
        if (body.verifyResources)
          data.resources = {
            account: controls.accounts.find(
              (a) => a.id === data.settings.accountId,
            ),
            zones: controls.zones.filter((z) =>
              data.settings.zoneIds.includes(z.id),
            ),
          };
      } else {
        await controls.loading;
        if (controls.loadError) {
          await route.fulfill({
            status: 503,
            json: { error: controls.loadError },
          });
          return;
        }
      }
      await route.fulfill({ json: data });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "operator", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspace, name: "Cloudflare fixture" }]
              : { providers: [] },
    });
  });
  return {
    data,
    controls,
    writes,
    open: () => page.goto(`/admin/plugins/cloudflare?workspace=${workspace}`),
  };
}
