import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubService } from "../../src/github/service.ts";
import { repositoryAccess } from "../../src/github/user-access.ts";
import { hash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "Telegram GitHub account linking and permissions",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `github_users_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000",
      key = "ab".repeat(32);
    let store: Store, service: GitHubService, setup: SetupService, id: string;
    let githubId = 42,
      deny = false,
      push = true,
      repoCount = 2;
    let refreshCount = 0,
      badRefresh = false;
    let transient = false;
    let rateLimited = false,
      permissionReads = 0;
    const baseTransport = githubTransport();
    const transport = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const path = String(input);
      if (path === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init.body));
        if (body.grant_type === "refresh_token") {
          if (badRefresh) return Response.json({ error: "bad_refresh_token" });
          expect(body.refresh_token).toBe(
            refreshCount ? `ghr_rotated_${refreshCount}` : "ghr_fixture_secret",
          );
          refreshCount++;
          return Response.json({
            access_token: `ghu_rotated_${refreshCount}`,
            refresh_token: `ghr_rotated_${refreshCount}`,
            expires_in: 28800,
          });
        }
        if (body.code === "fixture-code")
          return Response.json({
            access_token: "ghu_fixture_secret",
            refresh_token: "ghr_fixture_secret",
            expires_in: 28800,
          });
      }
      if (path === "https://api.github.com/user")
        return Response.json({ id: githubId, login: `user-${githubId}` });
      if (path.includes("/user/installations/501/repositories?")) {
        permissionReads++;
        if (rateLimited)
          return Response.json(
            { message: "Secondary rate limit" },
            { status: 403, headers: { "retry-after": "60" } },
          );
        if (transient) throw new Error("private upstream diagnostic");
        if (deny) return Response.json({}, { status: 401 });
        return Response.json({
          repositories: Array.from({ length: repoCount }, (_, i) => ({
            id: 7001 + i,
            full_name: i === 0 ? "example/workspace" : "example/second",
            permissions: {
              pull: true,
              push,
              admin: false,
              triage: true,
              maintain: false,
            },
          })),
        });
      }
      return baseTransport(input, init);
    }) as typeof fetch;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const parsed = new URL(url ?? "");
      parsed.pathname = `/${name}`;
      const pool = database(parsed.toString());
      await migrate(pool);
      store = new Store(pool);
      await claim(pool, "githubusers", "test github password");
      const operator = (
        await pool.query("SELECT id FROM admins WHERE username='githubusers'")
      ).rows[0].id;
      const w = workspace();
      w.operatorId = operator;
      id = w.id;
      w.github = {
        revision: 1,
        installationId: 501,
        repositories: [{ id: 7001, full_name: "example/workspace" }],
      };
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [id, operator, JSON.stringify(w)],
      );
      const d = await store.deployment();
      d.active = true;
      d.bot = { id: "999", username: "repodesk", visibleAll: true };
      await store.saveDeployment(pool, d);
      setup = new SetupService(store, key, origin);
      service = new GitHubService(
        store,
        key,
        origin,
        new GitHubApp(githubFixtureConfig, transport),
      );
    });
    afterAll(async () => {
      await store?.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    async function begin(actor = "202") {
      const link = await store.change(id, (w, sql) =>
        service.users.begin(sql, w, actor, "999"),
      );
      const state = new URL(link).searchParams.get("state") as string;
      expect(new URL(link).searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      return state;
    }
    async function confirm(state: string, actor = "202", accept = true) {
      return store.change(id, (w, sql) =>
        service.users.confirm(sql, w, actor, "999", hash(state), accept),
      );
    }
    test("unverified users cannot start; numeric Telegram sender is used and groups get no link", async () => {
      await expect(begin("404")).rejects.toMatchObject({
        code: "access_denied",
      });
      const ingress = new Ingress(store, setup, service.users);
      await ingress.accept({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -100100, type: "supergroup" },
          from: { id: 202, is_bot: false },
          text: "/github connect",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
      });
      expect(
        (await store.pool.query("SELECT * FROM github_user_flows")).rowCount,
      ).toBe(0);
      const event = {
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 202, type: "private" as const },
          from: { id: 202, is_bot: false },
          text: "/github",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
      };
      await ingress.accept(event);
      expect(await ingress.accept(event)).toEqual({ duplicate: true });
      const w = await store.read(id);
      const replies = w.deliveries.filter((d) => d.id === "event:2:github");
      expect(replies).toHaveLength(1);
      expect(replies[0]?.chatId).toBe("202");
      expect(replies[0]?.text).toContain(
        "https://github.com/login/oauth/authorize",
      );
      expect(w.runs).toHaveLength(0);
    });
    test("public callback binds identity only after same-user private Telegram confirmation", async () => {
      const state = await begin();
      const app = createApp(store, setup, origin, undefined, service);
      const callback = await app.request(
        `/api/admin/github/callback?state=${state}&code=fixture-code`,
      );
      expect(callback.status).toBe(200);
      expect(
        (await store.read(id)).members.find((m) => m.id === "202")?.github,
      ).toBeUndefined();
      await expect(confirm(state, "303")).rejects.toMatchObject({
        code: "github_authorization_expired",
      });
      const w = await store.read(id);
      const prompt = w.deliveries.find(
        (d) => d.id === `github-user:${hash(state)}:confirm`,
      );
      const data = prompt?.buttons?.[0]?.[0]?.callback_data;
      expect(data).toBeDefined();
      expect(Buffer.byteLength(data ?? "")).toBeLessThanOrEqual(64);
      const ingress = new Ingress(store, setup, service.users);
      const event = {
        update_id: 3,
        callback_query: {
          id: "confirm-fixture",
          from: { id: 202, is_bot: false },
          data,
          message: {
            message_id: 3,
            date: 1,
            chat: { id: 202, type: "private" as const },
          },
        },
      };
      await ingress.accept(event);
      const linked = (await store.read(id)).members.find((m) => m.id === "202");
      expect(linked?.github?.id).toBe(42);
      expect(linked?.role).toBe("member");
      expect(linked?.github?.repositories.map((r) => r.id)).toEqual([7001]);
      expect(repositoryAccess(await store.read(id), "202", 7001, true)).toBe(
        true,
      );
      expect(repositoryAccess(await store.read(id), "202", 7002)).toBe(false);
      const encrypted = (
        await store.pool.query(
          "SELECT user_token FROM github_user_accounts WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].user_token;
      expect(encrypted).not.toContain("ghu_fixture_secret");
      expect(JSON.stringify(linked)).not.toContain("ghu_");
      await expect(confirm(state)).rejects.toMatchObject({
        code: "github_authorization_expired",
      });
      expect(await ingress.accept(event)).toEqual({ duplicate: true });
    });
    test("one GitHub identity cannot bind two Telegram members in a workspace", async () => {
      const state = await begin("303");
      await service.users.callbackResult(state, "fixture-code");
      await expect(confirm(state, "303")).rejects.toMatchObject({
        code: "github_identity_already_linked",
      });
      await confirm(state, "303", false);
    });
    test("temporary sync failures deny actions without revoking work; recovery retains grants and confirmed loss fences tasks", async () => {
      const active = randomUUID(),
        completed = randomUUID(),
        unrelated = randomUUID(),
        contributed = randomUUID();
      let runId = "";
      await store.change(id, async (w, sql) => {
        runId = createRun(
          w,
          "202",
          "Read repository",
          "202",
          0,
          "test-model",
        ).id;
        for (const [task, state, actor] of [
          [active, "working", "202"],
          [completed, "review", "202"],
          [unrelated, "working", "303"],
          [contributed, "working", "101"],
        ])
          await sql.query(
            "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
            [
              id,
              task,
              JSON.stringify({ actor, state, cancelRequested: false }),
            ],
          );
        await sql.query(
          "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data) VALUES($1,$2,1,'permission-fixture',$3)",
          [id, contributed, JSON.stringify({ actor: "202" })],
        );
      });
      const prior = (await store.read(id)).members.find(
        (m) => m.id === "202",
      )?.github;
      transient = true;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      let w = await store.read(id);
      let access = w.members.find((m) => m.id === "202")?.github;
      expect(access?.status).toBe("unavailable");
      expect(access?.syncError).toBe("github_unavailable");
      expect(access?.syncedAt).toBe(prior?.syncedAt);
      expect(access?.repositories).toEqual(prior?.repositories);
      expect(repositoryAccess(w, "202", 7001)).toBe(false);
      expect(w.runs.find((r) => r.id === runId)?.cancelled).toBe(false);
      expect(JSON.stringify(access)).not.toContain(
        "private upstream diagnostic",
      );
      transient = false;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      w = await store.read(id);
      access = w.members.find((m) => m.id === "202")?.github;
      expect(repositoryAccess(w, "202", 7001, true)).toBe(true);
      expect(access?.syncError).toBeUndefined();
      expect(w.runs.find((r) => r.id === runId)?.cancelled).toBe(false);
      push = false;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      const tasks = (
        await store.pool.query(
          "SELECT id,data FROM coding_tasks WHERE workspace_id=$1 ORDER BY id",
          [id],
        )
      ).rows;
      expect(tasks.find((t) => t.id === active)?.data).toMatchObject({
        cancelRequested: true,
        error: "github_user_access_denied",
      });
      expect(tasks.find((t) => t.id === completed)?.data).toMatchObject({
        state: "review",
        cancelRequested: false,
      });
      expect(tasks.find((t) => t.id === contributed)?.data).toMatchObject({
        cancelRequested: true,
        error: "github_user_access_denied",
      });
      expect(tasks.find((t) => t.id === unrelated)?.data.cancelRequested).toBe(
        false,
      );
      push = true;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
    });
    test("rate-limited permission sync observes cooldown, backs off and recovers without revocation", async () => {
      rateLimited = true;
      for (const minimum of [300000, 600000]) {
        const started = Date.now();
        await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
        const access = (await store.read(id)).members.find(
          (m) => m.id === "202",
        )?.github;
        expect(access?.syncError).toBe("github_rate_limited");
        expect(Date.parse(access?.retryAt ?? "")).toBeGreaterThanOrEqual(
          started + minimum,
        );
        const reads = permissionReads;
        await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
        expect(permissionReads).toBe(reads);
        await store.change(id, (w) => {
          const member = w.members.find((m) => m.id === "202");
          if (member?.github) member.github.retryAt = new Date(0).toISOString();
        });
      }
      rateLimited = false;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      expect(repositoryAccess(await store.read(id), "202", 7001, true)).toBe(
        true,
      );
      expect(
        (await store.read(id)).members.find((m) => m.id === "202")?.github
          ?.retryAt,
      ).toBeUndefined();
    });
    test("sync replaces permissions and cancels work on downgrade; unavailable and stale snapshots deny", async () => {
      push = false;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      let w = await store.read(id);
      expect(repositoryAccess(w, "202", 7001)).toBe(true);
      expect(repositoryAccess(w, "202", 7001, true)).toBe(false);
      deny = true;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      w = await store.read(id);
      expect(repositoryAccess(w, "202", 7001)).toBe(false);
      expect(w.members.find((m) => m.id === "202")?.github?.status).toBe(
        "unavailable",
      );
      deny = false;
      push = true;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      w = await store.read(id);
      const access = w.members.find((m) => m.id === "202")?.github;
      if (access)
        access.syncedAt = new Date(Date.now() - 11 * 60000).toISOString();
      expect(repositoryAccess(w, "202", 7001)).toBe(false);
    });
    test("periodic sync removes vanished repositories and invalidates changed workspace selections", async () => {
      repoCount = 0;
      await store.pool.query(
        "UPDATE github_user_accounts SET next_sync_at=now() WHERE workspace_id=$1",
        [id],
      );
      await service.users.syncDue();
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(false);
      repoCount = 2;
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      await store.change(id, (w) => {
        if (w.github) w.github.revision++;
      });
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(false);
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(true);
    });
    test("expiring credentials rotate once under concurrent sync; refresh failures clear grants", async () => {
      const before = (
        await store.pool.query(
          "SELECT refresh_token FROM github_user_accounts WHERE workspace_id=$1 AND actor='202'",
          [id],
        )
      ).rows[0];
      expect(before.refresh_token).not.toContain("ghr_fixture_secret");
      await store.pool.query(
        "UPDATE github_user_accounts SET token_expires_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND actor='202'",
        [id],
      );
      await Promise.all([
        store.change(id, (w, sql) => service.users.sync(sql, w, "202")),
        store.change(id, (w, sql) => service.users.sync(sql, w, "202")),
      ]);
      expect(refreshCount).toBe(1);
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(true);
      const after = (
        await store.pool.query(
          "SELECT user_token,refresh_token FROM github_user_accounts WHERE workspace_id=$1 AND actor='202'",
          [id],
        )
      ).rows[0];
      expect(JSON.stringify(after)).not.toContain("ghr_");
      expect(JSON.stringify(after)).not.toContain("ghu_");
      badRefresh = true;
      await store.pool.query(
        "UPDATE github_user_accounts SET token_expires_at=now() WHERE workspace_id=$1 AND actor='202'",
        [id],
      );
      await store.change(id, (w, sql) => service.users.sync(sql, w, "202"));
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(false);
      badRefresh = false;
    });
    test("disconnect blocks linked access and deletes credentials and pending flows", async () => {
      await begin();
      await store.change(id, (w, sql) =>
        service.users.disconnect(sql, w, "202"),
      );
      expect(repositoryAccess(await store.read(id), "202", 7001)).toBe(false);
      expect(
        (
          await store.pool.query(
            "SELECT 1 FROM github_user_accounts WHERE workspace_id=$1 AND actor='202'",
            [id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await store.pool.query(
            "SELECT 1 FROM github_user_flows WHERE workspace_id=$1 AND actor='202'",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    });
    test("cancelled, expired and superseded flows cannot link; revocation during OAuth is rechecked", async () => {
      let state = await begin();
      await expect(service.users.callbackResult(state)).rejects.toMatchObject({
        code: "github_authorization_cancelled",
      });
      state = await begin();
      await store.pool.query(
        "UPDATE github_user_flows SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
        [hash(state)],
      );
      await expect(
        service.users.callbackResult(state, "fixture-code"),
      ).rejects.toMatchObject({ code: "github_authorization_expired" });
      state = await begin();
      await begin();
      await expect(
        service.users.callbackResult(state, "fixture-code"),
      ).rejects.toMatchObject({ code: "github_authorization_expired" });
      state = await begin();
      await store.change(id, (w) => {
        w.members.forEach((member) => {
          if (member.id === "202") member.active = false;
        });
      });
      await expect(
        service.users.callbackResult(state, "fixture-code"),
      ).rejects.toMatchObject({ code: "access_denied" });
      expect(
        (
          await store.pool.query(
            "SELECT 1 FROM github_user_accounts WHERE workspace_id=$1 AND actor='202'",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
