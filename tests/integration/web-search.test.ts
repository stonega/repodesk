import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin, Workspace } from "../../src/domain.ts";
import { Executor } from "../../src/jobs/execute.ts";
import {
  DUCKDUCKGO_PRESET_ID,
  duckduckgoPreset,
} from "../../src/search/config.ts";
import { searchTool } from "../../src/search/tool.ts";
import { passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("chat web search", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `search_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:3000",
    key = "ab".repeat(32),
    endpoint = "/api/admin/operator/search-providers";
  let store: Store,
    setup: SetupService,
    app: ReturnType<typeof createApp>,
    admin: Admin,
    other: Admin,
    w: Workspace,
    foreign: Workspace;
  let auth: { raw: string; csrf: string },
    member: { raw: string; csrf: string };
  let calls = 0,
    status = 200;
  let duringSearch: (() => Promise<void>) | undefined;
  let modelId: string;
  const searches: { url: string; headers: Headers }[] = [];
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl ?? "");
    url.pathname = `/${name}`;
    store = new Store(database(url.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "searchoperator", "search test password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='searchoperator'",
        )
      ).rows[0].id,
      username: "searchoperator",
      operator: true,
    };
    other = { id: randomUUID(), username: "searchother", operator: true };
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,true),($4,'searchmember',$3,false)",
      [
        other.id,
        other.username,
        await passwordHash("member test password"),
        randomUUID(),
      ],
    );
    member = await login(store.pool, "searchmember", "member test password");
    w = workspace();
    w.operatorId = admin.id;
    foreign = workspace();
    foreign.operatorId = other.id;
    for (const item of [w, foreign])
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [item.id, item.operatorId, JSON.stringify(item)],
      );
    setup = new SetupService(
      store,
      key,
      origin,
      undefined,
      "webhook",
      async () => Response.json({ data: [{ id: "gpt-4.1-mini" }] }),
      async (url, init) => {
        calls++;
        searches.push({ url, headers: new Headers(init.headers) });
        await duringSearch?.();
        if (status === 200 && url.includes("duckduckgo.com"))
          return new Response(
            '<a class="result__a" href="https://example.com/source">Source</a><div class="result__snippet">Verified excerpt</div>',
          );
        return status === 200
          ? Response.json({
              results: [
                {
                  title: "Source",
                  url: "https://example.com/source",
                  summary: "Verified excerpt",
                  text: "Verified excerpt",
                },
              ],
            })
          : new Response("fixture-search-secret", { status });
      },
    );
    app = createApp(store, setup, origin, undefined, undefined, key);
    const model = await setup.models.save(admin, {
      version: (await store.deployment()).version,
      name: "Chat API",
      baseUrl: "https://models.example.test/v1",
      apiKey: "fixture-model-key",
    });
    modelId = model.providers[0]?.id ?? "";
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: `repodesk_session=${auth.raw}`,
        origin,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const provider = async (type = "deepseek") => {
    const result = await setup.search.save(admin, {
      version: (await store.deployment()).version,
      name: `${type} search`,
      type,
      ...(type === "duckduckgo" ? {} : { apiKey: "fixture-search-secret" }),
    });
    const found = result.providers.at(-1);
    if (!found) throw Error("provider missing");
    return found;
  };
  const select = async (id: string | null) =>
    setup.models.saveChat(admin, w.id, {
      revision: (await store.read(w.id)).chatModel?.revision ?? 0,
      selection: { providerId: modelId, model: "gpt-4.1-mini" },
      searchProviderId: id,
    });
  const runFixture = async (id: string) => {
    await select(id);
    const current = await store.read(w.id),
      pin = await setup.search.pin(current);
    if (!pin) throw Error("pin missing");
    const run = await store.change(w.id, (current) => {
      const run = createRun(
        current,
        "101",
        "Find release notes",
        "101",
        0,
        "gpt-4.1-mini",
      );
      if (!run) throw Error("run missing");
      run.status = "running";
      run.fence = 1;
      run.searchProvider = pin;
      return run;
    });
    return {
      run,
      pin,
      tool: searchTool(
        store,
        setup.search,
        w.id,
        run.id,
        1,
        pin,
        async () => {},
      ),
    };
  };
  test("DuckDuckGo is an immediate read-only preset without stored provider records", async () => {
    const before = await store.deployment();
    const catalog = await setup.search.catalog(admin);
    expect(catalog.providers).toEqual([duckduckgoPreset]);
    expect((await setup.search.catalog(other)).providers).toEqual([
      duckduckgoPreset,
    ]);
    expect(
      (await store.read(w.id)).chatModel?.searchProviderId,
    ).toBeUndefined();
    expect(await store.deployment()).toEqual(before);
    for (const method of ["PUT", "DELETE"]) {
      const response = await request(
        method === "PUT" ? endpoint : `${endpoint}/${DUCKDUCKGO_PRESET_ID}`,
        method,
        {
          version: catalog.version,
          ...(method === "PUT"
            ? { id: DUCKDUCKGO_PRESET_ID, name: "Changed", type: "duckduckgo" }
            : {}),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "search_preset_read_only",
      });
    }
    const duplicate = await request(endpoint, "PUT", {
      version: catalog.version,
      name: "Duplicate",
      type: "duckduckgo",
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({
      error: "duckduckgo_is_preset",
    });
    expect(await store.deployment()).toEqual(before);
  });
  test("the preset searches without credentials, stays tenant-bound, and is revoked when deselected", async () => {
    const { tool, pin, run } = await runFixture(DUCKDUCKGO_PRESET_ID);
    expect(pin).toMatchObject({
      id: DUCKDUCKGO_PRESET_ID,
      operatorId: admin.id,
      type: "duckduckgo",
      version: 1,
    });
    const result = await tool.execute("preset", { query: "release notes" });
    expect(JSON.stringify(result)).toContain("Verified excerpt");
    expect(searches.at(-1)?.headers.has("authorization")).toBe(false);
    expect(searches.at(-1)?.headers.has("x-api-key")).toBe(false);
    expect((await store.deployment()).searchProviders).toBeUndefined();
    const before = calls;
    const foreignTool = searchTool(
      store,
      setup.search,
      w.id,
      run.id,
      1,
      { ...pin, operatorId: other.id },
      async () => {},
    );
    await expect(
      foreignTool.execute("foreign", { query: "release notes" }),
    ).rejects.toThrow("search_configuration_changed");
    await expect(setup.search.current({ ...pin, type: "exa" })).rejects.toThrow(
      "search_provider_changed",
    );
    await expect(setup.search.current({ ...pin, version: 2 })).rejects.toThrow(
      "search_provider_changed",
    );
    await select(null);
    await expect(
      tool.execute("preset", { query: "release notes" }),
    ).rejects.toThrow("search_configuration_changed");
    expect(calls).toBe(before);
  });
  test("existing saved DuckDuckGo records and selections remain usable", async () => {
    const d = await store.deployment(),
      id = randomUUID();
    d.searchProviders = [
      {
        id,
        operatorId: admin.id,
        name: "Legacy free search",
        type: "duckduckgo",
        version: 1,
      },
    ];
    d.version++;
    await store.saveDeployment(store.pool, d);
    expect((await setup.search.catalog(admin)).providers).toHaveLength(2);
    const { tool } = await runFixture(id);
    expect(
      JSON.stringify(await tool.execute("legacy", { query: "release notes" })),
    ).toContain("Verified excerpt");
    await setup.search.save(admin, {
      version: d.version,
      id,
      name: "Renamed legacy",
      type: "duckduckgo",
    });
    await expect(
      setup.search.remove(admin, id, (await store.deployment()).version),
    ).rejects.toThrow("search_provider_in_use");
    await select(DUCKDUCKGO_PRESET_ID);
    await setup.search.remove(admin, id, (await store.deployment()).version);
    expect((await setup.search.catalog(admin)).providers).toEqual([
      duckduckgoPreset,
    ]);
  });
  test("paid providers persist encrypted, write-only, tenant-scoped credentials", async () => {
    const paid = await provider(),
      exa = await provider("exa");
    expect(paid.apiKeyConfigured).toBe(true);
    expect(exa.type).toBe("exa");
    expect(JSON.stringify(await setup.search.catalog(admin))).not.toContain(
      "fixture-search-secret",
    );
    expect(JSON.stringify(await store.deployment())).not.toContain(
      "fixture-search-secret",
    );
    expect((await setup.search.catalog(other)).providers).toEqual([
      duckduckgoPreset,
    ]);
    const result = await setup.search.save(admin, {
      version: (await store.deployment()).version,
      id: paid.id,
      name: "Renamed",
      type: "deepseek",
    });
    expect(
      result.providers.find((p) => p.id === paid.id)?.apiKeyConfigured,
    ).toBe(true);
    await expect(
      setup.search.save(admin, {
        version: result.version,
        id: paid.id,
        name: "Switch",
        type: "exa",
      }),
    ).rejects.toThrow("search_provider_key_required");
    await expect(
      setup.search.save(admin, {
        version: result.version - 1,
        name: "Stale",
        type: "duckduckgo",
      }),
    ).rejects.toThrow("version_conflict");
    await expect(
      setup.search.save(other, {
        version: result.version,
        id: paid.id,
        name: "Foreign",
        type: "deepseek",
      }),
    ).rejects.toThrow("search_provider_not_found");
  });
  test("provider and selection APIs enforce sessions, operator ownership, origin and CSRF", async () => {
    expect(
      (await request(endpoint, "GET", undefined, { cookie: "" })).status,
    ).toBe(401);
    expect(
      (
        await request(endpoint, "GET", undefined, {
          cookie: `repodesk_session=${member.raw}`,
        })
      ).status,
    ).toBe(403);
    const input = {
      version: (await store.deployment()).version,
      name: "Paid",
      type: "deepseek",
      apiKey: "fixture-search-secret",
    };
    expect(
      (await request(endpoint, "PUT", input, { "x-csrf-token": "wrong" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(endpoint, "PUT", input, {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(endpoint, "PUT", {
          ...input,
          type: "exa",
          apiKey: undefined,
        })
      ).status,
    ).toBe(400);
    const created = await request(endpoint, "PUT", input);
    expect(created.status).toBe(200);
    const p = await provider();
    await expect(
      setup.models.saveChat(other, foreign.id, {
        revision: 0,
        selection: { providerId: modelId, model: "gpt-4.1-mini" },
        searchProviderId: p.id,
      }),
    ).rejects.toThrow("model_provider_not_found");
    const foreignSearch = (
      await setup.search.save(other, {
        version: (await store.deployment()).version,
        name: "Foreign",
        type: "exa",
        apiKey: "foreign-fixture-key",
      })
    ).providers.at(-1);
    const inputModel = {
      revision: (await store.read(w.id)).chatModel?.revision ?? 0,
      selection: { providerId: modelId, model: "gpt-4.1-mini" },
      searchProviderId: foreignSearch?.id,
    };
    expect(
      (await request(`/api/admin/workspaces/${w.id}/models`, "PUT", inputModel))
        .status,
    ).toBe(404);
    await select(p.id);
    expect((await request(`/api/admin/workspaces/${w.id}/models`)).status).toBe(
      200,
    );
    expect(
      (
        await request(`${endpoint}/${p.id}`, "DELETE", {
          version: (await store.deployment()).version,
        })
      ).status,
    ).toBe(409);
    await select(null);
    expect(
      (
        await request(`${endpoint}/${p.id}`, "DELETE", {
          version: (await store.deployment()).version,
        })
      ).status,
    ).toBe(200);
  });
  test("durable calls reuse completed results, reject conflicting or unknown replay, and validate arguments", async () => {
    const p = await provider(),
      { tool, run } = await runFixture(p.id);
    const before = calls;
    const first = await tool.execute("same", { query: "release notes" });
    expect(JSON.stringify(first)).toContain("https://example.com/source");
    expect(
      await tool.execute("same", { query: "release notes", limit: 5 }),
    ).toEqual(first);
    expect(calls).toBe(before + 1);
    await expect(tool.execute("same", { query: "different" })).rejects.toThrow(
      "tool_call_conflict",
    );
    for (const args of [
      { query: " " },
      { query: "x".repeat(129) },
      { query: "ok", limit: 11 },
      { query: "ok", providerId: randomUUID() },
    ])
      await expect(tool.execute("invalid", args)).rejects.toThrow();
    await store.change(w.id, (current) => {
      const r = current.runs.find((r) => r.id === run.id);
      if (r)
        r.tools.unknown = {
          name: "search_tool",
          state: "started",
          arguments: { query: "release notes", limit: 5 },
        };
    });
    await expect(
      tool.execute("unknown", { query: "release notes" }),
    ).rejects.toThrow("search_outcome_unknown");
    expect(calls).toBe(before + 1);
  });
  test("credential rotation, selection changes, member revocation and fencing invalidate old calls and cached data", async () => {
    const p = await provider(),
      { tool, pin, run } = await runFixture(p.id);
    await tool.execute("done", { query: "release notes" });
    await store.change(w.id, (current) => {
      const actor = current.members.find((m) => m.id === "101");
      if (actor) actor.active = false;
    });
    await expect(
      tool.execute("done", { query: "release notes" }),
    ).rejects.toThrow("tool_policy_denied");
    await store.change(w.id, (current) => {
      const actor = current.members.find((m) => m.id === "101");
      if (actor) actor.active = true;
      const r = current.runs.find((r) => r.id === run.id);
      if (r) r.fence++;
    });
    await expect(
      tool.execute("new", { query: "release notes" }),
    ).rejects.toThrow("tool_policy_denied");
    await select(null);
    await expect(
      tool.execute("new", { query: "release notes" }),
    ).rejects.toThrow();
    await setup.search.save(admin, {
      version: (await store.deployment()).version,
      id: p.id,
      name: p.name,
      type: p.type,
      apiKey: "rotated-secret",
    });
    await expect(setup.search.current(pin)).rejects.toThrow(
      "search_provider_changed",
    );
  });
  test("in-flight revocation discards results and provider errors are safe tool results", async () => {
    const p = await provider(),
      { tool, run } = await runFixture(p.id);
    status = 401;
    const result = await tool.execute("error", { query: "release notes" });
    expect(JSON.stringify(result)).toContain("search_provider_auth_failed");
    expect(JSON.stringify(result)).not.toContain("fixture-search-secret");
    status = 200;
    duringSearch = async () => {
      await select(null);
    };
    await expect(
      tool.execute("revoked", { query: "release notes" }),
    ).rejects.toThrow("search_configuration_changed");
    duringSearch = undefined;
    expect(
      (await store.read(w.id)).runs.find((r) => r.id === run.id)?.tools.revoked
        ?.state,
    ).toBe("started");
  });
  test("Executor exposes search_tool only for a selected provider and pins its version", async () => {
    await store.change(w.id, (current) => {
      for (const r of current.runs) {
        r.status = "succeeded";
        r.leaseUntil = undefined;
      }
    });
    const d = await store.deployment();
    d.active = true;
    d.paused = false;
    await store.saveDeployment(store.pool, d);
    const p = await provider();
    for (const selectedId of [null, DUCKDUCKGO_PRESET_ID, p.id]) {
      const enabled = !!selectedId;
      await select(selectedId);
      const run = await store.change(w.id, (current) =>
        createRun(
          current,
          "101",
          "Look up current facts",
          "101",
          0,
          "gpt-4.1-mini",
        ),
      );
      if (!run) throw Error("run missing");
      let seen = false;
      await new Executor(store, setup, {
        async run(input) {
          seen = true;
          await input.guard();
          const tool = input.tools.find((t) => t.name === "search_tool");
          expect(!!tool).toBe(enabled);
          expect(input.tools.some((t) => t.name === "read_web")).toBe(true);
          if (tool)
            expect(
              JSON.stringify(
                await tool.execute(
                  "executor",
                  { query: "current facts" },
                  input.signal,
                ),
              ),
            ).toContain("Verified excerpt");
          return {
            text: "Fixture answer.",
            status: "succeeded",
            turns: 1,
            tools: enabled ? 1 : 0,
            transcript: [],
          };
        },
      }).execute(w.id, run.id);
      expect(seen).toBe(true);
      const saved = (await store.read(w.id)).runs.find((r) => r.id === run.id);
      expect(saved?.status).toBe("succeeded");
      expect(saved?.searchProvider?.id).toBe(selectedId ?? undefined);
    }
  });
});
