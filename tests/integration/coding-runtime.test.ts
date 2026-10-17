import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import type { RuntimeView } from "../../src/coding/runtime-config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("deployment runtime control", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `runtime_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:3000",
    endpoint = "/api/admin/operator/coding-runtime";
  let store: Store, app: ReturnType<typeof createApp>;
  let auth: { raw: string; csrf: string },
    member: { raw: string; csrf: string };
  let saves = 0;
  let view: RuntimeView = {
    revision: 0,
    selection: null,
    engine: "docker",
    environmentDefault: "docker",
    retainedTasks: 0,
  };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    auth = await claim(
      store.pool,
      "runtimeoperator",
      "runtime operator password",
    );
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'runtimemember',$2,false)",
      [randomUUID(), await passwordHash("runtime member password")],
    );
    member = await login(
      store.pool,
      "runtimemember",
      "runtime member password",
    );
    app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), origin),
      origin,
      undefined,
      undefined,
      undefined,
      {
        async deviceStatus() {
          return { state: "disconnected" };
        },
        async deviceStart() {
          return { state: "pending" };
        },
        async deviceLogout() {
          return { state: "disconnected" };
        },
        async runtimeStatus() {
          return view;
        },
        async runtimeSave(input) {
          saves++;
          view = {
            ...view,
            ...input,
            revision: input.revision + 1,
            engine: input.selection ?? "docker",
          };
          return view;
        },
      },
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const request = (method = "GET", body?: unknown, headers = {}) =>
    app.request(endpoint, {
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
  test("requires operator session, origin and CSRF before contacting runtime", async () => {
    expect((await request("GET", undefined, { cookie: "" })).status).toBe(401);
    expect(
      (
        await request("GET", undefined, {
          cookie: `repodesk_session=${member.raw}`,
        })
      ).status,
    ).toBe(403);
    for (const headers of [
      { origin: "https://evil.example" },
      { "x-csrf-token": "wrong" },
      { cookie: `repodesk_session=${member.raw}`, "x-csrf-token": member.csrf },
    ])
      expect(
        (
          await request(
            "PUT",
            { revision: 0, selection: "opensandbox" },
            headers,
          )
        ).status,
      ).toBe(403);
    expect(saves).toBe(0);
  });
  test("validates exact selection payload and audits successful operator change", async () => {
    expect((await request()).status).toBe(200);
    for (const body of [
      { revision: 0, selection: "shell" },
      { revision: 0, selection: "docker", apiKey: "private" },
      { selection: null },
    ])
      expect((await request("PUT", body)).status).toBe(400);
    expect(saves).toBe(0);
    const response = await request("PUT", {
      revision: 0,
      selection: "opensandbox",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      engine: "opensandbox",
      revision: 1,
    });
    expect(
      (
        await store.pool.query(
          "SELECT action,target FROM operator_audit WHERE action='coding.runtime_selected'",
        )
      ).rows,
    ).toEqual([{ action: "coding.runtime_selected", target: "opensandbox" }]);
  });
  test("a lost audit acknowledgement reports uncertainty and can be resolved by reading the runtime", async () => {
    const original = store.pool.query;
    store.pool.query = ((...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        args[0].includes("coding.runtime_selected")
      )
        return Promise.reject(new Error("Fixture audit outage"));
      return Reflect.apply(original, store.pool, args);
    }) as typeof store.pool.query;
    try {
      const response = await request("PUT", { revision: 1, selection: null });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "coding_outcome_unknown",
      });
      expect(await (await request()).json()).toMatchObject({
        revision: 2,
        selection: null,
        engine: "docker",
      });
    } finally {
      store.pool.query = original;
    }
  });
});
