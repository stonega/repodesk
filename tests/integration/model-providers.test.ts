import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin, Workspace } from "../../src/domain.ts";
import { Executor } from "../../src/jobs/execute.ts";
import type { ProviderCatalog } from "../../src/models/config.ts";
import type { ModelTransport } from "../../src/models/service.ts";
import { encrypt, passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)("shared model providers", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `models_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:3000",
    key = "ab".repeat(32);
  const endpoint = "/api/admin/operator/model-providers";
  let store: Store, setup: SetupService, app: ReturnType<typeof createApp>;
  let admin: Admin,
    another: Admin,
    w: Workspace,
    sibling: Workspace,
    foreign: Workspace;
  let auth: { raw: string; csrf: string },
    member: { raw: string; csrf: string };
  let status = 200,
    models = ["gpt-4.1-mini", "team/custom-model"];
  const requests: {
    url: string;
    authorization: string;
    redirect?: RequestRedirect;
  }[] = [];
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl ?? "");
    url.pathname = `/${name}`;
    store = new Store(database(url.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "modelsoperator", "models test password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='modelsoperator'",
        )
      ).rows[0].id,
      username: "modelsoperator",
      operator: true,
    };
    another = { id: randomUUID(), username: "otheroperator", operator: true };
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,$4)",
      [
        another.id,
        another.username,
        await passwordHash("other test password"),
        true,
      ],
    );
    const memberId = randomUUID();
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'modelsmember',$2,false)",
      [memberId, await passwordHash("member test password")],
    );
    member = await login(store.pool, "modelsmember", "member test password");
    w = workspace();
    w.operatorId = admin.id;
    sibling = workspace();
    sibling.operatorId = admin.id;
    foreign = workspace();
    foreign.operatorId = another.id;
    for (const item of [w, sibling, foreign])
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [item.id, item.operatorId, JSON.stringify(item)],
      );
    const transport: ModelTransport = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        redirect: init?.redirect,
      });
      return Response.json(
        status === 200
          ? { data: models.map((id) => ({ id })) }
          : { error: "provider-secret-must-not-escape" },
        { status },
      );
    };
    setup = new SetupService(
      store,
      key,
      origin,
      undefined,
      "webhook",
      transport,
    );
    app = createApp(store, setup, origin, undefined, undefined, key);
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
  let providerId = "";
  test("operators register encrypted providers and discover bounded models without exposing credentials", async () => {
    const catalog = await setup.models.catalog(admin);
    const response = await request(endpoint, "PUT", {
      version: catalog.version,
      name: "Team API",
      baseUrl: "https://models.example.test",
      apiKey: "fixture-provider-secret",
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProviderCatalog;
    providerId = result.providers[0]?.id ?? "";
    expect(result.providers[0]).toMatchObject({
      name: "Team API",
      baseUrl: "https://models.example.test/v1",
      apiKeyConfigured: true,
      models,
    });
    expect(JSON.stringify(result)).not.toContain("fixture-provider-secret");
    expect(requests.at(-1)).toEqual({
      url: "https://models.example.test/v1/models",
      authorization: "Bearer fixture-provider-secret",
      redirect: "error",
    });
    expect(JSON.stringify(await store.deployment())).not.toContain(
      "fixture-provider-secret",
    );
    expect((await setup.models.catalog(another)).providers).toEqual([]);
    expect(
      (await setup.models.workspace(admin, sibling.id)).providers[0]?.id,
    ).toBe(providerId);
  });
  test("access, CSRF and operator ownership apply to discovery, provider changes and selections", async () => {
    const catalog = await setup.models.catalog(admin);
    for (const headers of [
      { cookie: "" },
      { cookie: `repodesk_session=${member.raw}` },
    ]) {
      expect((await request(endpoint, "GET", undefined, headers)).status).toBe(
        headers.cookie ? 403 : 401,
      );
    }
    expect(
      (
        await request(
          endpoint,
          "PUT",
          { version: catalog.version },
          { "x-csrf-token": "wrong" },
        )
      ).status,
    ).toBe(403);
    await expect(
      setup.models.discover(another, {
        version: catalog.version,
        id: providerId,
        baseUrl: "https://models.example.test/v1",
      }),
    ).rejects.toThrow("model_provider_not_found");
    await expect(
      setup.models.saveChat(admin, foreign.id, {
        revision: 0,
        selection: { providerId, model: models[0] },
      }),
    ).rejects.toThrow("access_denied");
    await expect(
      setup.models.selected(foreign, { providerId, model: "gpt-4.1-mini" }),
    ).rejects.toThrow("model_provider_not_found");
  });
  test("a saved key cannot be sent to a new endpoint, and failed or stale saves preserve the provider", async () => {
    const catalog = await setup.models.catalog(admin);
    const before = requests.length;
    await expect(
      setup.models.discover(admin, {
        version: catalog.version,
        id: providerId,
        baseUrl: "https://other.example.test/v1",
      }),
    ).rejects.toThrow("new_endpoint_requires_api_key");
    expect(requests.length).toBe(before);
    status = 401;
    const response = await request(endpoint, "PUT", {
      version: catalog.version,
      id: providerId,
      name: "Replacement",
      baseUrl: "https://models.example.test/v1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(
      "provider-secret-must-not-escape",
    );
    status = 200;
    expect((await setup.models.catalog(admin)).providers[0]?.name).toBe(
      "Team API",
    );
    await expect(
      setup.models.save(admin, {
        version: catalog.version - 1,
        name: "stale",
        baseUrl: "https://models.example.test/v1",
        apiKey: "key",
      }),
    ).rejects.toThrow("version_conflict");
  });
  test("bot selection is workspace-specific and unavailable models or unknown capacity cannot be saved", async () => {
    const path = `/api/admin/workspaces/${w.id}/models`;
    expect(
      (
        await request(path, "PUT", {
          revision: 0,
          selection: { providerId, model: "missing-model" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(path, "PUT", {
          revision: 0,
          selection: { providerId, model: "team/custom-model" },
        })
      ).status,
    ).toBe(400);
    const response = await request(path, "PUT", {
      revision: 0,
      selection: { providerId, model: "gpt-4.1-mini" },
    });
    expect(response.status).toBe(200);
    expect((await store.read(w.id)).chatModel?.selection.model).toBe(
      "gpt-4.1-mini",
    );
    expect((await store.read(sibling.id)).chatModel).toBeUndefined();
    expect(
      (
        await request(path, "PUT", {
          revision: 0,
          selection: { providerId, model: "gpt-4.1-mini" },
        })
      ).status,
    ).toBe(409);
    await expect(
      setup.models.remove(
        admin,
        providerId,
        (await setup.models.catalog(admin)).version,
      ),
    ).rejects.toThrow("model_provider_in_use");
  });
  test("chat execution resolves the chosen model and provider key rather than the deployment default", async () => {
    const d = await store.deployment();
    d.active = true;
    d.model = "gpt-4.1";
    d.credentials.model = encrypt(key, "model", "legacy-secret");
    await store.saveDeployment(store.pool, d);
    const run = await store.change(w.id, (current) =>
      createRun(current, "101", "Answer this", "101", 0, d.model),
    );
    expect(run).toBeTruthy();
    let selected: { model: string; url: string; key: string } | undefined;
    const executor = new Executor(store, setup, {
      async run(input) {
        await input.guard();
        selected = {
          model: input.model.id,
          url: input.model.baseUrl,
          key: input.apiKey,
        };
        return {
          text: "Fixture answer.",
          transcript: [],
          status: "succeeded",
          turns: 1,
          tools: 0,
        };
      },
    });
    if (!run) throw Error("run fixture missing");
    await executor.execute(w.id, run.id);
    expect(selected).toEqual({
      model: "gpt-4.1-mini",
      url: "https://models.example.test/v1",
      key: "fixture-provider-secret",
    });
    expect(
      (await store.read(w.id)).runs.find((r) => r.id === run.id)?.modelProvider
        ?.id,
    ).toBe(providerId);
  });
  test("Codex and review resolve different models from one provider, without putting its key in runner metadata", async () => {
    const current = await store.read(w.id);
    const first = await setup.models.runner(current, {
      providerId,
      model: "gpt-4.1-mini",
    });
    const second = await setup.models.runner(current, {
      providerId,
      model: "team/custom-model",
      thinkingLevel: "high",
    });
    expect(first.modelProvider?.id).toBe(second.modelProvider?.id);
    expect(first.modelProvider?.model).not.toBe(second.modelProvider?.model);
    expect(first.providerApiKey).toBe("fixture-provider-secret");
    expect(JSON.stringify(first.modelProvider)).not.toContain(
      "fixture-provider-secret",
    );
    await expect(
      setup.models.modelKey(admin.id, providerId, 999),
    ).rejects.toThrow("model_provider_changed");
    await expect(
      setup.models.modelKey(another.id, providerId, 1),
    ).rejects.toThrow("model_provider_changed");
  });
  test("refreshing credentials updates future selections and old provider versions cannot retrieve the new key", async () => {
    const old = (await setup.models.catalog(admin)).providers[0];
    if (!old) throw Error("provider missing");
    const result = await setup.models.save(admin, {
      version: (await setup.models.catalog(admin)).version,
      id: providerId,
      name: "Team API",
      baseUrl: old.baseUrl,
      apiKey: "rotated-fixture-secret",
    });
    expect(result.providers[0]?.version).toBe(2);
    await expect(
      setup.models.modelKey(admin.id, providerId, old.version),
    ).rejects.toThrow("model_provider_changed");
    expect(await setup.models.modelKey(admin.id, providerId, 2)).toBe(
      "rotated-fixture-secret",
    );
  });
});
