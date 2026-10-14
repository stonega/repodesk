import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { changeSkill, saveSkill } from "../../src/skills/catalog.ts";
import { GitHubSkills } from "../../src/skills/github-service.ts";
import { spec, workspace } from "../fixtures.ts";
import {
  skillGitHubFixture,
  skillLink,
  skillMarkdown,
  skillRepository,
} from "../skills-github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub skill imports and updates", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_skills_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  let operatorId: string;
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
      "github-skills",
      "skill-import-test-password",
    );
    operatorId = (await pool.query("SELECT id FROM admins")).rows[0].id;
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture(connected = true) {
    const w = workspace();
    w.operatorId = operatorId;
    if (connected)
      w.github = {
        revision: 1,
        installationId: 501,
        repositories: [{ id: 7001, full_name: skillRepository, private: true }],
      };
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, w.operatorId, JSON.stringify(w)],
    );
    const upstream = skillGitHubFixture();
    upstream.state.private = connected;
    const apps = new GitHubApps(store, "ab".repeat(32), upstream.app);
    const service = new GitHubSkills(store, apps, upstream.transport);
    return { w, ...upstream, service };
  }
  test("private repository import uses a single-repository contents-read token, stays disabled, and is atomic for duplicate slugs", async () => {
    const { w, service, state } = await fixture();
    const preview = await service.discover(w.id, "101", skillLink);
    expect(preview.access).toBe("connected");
    expect(preview.skills).toHaveLength(3);
    const result = await service.import(w.id, "101", {
      url: skillLink,
      commit: preview.commit,
      paths: ["SKILL.md", "skills/second/SKILL.md"],
    });
    expect(result.items).toHaveLength(2);
    for (const skill of result.items) {
      expect(skill.enabled).toBe(false);
      expect(skill.published).toHaveLength(0);
      expect(skill.githubSource?.installationId).toBe(501);
    }
    const tokenRequest = state.requests.find((r) =>
      r.url.endsWith("/access_tokens"),
    );
    expect(JSON.parse(String(tokenRequest?.init.body))).toEqual({
      repository_ids: [7001],
      permissions: { contents: "read" },
    });
    await expect(
      service.import(w.id, "101", {
        url: skillLink,
        commit: preview.commit,
        paths: ["SKILL.md"],
      }),
    ).rejects.toThrow("github_skill_already_imported");
    state.files.set("new/SKILL.md", skillMarkdown("new-skill"));
    state.files.set("collision/SKILL.md", skillMarkdown("team-recap"));
    await expect(
      service.import(w.id, "101", {
        url: skillLink,
        commit: preview.commit,
        paths: ["new/SKILL.md", "collision/SKILL.md"],
      }),
    ).rejects.toThrow("duplicate_slug");
    expect(
      (await store.read(w.id)).skills.some((s) => s.draft.slug === "new-skill"),
    ).toBe(false);
  });
  test("public imports send no credentials, missing files and invalid selections leave no records", async () => {
    const { w, service, state } = await fixture(false);
    const preview = await service.discover(
      w.id,
      "303",
      `${skillLink}/blob/main/SKILL.md`,
    );
    expect(preview.skills).toHaveLength(1);
    expect(preview.access).toBe("public");
    const result = await service.import(w.id, "303", {
      url: `${skillLink}/blob/main/SKILL.md`,
      commit: preview.commit,
      paths: ["SKILL.md"],
    });
    expect(result.items[0]?.githubSource?.access).toBe("public");
    expect(
      state.requests.every(
        (r) => !new Headers(r.init.headers).has("authorization"),
      ),
    ).toBe(true);
    await expect(
      service.import(w.id, "303", {
        url: skillLink,
        commit: preview.commit,
        paths: ["not-discovered/SKILL.md"],
      }),
    ).rejects.toThrow("invalid_github_skill_selection");
    state.files.delete("SKILL.md");
    const skill = result.items[0];
    if (!skill) throw Error("fixture skill missing");
    await expect(
      service.check(w.id, "303", skill.id, skill.version),
    ).rejects.toThrow("github_skill_source_missing");
    expect(
      (await store.read(w.id)).skills.find((s) => s.id === skill.id)?.draft,
    ).toEqual(skill.draft);
  });
  test("updates require the previewed commit and explicit local-edit replacement, preserving published content, enablement and workflow pins", async () => {
    const { w, service, state } = await fixture();
    const skill = (
      await service.import(w.id, "101", {
        url: skillLink,
        commit: state.commit,
        paths: ["SKILL.md"],
      })
    ).items[0];
    if (!skill) throw Error("fixture skill missing");
    await store.change(w.id, (w) => {
      changeSkill(w, "101", skill.id, 1, "publish");
      changeSkill(w, "101", skill.id, 2, "enable");
      const saved = w.skills.find((s) => s.id === skill.id);
      if (!saved) throw Error("fixture missing");
      saveSkill(
        w,
        "101",
        { ...saved.draft, body: "Local edits." },
        saved.id,
        saved.version,
      );
      w.workflows.push({
        id: randomUUID(),
        owner: "101",
        version: 1,
        status: "paused",
        skillVersion: 1,
        spec: { ...spec(w), skillId: skill.id },
        versions: [],
      });
    });
    const before = await store.read(w.id);
    const saved = before.skills.find((s) => s.id === skill.id);
    if (!saved) throw Error("missing");
    expect(
      (await service.check(w.id, "101", skill.id, saved.version)).changed,
    ).toBe(false);
    state.commit = "b".repeat(40);
    state.files.set(
      "SKILL.md",
      skillMarkdown("source-recap", "Updated upstream instructions."),
    );
    const check = await service.check(w.id, "101", skill.id, saved.version);
    expect(check.changed).toBe(true);
    expect(check.locallyModified).toBe(true);
    await expect(
      service.update(w.id, "101", skill.id, saved.version, check.commit, false),
    ).rejects.toThrow("github_skill_local_changes");
    state.commit = "c".repeat(40);
    await expect(
      service.update(w.id, "101", skill.id, saved.version, check.commit, true),
    ).rejects.toThrow("github_skill_source_changed");
    const updated = await service.update(
      w.id,
      "101",
      skill.id,
      saved.version,
      state.commit,
      true,
    );
    expect(updated.draft.body).toBe("Updated upstream instructions.");
    expect(updated.enabled).toBe(true);
    expect(updated.published).toEqual(saved.published);
    expect((await store.read(w.id)).workflows).toEqual(before.workflows);
    await expect(
      service.update(w.id, "101", skill.id, saved.version, state.commit, true),
    ).rejects.toThrow("version_conflict");
  });
  test("stale imports, non-admin actors, disconnected private sources and mid-fetch revocation fail closed", async () => {
    const { w, service, state } = await fixture();
    await expect(service.discover(w.id, "202", skillLink)).rejects.toThrow(
      "access_denied",
    );
    await expect(service.discover(w.id, "999", skillLink)).rejects.toThrow(
      "access_denied",
    );
    await expect(
      service.import(w.id, "101", {
        url: skillLink,
        commit: "f".repeat(40),
        paths: ["SKILL.md"],
      }),
    ).rejects.toThrow("github_skill_source_changed");
    const skill = (
      await service.import(w.id, "101", {
        url: skillLink,
        commit: state.commit,
        paths: ["SKILL.md"],
      })
    ).items[0];
    if (!skill) throw Error("missing");
    await store.change(w.id, (w) => {
      w.github = { revision: 2, repositories: [] };
    });
    const count = state.requests.length;
    await expect(
      service.check(w.id, "101", skill.id, skill.version),
    ).rejects.toThrow("github_repository_not_connected");
    expect(state.requests).toHaveLength(count);
    const second = await fixture();
    let release = () => {};
    second.state.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = second.service.discover(second.w.id, "101", skillLink);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.change(second.w.id, (w) => {
      w.github = { revision: 2, repositories: [] };
    });
    release();
    await expect(pending).rejects.toThrow("github_repository_not_connected");
  });
  test("admin API rejects CSRF and cross-workspace operators and persists source metadata", async () => {
    const { w, app: provider, state } = await fixture();
    const setup = new SetupService(
      store,
      "ab".repeat(32),
      "http://localhost:3000",
    );
    const app = createApp(
      store,
      setup,
      "http://localhost:3000",
      undefined,
      new GitHubService(
        store,
        "ab".repeat(32),
        "http://localhost:3000",
        provider,
      ),
    );
    const post = (path: string, body: unknown, csrf = credentials.csrf) =>
      app.request(`/api/admin/workspaces/${w.id}/skills/${path}`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `repodesk_session=${credentials.raw}`,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect(
      (await post("github/discover", { url: skillLink }, "wrong")).status,
    ).toBe(403);
    expect((await post("github/discover", { url: skillLink })).status).toBe(
      200,
    );
    const imported = await post("github/import", {
      url: skillLink,
      commit: state.commit,
      paths: ["SKILL.md"],
    });
    expect(imported.status).toBe(201);
    expect((await imported.json()).items[0].githubSource.repository).toBe(
      skillRepository,
    );
    await store.change(w.id, (w) => {
      w.operatorId = randomUUID();
    });
    expect((await post("github/discover", { url: skillLink })).status).toBe(
      403,
    );
  });
});
