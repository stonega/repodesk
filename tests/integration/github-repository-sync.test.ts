import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { GitHubApp, type GitHubRepository } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import {
  mergeRepositories,
  RepositorySync,
} from "../../src/github/repository-sync.ts";
import { GitHubService } from "../../src/github/service.ts";
import { GitHubUsers } from "../../src/github/users.ts";
import { GitHubWebhooks } from "../../src/github/webhooks.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
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
    expect(page.workspace.github?.connectionRevision).toBe(1);
    expect(page.workspace.github?.repositoryRevisions).toEqual({ "7001": 2 });
    expect(page.workspace.plugins?.codeTruth?.repositories[0]).toMatchObject({
      repositoryUrl: "https://github.com/example/renamed.git",
      workspaces: [id],
    });
    expect(page.workspace.plugins?.revision).toBe(5);
    expect(JSON.stringify(page)).not.toContain("ghs_metadata_test_secret");
  });

  test("activity refresh updates picker ordering without invalidating repository access", async () => {
    const { id, state, sync } = await fixture();
    Object.assign(state.repositories[0] ?? {}, {
      pushed_at: "2026-10-08T00:00:00Z",
      updated_at: "2026-10-08T01:00:00Z",
    });
    const page = await sync.refresh(admin, id);
    expect(page.workspace.github?.repositories[0]?.pushed_at).toBe(
      "2026-10-08T00:00:00Z",
    );
    expect(page.workspace.github?.revision).toBe(1);
    state.now += 4000;
    Object.assign(state.repositories[0] ?? {}, {
      pushed_at: "2026-10-08T02:00:00Z",
    });
    const refreshed = await sync.refresh(admin, id);
    expect(refreshed.workspace.github?.repositories[0]?.pushed_at).toBe(
      "2026-10-08T02:00:00Z",
    );
    expect(refreshed.workspace.github?.revision).toBe(1);
    Object.assign(state.repositories[0] ?? {}, { archived: true });
    state.now += 4000;
    expect((await sync.refresh(admin, id)).workspace.github?.revision).toBe(2);
    state.now += 4000;
    Object.assign(state.repositories[0] ?? {}, { archived: false });
    const restored = await sync.refresh(admin, id);
    expect(restored.workspace.github?.revision).toBe(3);
    expect(restored.workspace.github?.connectionRevision).toBe(1);
    expect(restored.workspace.github?.repositoryRevisions).toEqual({
      "7001": 3,
    });
    state.now += 4000;
    const duplicate = await sync.refresh(admin, id);
    expect(duplicate.workspace.github?.repositoryRevisions).toEqual({
      "7001": 3,
    });
    expect(duplicate.workspace.github?.revision).toBe(3);
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
      connectionRevision: 1,
      repositoryRevisions: { "7001": 2, "7002": 2 },
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

  test("allRepositories mode auto-syncs newly added repositories via refresh, background sync and webhooks", async () => {
    const { id, state, sync, provider } = await fixture();
    await store.change(id, (w) => {
      if (w.github) w.github.allRepositories = true;
    });
    const futureSync = new Date(Date.now() + 3600000);
    await store.pool.query(
      "INSERT INTO github_user_accounts(workspace_id,actor,github_id,app_id,user_token,next_sync_at) VALUES($1,$2,$3,$4,$5,$6)",
      [id, "101", 42, githubFixtureConfig.id, "enc_tok", futureSync],
    );
    state.repositories = [
      { id: 7001, full_name: "example/workspace", private: false },
      { id: 7002, full_name: "example/second" },
      { id: 7003, full_name: "example/brand-new", private: false },
    ];
    const page = await sync.refresh(admin, id);
    expect(page.refreshError).toBeUndefined();
    expect(page.workspace.github?.repositories.map((r) => r.id)).toEqual([
      7001, 7002, 7003,
    ]);
    expect(page.workspace.github?.revision).toBe(2);
    expect(page.workspace.github?.connectionRevision).toBe(1);
    expect(page.workspace.github?.repositoryRevisions).toEqual({ "7003": 2 });
    // Linked member sync was nudged immediately.
    const nextSync = (
      await store.pool.query(
        "SELECT next_sync_at FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2",
        [id, "101"],
      )
    ).rows[0]?.next_sync_at;
    expect(new Date(nextSync).getTime()).toBeLessThanOrEqual(Date.now() + 5000);

    // Webhook installation_repositories added immediately picks up another new repo.
    const key = "ab".repeat(32);
    const apps = new GitHubApps(store, key, provider);
    const webhookSecret = "s".repeat(32);
    const webhooks = new GitHubWebhooks(store, apps, key, sync);
    await webhooks.configure(admin, id, { secret: webhookSecret });
    state.repositories = [
      ...state.repositories,
      { id: 7004, full_name: "example/webhook-added", private: true },
    ];
    const body = Buffer.from(
      JSON.stringify({
        action: "added",
        installation: { id: 501 },
        repositories_added: [{ id: 7004, full_name: "example/webhook-added" }],
      }),
    );
    const sig = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    await webhooks.accept(
      admin.id,
      "installation_repositories",
      "delivery-added-1",
      sig,
      body,
    );
    expect(
      (await store.read(id)).github?.repositories.map((r) => r.id),
    ).toEqual([7001, 7002, 7003, 7004]);

    // Background worker syncAllWorkspaces picks up new repos once cooldown passes.
    state.now += 6 * 60000;
    state.repositories = [
      ...state.repositories,
      { id: 7005, full_name: "example/worker-added", private: false },
    ];
    await sync.syncAllWorkspaces();
    expect(
      (await store.read(id)).github?.repositories.map((r) => r.id),
    ).toEqual([7001, 7002, 7003, 7004, 7005]);
  });

  test("admin panel sync endpoint toggles allRepositories mode, forces sync and enforces revision/auth", async () => {
    const { id, state, provider } = await fixture();
    const origin = "http://localhost:3000",
      key = "ab".repeat(32);
    const app = createApp(
      store,
      new SetupService(store, key, origin),
      origin,
      undefined,
      new GitHubService(store, key, origin, provider),
    );
    const base = `/api/admin/workspaces/${id}/github`;
    const headers = {
      cookie: `deepx_session=${credentials.raw}`,
      origin,
      "x-csrf-token": credentials.csrf,
      "content-type": "application/json",
    };
    state.repositories = [
      { id: 7001, full_name: "example/workspace", private: false },
      { id: 7002, full_name: "example/second" },
      { id: 7009, full_name: "example/new-from-admin", private: false },
    ];
    // Selected-only sync does not add 7009.
    const selectedSync = await app.request(`${base}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1 }),
    });
    expect(selectedSync.status).toBe(200);
    const selectedBody = await selectedSync.json();
    expect(
      selectedBody.connection.repositories.map((r: GitHubRepository) => r.id),
    ).toEqual([7001, 7002]);
    expect(selectedBody.syncResult).toMatchObject({
      added: 0,
      allRepositories: false,
    });

    // Switching to allRepositories immediately imports 7009.
    const enableAll = await app.request(`${base}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1, allRepositories: true }),
    });
    expect(enableAll.status).toBe(200);
    const enabledBody = await enableAll.json();
    expect(enabledBody.connection.allRepositories).toBe(true);
    expect(
      enabledBody.connection.repositories.map((r: GitHubRepository) => r.id),
    ).toEqual([7001, 7002, 7009]);
    expect(enabledBody.syncResult).toMatchObject({
      changed: true,
      added: 1,
      total: 3,
      allRepositories: true,
    });

    // Stale revision fails with 409 version_conflict.
    const stale = await app.request(`${base}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("version_conflict");

    // Switching back to selected-only freezes the list so future new repos are not added.
    const disableAll = await app.request(`${base}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: enabledBody.connection.revision,
        allRepositories: false,
      }),
    });
    expect(disableAll.status).toBe(200);
    const disabledBody = await disableAll.json();
    expect(disabledBody.connection.allRepositories).toBeUndefined();
    state.repositories = [
      ...state.repositories,
      { id: 7010, full_name: "example/ignored-after-disable", private: false },
    ];
    const afterDisable = await app.request(`${base}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: disabledBody.connection.revision }),
    });
    expect(afterDisable.status).toBe(200);
    expect(
      (await afterDisable.json()).connection.repositories.map(
        (r: GitHubRepository) => r.id,
      ),
    ).toEqual([7001, 7002, 7009]);
  });

  test("Telegram bot supports admin repository sync/all-repos toggle and syncs linked member permissions", async () => {
    const { id } = await fixture();
    const key = "ab".repeat(32);
    const origin = "http://localhost:3000";
    const repos: GitHubRepository[] = [
      {
        id: 7001,
        full_name: "example/workspace",
        private: false,
        permissions: { pull: true, push: true, admin: true },
      },
      {
        id: 7002,
        full_name: "example/second",
        permissions: { pull: true, push: true, admin: false },
      },
      {
        id: 7020,
        full_name: "example/antigravity-usage-indicator",
        private: false,
        permissions: { pull: true, push: true, admin: true },
      },
    ];
    const provider = new GitHubApp(githubFixtureConfig, (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({
          token: "ghs_meta",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      if (url.pathname === "/installation/repositories")
        return Response.json({ repositories: repos });
      if (url.pathname === "/user")
        return Response.json({ id: 500, login: "stonega" });
      if (url.pathname === "/user/installations")
        return Response.json({
          installations: [
            {
              id: 501,
              app_id: githubFixtureConfig.id,
              account: { login: "stonega" },
              suspended_at: null,
            },
          ],
        });
      if (url.pathname === "/user/installations/501/repositories")
        return Response.json({ repositories: repos });
      return new Response("not found", { status: 404 });
    }) as typeof fetch);
    const apps = new GitHubApps(store, key, provider);
    const repoSync = new RepositorySync(store, apps);
    const users = new GitHubUsers(store, apps, key, origin, repoSync);
    const setup = new SetupService(store, key, origin);
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data, '{bot}', $1::jsonb)",
      [JSON.stringify({ id: "900", username: "repodesk_bot" })],
    );
    await store.change(id, (w) => {
      w.members = [
        {
          id: "101",
          role: "owner",
          active: true,
          github: {
            id: 500,
            login: "stonega",
            status: "connected",
            connectionRevision: 1,
            syncedAt: new Date().toISOString(),
            repositories: repos.slice(0, 2),
          },
        },
        { id: "202", role: "member", active: true },
      ];
    });
    await store.pool.query(
      "INSERT INTO github_user_accounts(workspace_id,actor,github_id,app_id,user_token,next_sync_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",
      [
        id,
        "101",
        500,
        githubFixtureConfig.id,
        encrypt(key, `github-user:${id}:101`, "ghu_owner_token"),
      ],
    );
    const ingress = new Ingress(
      store,
      setup,
      users,
      undefined,
      undefined,
      repoSync,
    );
    const sendCmd = async (updateId: number, fromId: number, text: string) => {
      await store.pool.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [String(fromId), id],
      );
      return ingress.accept({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          from: { id: fromId, is_bot: false },
          chat: { id: fromId, type: "private" },
          text,
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
      });
    };

    // Ordinary member cannot run /github repos all.
    await sendCmd(9001, 202, "/github repos all");
    expect((await store.read(id)).github?.allRepositories).toBeUndefined();
    expect((await store.read(id)).github?.repositories).toHaveLength(2);

    // Owner runs /github repos all -> enables auto-sync, imports 7020, and syncs personal permissions.
    await sendCmd(9002, 101, "/github repos all");
    const afterAll = await store.read(id);
    expect(afterAll.github?.allRepositories).toBe(true);
    expect(afterAll.github?.repositories.map((r) => r.id)).toEqual([
      7001, 7002, 7020,
    ]);
    const ownerGitHub = afterAll.members.find((m) => m.id === "101")?.github;
    expect(ownerGitHub?.repositories.map((r) => r.id)).toEqual([
      7001, 7002, 7020,
    ]);
    expect(ownerGitHub?.connectionRevision).toBe(afterAll.github?.revision);
    expect(afterAll.deliveries.at(-1)?.text).toContain(
      "example/antigravity-usage-indicator",
    );

    // Now another repo is added on GitHub; /github sync automatically pulls it in and syncs permissions.
    repos.push({
      id: 7021,
      full_name: "example/another-new-repo",
      private: false,
      permissions: { pull: true, push: true, admin: true },
    });
    await sendCmd(9003, 101, "/github sync");
    const afterSync = await store.read(id);
    expect(afterSync.github?.repositories.map((r) => r.id)).toEqual([
      7001, 7002, 7020, 7021,
    ]);
    expect(
      afterSync.members
        .find((m) => m.id === "101")
        ?.github?.repositories.map((r) => r.id),
    ).toEqual([7001, 7002, 7020, 7021]);
    expect(afterSync.deliveries.at(-1)?.text).toContain("+1");
    expect(afterSync.deliveries.at(-1)?.text).toContain(
      "4 selected repositories",
    );

    // Owner can disable auto-sync with /github repos selected.
    await sendCmd(9004, 101, "/github repos selected");
    expect((await store.read(id)).github?.allRepositories).toBeUndefined();
  });

  test("mergeRepositories preserves selected-only invariants and appends only in allRepositories mode", () => {
    const saved: GitHubRepository[] = [
      { id: 1, full_name: "org/a", private: false },
      { id: 2, full_name: "org/removed" },
    ];
    const accessible: GitHubRepository[] = [
      { id: 1, full_name: "org/a-renamed", private: true },
      { id: 3, full_name: "org/new", private: false },
    ];
    expect(mergeRepositories(saved, accessible, false)).toEqual([
      { id: 1, full_name: "org/a-renamed", private: true },
    ]);
    expect(mergeRepositories(saved, accessible, true)).toEqual([
      { id: 1, full_name: "org/a-renamed", private: true },
      { id: 3, full_name: "org/new", private: false },
    ]);
  });
});
