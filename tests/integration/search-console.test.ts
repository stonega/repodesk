import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { searchConsoleReadAllowed } from "../../src/search-console/policy.ts";
import { SearchConsoleService } from "../../src/search-console/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { googleFixture } from "../google-fixture.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("Personal Search Console", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `repodesk_gsc_${randomUUID().replaceAll("-", "")}`,
    key = "ab".repeat(32);
  const site = "sc-domain:example.test";
  let store: Store,
    admin: Admin,
    update = 8000;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(rootUrl as string);
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await claim(store.pool, "searchoperator", "search fixture password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='searchoperator'",
        )
      ).rows[0].id,
      username: "searchoperator",
      operator: true,
    };
    const d = await store.deployment();
    d.active = true;
    d.bot = { id: "999", username: "repodesk", visibleAll: true };
    await store.saveDeployment(store.pool, d);
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
    const f = await googleFixture(store, admin, key, "202");
    await f.connect();
    const requests: string[] = [];
    const control: {
      beforeRead?: () => Promise<void>;
      denied?: boolean;
      count: number;
    } = { count: 12 };
    const service = new SearchConsoleService(
      store,
      key,
      async (url, init) => {
        requests.push(url);
        await control.beforeRead?.();
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer access-202",
        );
        if (control.denied)
          return Response.json(
            { error: "private upstream detail" },
            { status: 403 },
          );
        if (url.endsWith("/sites"))
          return Response.json({
            siteEntry: [
              { siteUrl: site, permissionLevel: "siteOwner" },
              ...Array.from({ length: control.count }, (_, i) => ({
                siteUrl: `sc-domain:property-${i}.test`,
                permissionLevel: "siteFullUser",
              })),
              {
                siteUrl: "sc-domain:unverified.test",
                permissionLevel: "siteUnverifiedUser",
              },
            ],
          });
        if (url.endsWith("/searchAnalytics/query"))
          return Response.json({
            rows: [
              {
                keys: ["query"],
                clicks: 10,
                impressions: 100,
                ctr: 0.1,
                position: 3,
                secret: "excluded",
              },
            ],
          });
        if (url.endsWith("/sitemaps"))
          return Response.json({
            sitemap: [
              {
                path: "https://example.test/sitemap.xml",
                errors: "0",
                secret: "excluded",
              },
            ],
          });
        if (url.endsWith("index:inspect"))
          return Response.json({
            inspectionResult: {
              indexStatusResult: {
                verdict: "PASS",
                googleCanonical: "https://example.test/",
                secret: "excluded",
              },
            },
          });
        return Response.json({
          siteUrl: decodeURIComponent(url.split("/sites/")[1] ?? ""),
          permissionLevel: "siteOwner",
        });
      },
      f.service,
    );
    const select = async (sites = [site]) =>
      store.change(f.w.id, async (w) => {
        await service.properties(w, "202", "999");
        const user = w.googleUsers?.["202"];
        if (!user?.properties) throw Error("missing selection");
        user.properties.selected = sites;
        await service.saveProperties(w, "202", "999", user.properties.key);
      });
    const query = (value: unknown, runId = f.run.id) =>
      service.query(f.w.id, runId, 1, value);
    return { ...f, search: service, requests, control, select, query };
  }
  test("Telegram discovery, pagination and explicit save apply only to that member and preserve selection on failure", async () => {
    const f = await fixture();
    await store.pool.query(
      "INSERT INTO telegram_selections(actor,workspace_id) VALUES('202',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=$1",
      [f.w.id],
    );
    const ingress = new Ingress(
      store,
      new SetupService(store, key, "http://localhost:3000", () => ({
        async call<T>() {
          return {} as T;
        },
      })),
      undefined,
      f.service,
      f.search,
    );
    await ingress.accept({
      update_id: ++update,
      message: {
        message_id: update,
        date: 1,
        from: { id: 202, is_bot: false },
        chat: { id: 202, type: "private" },
        text: "/google properties",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    });
    let w = await store.read(f.w.id);
    const draft = w.googleUsers?.["202"]?.properties;
    expect(draft?.items).toHaveLength(13);
    expect(draft?.items).not.toContain("sc-domain:unverified.test");
    expect(w.googleUsers?.["202"]?.siteUrls).toEqual([]);
    const click = async (data: string, actor = 202) =>
      ingress.accept({
        update_id: ++update,
        callback_query: {
          id: String(update),
          from: { id: actor, is_bot: false },
          message: {
            message_id: update,
            date: 1,
            chat: { id: actor, type: "private" },
          },
          data,
        },
      });
    const menu = w.deliveries.at(-1);
    const first = menu?.buttons?.[0]?.[0]?.callback_data as string;
    await click(first, 101);
    expect(
      (await store.read(w.id)).googleUsers?.["202"]?.properties?.selected,
    ).toEqual([]);
    await click(first);
    w = await store.read(w.id);
    expect(w.googleUsers?.["202"]?.siteUrls).toEqual([]);
    const next = w.deliveries
      .at(-1)
      ?.buttons?.flat()
      .find((b) => b.text === "Next")?.callback_data as string;
    await click(next);
    expect((await store.read(w.id)).deliveries.at(-1)?.text).toContain(
      "Page 2/2",
    );
    for (const d of (await store.read(w.id)).deliveries)
      for (const b of d.buttons?.flat() ?? [])
        if (b.callback_data)
          expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    const save = `google_save:${draft?.key}`;
    f.control.denied = true;
    await click(save);
    expect((await store.read(w.id)).googleUsers?.["202"]?.siteUrls).toEqual([]);
    expect(
      (await store.read(w.id)).googleUsers?.["202"]?.properties?.selected,
    ).toEqual([site]);
    f.control.denied = false;
    await click(save);
    expect((await store.read(w.id)).googleUsers?.["202"]?.siteUrls).toEqual([
      site,
    ]);
    expect((await store.read(w.id)).googleUsers?.["101"]).toBeUndefined();
    expect((await store.read(w.id)).plugins?.revision).toBe(1);
    await click(save);
    expect((await store.read(w.id)).googleUsers?.["202"]?.siteRevision).toBe(2);
  });
  test("queries cover personal properties, bounded finalized analytics, sitemaps and indexed inspection", async () => {
    const f = await fixture();
    await f.select();
    expect(await f.query({ resource: "properties" })).toEqual({
      resource: "properties",
      siteUrls: [site],
    });
    const analytics = await f.query({
      resource: "analytics",
      siteUrl: site,
      startDate: "2026-10-01",
      endDate: "2026-10-10",
      dimensions: ["query"],
      rowLimit: 1,
    });
    expect(analytics).toMatchObject({
      result: { timezone: "America/Los_Angeles", nextStartRow: 1 },
    });
    expect(JSON.stringify(analytics)).not.toContain("excluded");
    expect(
      await f.query({ resource: "sitemaps", siteUrl: site }),
    ).toMatchObject({ result: { truncated: false } });
    expect(
      await f.query({
        resource: "inspect_url",
        siteUrl: site,
        inspectionUrl: "https://example.test/path",
      }),
    ).toMatchObject({ result: { indexStatusResult: { verdict: "PASS" } } });
  });
  test("other users, groups, unselected properties and foreign inspection URLs fail before upstream reads", async () => {
    const f = await fixture();
    await f.select();
    const before = f.requests.length;
    for (const [actor, chat] of [
      ["101", "101"],
      ["202", "-100100"],
    ] as const) {
      const run = await store.change(f.w.id, (w) =>
        createRun(w, actor, "Search traffic", chat, 0, "gpt-4.1-mini"),
      );
      await expect(
        f.query({ resource: "properties" }, run.id),
      ).rejects.toThrow();
    }
    await expect(
      f.query({ resource: "sitemaps", siteUrl: "sc-domain:other.test" }),
    ).rejects.toThrow("search_console_property_denied");
    await expect(
      f.query({
        resource: "inspect_url",
        siteUrl: site,
        inspectionUrl: "https://foreign.test/",
      }),
    ).rejects.toThrow("search_console_property_denied");
    expect(f.requests.length).toBe(before);
  });
  test("property changes invalidate retained and derived answers without changing other members or plugin settings", async () => {
    const f = await fixture();
    await f.select();
    await f.query({ resource: "sitemaps", siteUrl: site });
    const w = await store.read(f.w.id),
      run = w.runs[0];
    if (!run) throw Error("missing run");
    expect(searchConsoleReadAllowed(w, run)).toBe(true);
    expect(
      searchConsoleReadAllowed(w, { ...run, actor: "101", chatId: "101" }),
    ).toBe(false);
    await f.select([]);
    expect(searchConsoleReadAllowed(await store.read(w.id), run)).toBe(false);
    expect((await store.read(w.id)).plugins?.revision).toBe(1);
  });
  test("disconnect during a provider read suppresses its result", async () => {
    const f = await fixture();
    await f.select();
    f.control.beforeRead = () =>
      store.change(f.w.id, (w) => f.service.disconnect(w, "202"));
    await expect(
      f.query({ resource: "sitemaps", siteUrl: site }),
    ).rejects.toThrow();
  });
  test("selection expiry and more than twenty properties cannot be saved", async () => {
    const f = await fixture();
    f.control.count = 25;
    await expect(
      f.select(
        Array.from({ length: 21 }, (_, i) => `sc-domain:property-${i}.test`),
      ),
    ).rejects.toThrow("google_property_limit");
    await store.change(f.w.id, async (w) => {
      await f.search.properties(w, "202", "999");
      const draft = w.googleUsers?.["202"]?.properties;
      if (!draft) throw Error("missing draft");
      draft.expiresAt = new Date(0).toISOString();
    });
    await expect(
      store.change(f.w.id, (w) =>
        f.search.saveProperties(
          w,
          "202",
          "999",
          w.googleUsers?.["202"]?.properties?.key ?? "",
        ),
      ),
    ).rejects.toThrow("google_properties_expired");
  });
});
