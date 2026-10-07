import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { claim, session } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubService } from "../../src/github/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "GitHub member directory and admin associations",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_members_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    let store: Store;
    let app: ReturnType<typeof createApp>;
    let auth: { raw: string; csrf: string };
    let adminId: string;
    let w = workspace();
    let fail = false;
    let changeConnection = false;
    const requests: string[] = [];
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      store = new Store(database(parsed.toString()));
      await migrate(store.pool);
      auth = await claim(
        store.pool,
        "membersadmin",
        "member directory test password",
      );
      const current = await session(store.pool, auth.raw);
      if (!current) throw Error("missing session");
      adminId = current.admin.id;
      const transport = githubTransport();
      const provider = new GitHubApp(githubFixtureConfig, (async (
        input,
        init,
      ) => {
        requests.push(String(input));
        if (String(input).includes("/orgs/example/members")) {
          if (fail)
            return Response.json(
              { message: "private secret" },
              { status: 502 },
            );
          if (changeConnection) {
            changeConnection = false;
            await store.change(w.id, (current) => {
              if (current.github) current.github.revision++;
            });
          }
        }
        return transport(input, init);
      }) as typeof fetch);
      const github = new GitHubService(
        store,
        "ab".repeat(32),
        origin,
        provider,
      );
      app = createApp(
        store,
        new SetupService(store, "ab".repeat(32), origin),
        origin,
        undefined,
        github,
      );
    });
    beforeEach(async () => {
      w = workspace();
      w.operatorId = adminId;
      w.github = {
        revision: 1,
        installationId: 501,
        account: "example",
        repositories: [{ id: 7001, full_name: "example/workspace" }],
      };
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, adminId, JSON.stringify(w)],
      );
      fail = false;
      changeConnection = false;
      requests.length = 0;
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    const api = (path: string, method = "GET", body?: unknown) =>
      app.request(`/api/admin/workspaces/${w.id}/${path}`, {
        method,
        headers: {
          cookie: `repodesk_session=${auth.raw}`,
          origin,
          "x-csrf-token": auth.csrf,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const edit = (githubId?: number | null, overrides = {}) =>
      api("members", "POST", {
        id: "202",
        role: "member",
        active: true,
        version: w.memberVersion,
        ...(githubId !== undefined ? { githubId, githubRevision: 1 } : {}),
        ...overrides,
      });

    test("fetches accounts and persists/searches a chosen association without OAuth grants", async () => {
      const response = await api("members/github");
      expect(response.status).toBe(200);
      const directory = await response.json();
      expect(directory).toMatchObject({
        connected: true,
        revision: 1,
        source: "organization",
        members: [
          { id: 42, login: "fixture-user" },
          { id: 43, login: "second-user" },
        ],
      });
      expect(JSON.stringify(directory)).not.toContain("secret");
      expect((await edit(42)).status).toBe(200);
      const current = await store.read(w.id);
      expect(current.members.find((m) => m.id === "202")).toMatchObject({
        role: "member",
        githubAccount: { id: 42, login: "fixture-user" },
      });
      expect(
        current.members.find((m) => m.id === "202")?.github,
      ).toBeUndefined();
      expect(
        (
          await store.pool.query(
            "SELECT * FROM github_user_accounts WHERE workspace_id=$1",
            [w.id],
          )
        ).rowCount,
      ).toBe(0);
      const search = await api("members?search=fixture-user");
      expect((await search.json()).total).toBe(1);
      expect((await edit(42)).status).toBe(409);
    });
    test("rejects unknown accounts, duplicate associations and stale connection revisions", async () => {
      expect((await edit(999)).status).toBe(409);
      expect((await edit(42, { githubRevision: 0 })).status).toBe(409);
      expect((await edit(42)).status).toBe(200);
      const current = await store.read(w.id);
      expect(
        (await edit(42, { id: "303", version: current.memberVersion })).status,
      ).toBe(409);
      expect(
        (await store.read(w.id)).members.find((m) => m.id === "303")
          ?.githubAccount,
      ).toBeUndefined();
      expect(
        (await edit(null, { version: current.memberVersion })).status,
      ).toBe(200);
      expect(
        (await store.read(w.id)).members.find((m) => m.id === "202")
          ?.githubAccount,
      ).toBeUndefined();
    });
    test("membership editing preserves associations during GitHub outages", async () => {
      expect((await edit(42)).status).toBe(200);
      const current = await store.read(w.id);
      fail = true;
      expect((await api("members/github")).status).toBe(502);
      expect(
        (
          await edit(undefined, {
            version: current.memberVersion,
            active: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (await store.read(w.id)).members.find((m) => m.id === "202")
          ?.githubAccount?.id,
      ).toBe(42);
    });
    test("disconnected workspaces return an empty directory and connection changes invalidate reads and saves", async () => {
      changeConnection = true;
      expect((await api("members/github")).status).toBe(409);
      w = await store.read(w.id);
      changeConnection = true;
      expect(
        (await edit(42, { githubRevision: w.github?.revision })).status,
      ).toBe(409);
      expect(
        (await store.read(w.id)).members.find((m) => m.id === "202")
          ?.githubAccount,
      ).toBeUndefined();
      await store.change(w.id, (current) => {
        current.github = { revision: 4, repositories: [] };
      });
      requests.length = 0;
      expect(await (await api("members/github")).json()).toEqual({
        connected: false,
        revision: 4,
        members: [],
      });
      expect(requests).toHaveLength(0);
    });
    test("foreign workspaces and ordinary members are denied before GitHub requests", async () => {
      const foreign = randomUUID();
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [foreign, `foreign-${foreign}`],
      );
      await store.change(w.id, (current) => {
        current.operatorId = foreign;
      });
      expect((await api("members/github")).status).toBe(403);
      expect((await edit(42)).status).toBe(403);
      expect(requests).toHaveLength(0);
      await store.pool.query(
        "UPDATE admins SET telegram_id='202',operator=false WHERE id=$1",
        [adminId],
      );
      try {
        expect((await api("members/github")).status).toBe(403);
        expect(requests).toHaveLength(0);
      } finally {
        await store.pool.query(
          "UPDATE admins SET telegram_id=NULL,operator=true WHERE id=$1",
          [adminId],
        );
      }
    });
  },
);
