import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubApp, type GitHubRepository } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { RepositorySync } from "../../src/github/repository-sync.ts";
import { GitHubService } from "../../src/github/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub repository metadata refresh", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_repo_sync_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  let admin: Admin;
  let credentials: { raw: string; csrf: string };
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool);
    credentials = await claim(
      pool,
      "repo-sync-admin",
      "repository sync test password",
    );
    admin = {
      id: (await pool.query("SELECT id FROM admins")).rows[0].id,
      username: "repo-sync-admin",
      operator: true,
    };
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });

  async function fixture() {
    const w = workspace();
    w.operatorId = admin.id;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", private: false },
        { id: 7002, full_name: "example/second" },
      ],
    };
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, admin.id, JSON.stringify(w)],
    );
    const state = {
      now: Date.now(),
      repositories: structuredClone(
        w.github.repositories,
      ) as GitHubRepository[],
      status: 200,
      tokens: 0,
      lists: 0,
      wait: Promise.resolve(),
    };
    const provider = new GitHubApp(githubFixtureConfig, (async (
      input,
      init,
    ) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access_tokens")) {
        state.tokens++;
        expect(JSON.parse(String(init?.body))).toEqual({
          permissions: { metadata: "read" },
        });
        return Response.json({
          token: "ghs_metadata_test_secret",
          expires_at: new Date(state.now + 3600000).toISOString(),
        });
      }
      expect(path).toBe("/installation/repositories");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ghs_metadata_test_secret",
      );
      state.lists++;
      const result = structuredClone(state.repositories);
      await state.wait;
      return Response.json({ repositories: result }, { status: state.status });
    }) as typeof fetch);
    const apps = new GitHubApps(store, "ab".repeat(32), provider);
    const sync = new RepositorySync(store, apps, () => state.now);
    return { id: w.id, state, sync, provider };
  }

  test("renames and visibility changes preserve IDs, roles and Code Truth bindings without granting other repositories", async () => {
    const { id, state, sync } = await fixture();
    await store.change(id, (w) => {
      if (w.github?.repositories[0])
        w.github.repositories[0].permissions = {
          pull: true,
          push: false,
          admin: false,
        };
      w.plugins = {
        revision: 4,
        entries: [],
        codeTruth: {
          enabled: true,
          repositories: [
            {
              id: "source",
              repositoryUrl: "https://github.com/example/workspace.git",
              networks: { devnet: "develop" },
              workspaces: [id],
            },
          ],
        },
      };
    });
    state.repositories = [
      {
        id: 7001,
        full_name: "example/renamed",
        private: true,
        permissions: { pull: true, push: true, admin: true },
      },
      { id: 7002, full_name: "example/second" },
      { id: 8000, full_name: "example/unselected" },
    ];
    const page = await sync.refresh(admin, id);
    expect(page.refreshError).toBeUndefined();
    expect(page.workspace.github?.repositories).toEqual([
      {
        id: 7001,
        full_name: "example/renamed",
        private: true,
        permissions: { pull: true, push: false, admin: false },
      },
      { id: 7002, full_name: "example/second" },
    ]);
    expect(page.workspace.github?.revision).toBe(2);
    expect(page.workspace.plugins?.codeTruth?.repositories[0]).toMatchObject({
      repositoryUrl: "https://github.com/example/renamed.git",
      networks: { devnet: "develop" },
      workspaces: [id],
    });
    expect(page.workspace.plugins?.revision).toBe(5);
    expect(JSON.stringify(page)).not.toContain("ghs_metadata_test_secret");
  });

  test("unchanged refreshes coalesce requests, reuse tokens and avoid version churn", async () => {
    const { id, state, sync } = await fixture();
    await Promise.all([sync.refresh(admin, id), sync.refresh(admin, id)]);
    expect(state.tokens).toBe(1);
    expect(state.lists).toBe(1);
    await sync.refresh(admin, id);
    expect(state.lists).toBe(1);
    state.now += 5000;
    await sync.refresh(admin, id);
    expect(state.lists).toBe(2);
    expect(state.tokens).toBe(1);
    expect((await store.read(id)).github?.revision).toBe(1);
    state.now += 3600000;
    await sync.refresh(admin, id);
    expect(state.tokens).toBe(2);
  });

  test("deleted or inaccessible IDs are removed; replacement names cannot grant new IDs", async () => {
    const { id, state, sync } = await fixture();
    state.repositories = [{ id: 8000, full_name: "example/workspace" }];
    expect((await sync.refresh(admin, id)).workspace.github).toMatchObject({
      revision: 2,
      installationId: 501,
      repositories: [],
    });
    state.now += 5000;
    state.repositories = [{ id: 7001, full_name: "example/workspace" }];
    expect(
      (await sync.refresh(admin, id)).workspace.github?.repositories,
    ).toEqual([]);
  });

  test("failed and malformed responses retain saved metadata and recover on the next refresh", async () => {
    const { id, state, sync } = await fixture();
    state.status = 503;
    state.repositories = [];
    const failed = await sync.refresh(admin, id);
    expect(failed.refreshError).toBe("github_unavailable");
    expect(failed.workspace.github?.repositories).toHaveLength(2);
    expect(failed.workspace.github?.revision).toBe(1);
    state.now += 5000;
    state.status = 200;
    state.repositories = [{ id: 7001, full_name: "invalid/name/path" }];
    expect((await sync.refresh(admin, id)).refreshError).toBe(
      "github_unavailable",
    );
    expect((await store.read(id)).github?.repositories).toHaveLength(2);
    state.now += 5000;
    state.repositories = [
      { id: 7001, full_name: "example/renamed", private: false },
    ];
    const recovered = await sync.refresh(admin, id);
    expect(recovered.refreshError).toBeUndefined();
    expect(recovered.workspace.github?.repositories).toEqual(
      state.repositories,
    );
  });

  for (const action of ["disconnect", "reconnect", "revoke"] as const) {
    test(`a delayed response cannot overwrite ${action}`, async () => {
      const { id, state, sync } = await fixture();
      let release: () => void = () => {};
      state.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.repositories = [{ id: 7001, full_name: "example/renamed" }];
      const pending = sync.refresh(admin, id);
      while (!state.lists) await Bun.sleep(1);
      await store.change(id, (w) => {
        if (action === "disconnect")
          w.github = { revision: 2, repositories: [] };
        else if (action === "reconnect")
          w.github = {
            revision: 2,
            installationId: 501,
            repositories: [{ id: 8000, full_name: "example/new-selection" }],
          };
        else
          w.deletion = {
            requestedAt: new Date().toISOString(),
            providerState: "pending",
          };
      });
      release();
      if (action === "revoke") {
        await expect(pending).rejects.toMatchObject({ code: "access_denied" });
        expect((await store.read(id)).github?.revision).toBe(1);
      } else {
        const result = await pending;
        expect(result.workspace.github?.revision).toBe(2);
        expect(result.workspace.github?.repositories).toEqual(
          action === "disconnect"
            ? []
            : [{ id: 8000, full_name: "example/new-selection" }],
        );
      }
    });
  }

  test("other operators cannot trigger requests or read cached metadata", async () => {
    const { id, state, sync } = await fixture();
    await sync.refresh(admin, id);
    await expect(
      sync.refresh({ ...admin, id: randomUUID() }, id),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      sync.refresh({ ...admin, operator: false }, id),
    ).rejects.toMatchObject({ code: "operator_required" });
    expect(state.lists).toBe(1);
  });

  test("GitHub and Codex list APIs refresh before returning repository metadata", async () => {
    const { id, state, provider } = await fixture();
    state.repositories = [
      { id: 7001, full_name: "example/renamed", private: true },
    ];
    const origin = "http://localhost:3000",
      key = "ab".repeat(32);
    const app = createApp(
      store,
      new SetupService(store, key, origin),
      origin,
      undefined,
      new GitHubService(store, key, origin, provider),
    );
    const base = `/api/admin/workspaces/${id}`;
    const headers = { cookie: `deepx_session=${credentials.raw}` };
    const coding = await app.request(`${base}/plugins/coding`, { headers });
    expect(coding.status).toBe(200);
    expect((await coding.json()).repositories).toEqual(state.repositories);
    const github = await app.request(`${base}/github`, { headers });
    expect(github.status).toBe(200);
    const page = await github.json();
    expect(page.connection.repositories).toEqual(state.repositories);
    expect(page.refreshError).toBeUndefined();
    expect(state.lists).toBe(1);
    expect(JSON.stringify(page)).not.toContain("ghs_metadata_test_secret");
  });
});
