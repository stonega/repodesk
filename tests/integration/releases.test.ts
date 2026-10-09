import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, login } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin } from "../../src/domain.ts";
import { passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import {
  type ReleaseTransport,
  ReleaseUpdates,
} from "../../src/updates/releases.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("host release updates", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `updates_${randomUUID().replaceAll("-", "")}`;
  let store: Store, admin: Admin, directory: string;
  let auth: { raw: string; csrf: string },
    member: { raw: string; csrf: string };
  let release: Record<string, unknown>,
    mode = "ok",
    calls: string[],
    time = 0,
    commit: string;
  let updates: ReleaseUpdates;
  const transport: ReleaseTransport = async (input, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("/latest")) {
      if (mode === "missing") return new Response(null, { status: 404 });
      if (mode === "rate-limit") return new Response(null, { status: 429 });
      return Response.json(release);
    }
    return Response.json({ sha: commit });
  };
  const service = (shared = directory) =>
    new ReleaseUpdates(
      store,
      "stonega/repodesk",
      "fixture-read-token",
      "0.1.32",
      transport,
      () => time,
      shared,
    );
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    auth = await claim(store.pool, "updateoperator", "update test password");
    admin = {
      id: (
        await store.pool.query(
          "SELECT id FROM admins WHERE username='updateoperator'",
        )
      ).rows[0].id,
      username: "updateoperator",
      operator: true,
    };
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'updatemember',$2,false)",
      [randomUUID(), await passwordHash("member password")],
    );
    member = await login(store.pool, "updatemember", "member password");
    directory = await mkdtemp(join(tmpdir(), "repodesk-updates-"));
  });
  beforeEach(async () => {
    await store.pool.query("DELETE FROM deployment_updates");
    await store.pool.query(
      "DELETE FROM operator_audit WHERE action='deployment.update_requested'",
    );
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, "results"), { recursive: true });
    mode = "ok";
    calls = [];
    time = Date.now();
    commit = "a".repeat(40);
    release = {
      id: 42,
      tag_name: "v0.1.33",
      name: "RepoDesk 0.1.33",
      body: "Changes and update notes",
      published_at: "2026-10-09T00:00:00Z",
      draft: false,
      prerelease: false,
    };
    await writeFile(
      join(directory, "heartbeat.json"),
      JSON.stringify({
        repository: "stonega/repodesk",
        at: new Date(time).toISOString(),
      }),
    );
    updates = service();
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  const input = async () => {
    const view = await updates.view(admin);
    return {
      releaseId: view.release?.id,
      fingerprint: view.release?.fingerprint,
    };
  };
  const queued = async () => {
    const files = await readdir(join(directory, "requests"));
    return JSON.parse(
      await readFile(
        join(directory, "requests", files[0] ?? "missing"),
        "utf8",
      ),
    );
  };
  const result = async (state: string, error?: string) => {
    const job = await queued();
    await writeFile(
      join(directory, "results", `${job.requestId}.json`),
      JSON.stringify({
        requestId: job.requestId,
        fingerprint: job.fingerprint,
        state,
        error,
      }),
    );
  };
  test("checks cache, coalesce and recover without exposing credentials", async () => {
    const views = await Promise.all([updates.view(admin), updates.view(admin)]);
    expect(calls).toHaveLength(2);
    expect(views[0]).toMatchObject({
      currentVersion: "0.1.32",
      available: true,
      configured: true,
      updaterReady: true,
    });
    expect(JSON.stringify(views)).not.toContain("fixture-read-token");
    time += 16 * 60000;
    mode = "rate-limit";
    expect((await updates.view(admin)).error).toContain("Could not check");
    await updates.view(admin);
    expect(calls).toHaveLength(3);
    time += 61000;
    mode = "ok";
    expect((await updates.view(admin)).error).toBeUndefined();
  });
  test("missing/equal/older/draft/prerelease records never offer updates", async () => {
    mode = "missing";
    expect((await updates.view(admin)).available).toBe(false);
    mode = "ok";
    for (const patch of [
      { tag_name: "v0.1.32" },
      { tag_name: "v0.1.9" },
      { prerelease: true },
      { draft: true },
    ]) {
      release = { ...release, draft: false, prerelease: false, ...patch };
      expect((await service().view(admin)).available).toBe(false);
    }
  });
  test("changed notes and moved tags require reviewing the release again", async () => {
    const selected = await input();
    release.body = "New migration instructions";
    await expect(updates.start(admin, selected)).rejects.toThrow(
      "release_changed",
    );
    const next = await input();
    commit = "b".repeat(40);
    await expect(updates.start(admin, next)).rejects.toThrow("release_changed");
    expect(
      (await store.pool.query("SELECT * FROM deployment_updates")).rowCount,
    ).toBe(0);
  });
  test("concurrent clicks and API restarts queue and audit once", async () => {
    const selected = await input();
    await Promise.all([
      updates.start(admin, selected),
      updates.start(admin, selected),
    ]);
    await service().start(admin, selected);
    expect(await readdir(join(directory, "requests"))).toHaveLength(1);
    const job = await queued();
    expect(job).toMatchObject({
      repository: "stonega/repodesk",
      releaseId: 42,
      commit,
    });
    expect(JSON.stringify(job)).not.toContain("token");
    expect((await updates.view(admin)).attempt?.state).toBe("queued");
    expect(
      (
        await store.pool.query(
          "SELECT count(*) FROM operator_audit WHERE action='deployment.update_requested'",
        )
      ).rows[0].count,
    ).toBe("1");
  });
  test("host results persist; failed attempts retry only through an explicit action", async () => {
    const selected = await input();
    await updates.start(admin, selected);
    await result("running");
    expect((await updates.view(admin)).attempt?.state).toBe("running");
    await result("failed", "verification_failed");
    expect((await service().view(admin)).attempt?.state).toBe("failed");
    expect((await service().view(admin)).attempt?.error).toBe(
      "verification_failed",
    );
    await updates.start(admin, selected);
    expect(await readdir(join(directory, "requests"))).toHaveLength(1);
    await updates.start(admin, { ...selected, retry: true });
    expect(await readdir(join(directory, "requests"))).toHaveLength(2);
  });
  test("lost host heartbeat marks active installation uncertain and never duplicates it", async () => {
    const selected = await input();
    await updates.start(admin, selected);
    await result("running");
    time += 31000;
    expect((await service().view(admin)).attempt).toMatchObject({
      state: "unknown",
      error: "update_interrupted",
    });
    await expect(updates.start(admin, selected)).rejects.toThrow(
      "updater_unavailable",
    );
    expect(await readdir(join(directory, "requests"))).toHaveLength(1);
  });
  test("uncertain queue publication never creates a second job", async () => {
    const selected = await input();
    await store.pool.query(
      "INSERT INTO deployment_updates(repository,release_id,actor,fingerprint,state,request_id) VALUES('stonega/repodesk',42,$1,$2,'dispatching',$3)",
      [admin.id, selected.fingerprint, randomUUID()],
    );
    expect((await updates.view(admin)).attempt?.state).toBe("unknown");
    await service().start(admin, selected);
    expect(
      (await store.pool.query("SELECT count(*) FROM deployment_updates"))
        .rows[0].count,
    ).toBe("1");
  });
  test("offline and mismatched host agents cannot accept updates", async () => {
    const selected = await input();
    await rm(join(directory, "heartbeat.json"));
    expect((await updates.view(admin)).updaterReady).toBe(false);
    await expect(updates.start(admin, selected)).rejects.toThrow(
      "updater_unavailable",
    );
    await writeFile(
      join(directory, "heartbeat.json"),
      JSON.stringify({
        repository: "other/host",
        at: new Date(time).toISOString(),
      }),
    );
    await expect(updates.start(admin, selected)).rejects.toThrow(
      "updater_unavailable",
    );
    expect(
      (await store.pool.query("SELECT * FROM deployment_updates")).rowCount,
    ).toBe(0);
  });
  test("sessions, operator, origin and CSRF checks precede reads and queue writes", async () => {
    const origin = "http://localhost:3000";
    const app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), origin),
      origin,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      updates,
    );
    const selected = await input();
    calls = [];
    const headers = {
      cookie: `repodesk_session=${auth.raw}`,
      origin,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    };
    expect((await app.request("/api/admin/updates")).status).toBe(401);
    for (const patch of [
      { cookie: "" },
      { origin: "https://evil.example" },
      { "x-csrf-token": "bad" },
      { cookie: `repodesk_session=${member.raw}`, "x-csrf-token": member.csrf },
    ])
      expect([401, 403]).toContain(
        (
          await app.request("/api/admin/operator/updates", {
            method: "POST",
            headers: { ...headers, ...patch },
            body: JSON.stringify(selected),
          })
        ).status,
      );
    expect(calls).toHaveLength(0);
    const view = await app.request("/api/admin/updates", {
      headers: { cookie: `repodesk_session=${member.raw}` },
    });
    expect(view.status).toBe(200);
    expect((await view.json()).configured).toBe(false);
    expect(
      (await store.pool.query("SELECT * FROM deployment_updates")).rowCount,
    ).toBe(0);
  });
  test("notes work without a host queue configured", async () => {
    const readOnly = new ReleaseUpdates(
      store,
      undefined,
      undefined,
      "0.1.32",
      transport,
    );
    expect(await readOnly.view(admin)).toMatchObject({
      configured: false,
      available: true,
    });
    await expect(readOnly.start(admin, await input())).rejects.toThrow(
      "updates_not_configured",
    );
  });
});
