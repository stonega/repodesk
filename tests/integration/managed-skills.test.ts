import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { SetupService } from "../../src/setup/service.ts";
import { saveSkill } from "../../src/skills/catalog.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("direct admin skill saves", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_managed_skills_${randomUUID().replaceAll("-", "")}`;
  let store: Store;
  let credentials: { raw: string; csrf: string };
  let operatorId: string;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    const pool = database(parsed.toString());
    await migrate(pool);
    store = new Store(pool);
    credentials = await claim(
      pool,
      "managed-skills",
      "managed-skills-password",
    );
    operatorId = (await pool.query("SELECT id FROM admins")).rows[0].id;
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function fixture() {
    const w = workspace();
    w.operatorId = operatorId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    const app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), "http://localhost:3000"),
      "http://localhost:3000",
    );
    const request = (path: string, body: unknown, method = "POST") =>
      app.request(`/api/admin/workspaces/${w.id}/skills${path}`, {
        method,
        headers: {
          origin: "http://localhost:3000",
          cookie: `repodesk_session=${credentials.raw}`,
          "x-csrf-token": credentials.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const preset = w.skills[0];
    if (!preset) throw Error("Missing preset fixture");
    const instructions = {
      ...preset.draft,
      slug: "custom-recap",
      name: "Custom recap",
    };
    return { w, request, instructions };
  }
  test("create, enable and edit need no publish request and preserve run and schedule pins", async () => {
    const { w, request, instructions } = await fixture();
    const created = await request("", instructions);
    expect(created.status).toBe(201);
    const skill = await created.json();
    expect(skill.enabled).toBe(false);
    expect(skill.published).toEqual([instructions]);
    const enabled = await request(`/${skill.id}/action`, {
      version: skill.version,
      action: "enable",
    });
    expect(enabled.status).toBe(200);
    const active = await enabled.json();
    const before = await store.change(w.id, (current) => {
      const run = createRun(
        current,
        "101",
        "Recap",
        "-100100",
        0,
        "gpt-4.1-mini",
      );
      current.workflows.push({
        id: randomUUID(),
        owner: "101",
        version: 1,
        status: "paused",
        skillVersion: 1,
        spec: { ...spec(current), skillId: skill.id },
        versions: [],
      });
      return { run, workflows: structuredClone(current.workflows) };
    });
    const update = { ...instructions, body: "Updated saved instructions." };
    const edited = await request(
      `/${skill.id}`,
      { version: active.version, spec: update },
      "PUT",
    );
    expect(edited.status).toBe(200);
    const saved = await edited.json();
    expect(saved.enabled).toBe(true);
    expect(saved.published).toEqual([instructions, update]);
    const current = await store.read(w.id);
    expect(current.workflows).toEqual(before.workflows);
    expect(current.runs[0]?.skillPins).toEqual(before.run.skillPins);
    const next = createRun(
      current,
      "101",
      "Recap again",
      "-100100",
      0,
      "gpt-4.1-mini",
    );
    expect(next.skillPins.find((pin) => pin.id === skill.id)?.version).toBe(2);
    const stale = await request(
      `/${skill.id}`,
      { version: active.version, spec: instructions },
      "PUT",
    );
    expect(stale.status).toBe(409);
    expect(
      (await store.read(w.id)).skills.find((s) => s.id === skill.id),
    ).toEqual(saved);
  });
  test("Markdown imports are ready to enable and duplicate imports leave saved content intact", async () => {
    const { w, request } = await fixture();
    const markdown =
      "---\nname: imported-recap\ndescription: A saved procedure\n---\nUse supplied context.";
    const imported = await request("/import", { markdown });
    expect(imported.status).toBe(201);
    const skill = await imported.json();
    expect(skill.published).toEqual([skill.draft]);
    expect(skill.enabled).toBe(false);
    const before = await store.read(w.id);
    expect((await request("/import", { markdown })).status).toBe(409);
    expect(await store.read(w.id)).toEqual(before);
    expect(
      (
        await request(`/${skill.id}/action`, {
          version: skill.version,
          action: "enable",
        })
      ).status,
    ).toBe(200);
  });
  test("legacy unpublished instructions can be enabled directly but missing conversation sources still block approval", async () => {
    const { w, request, instructions } = await fixture();
    const legacy = await store.change(w.id, (current) =>
      saveSkill(current, "101", instructions),
    );
    const enabled = await request(`/${legacy.id}/action`, {
      version: legacy.version,
      action: "enable",
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).published).toEqual([instructions]);
    const removed = await store.change(w.id, (current) => {
      const skill = saveSkill(current, "101", {
        ...instructions,
        slug: "removed-source",
      });
      skill.origin = {
        runId: randomUUID(),
        actor: "101",
        sharedAt: new Date().toISOString(),
        references: { sourceIds: ["removed"], sourceHash: "missing" },
      };
      return skill;
    });
    const before = await store.read(w.id);
    for (const method of ["enable", "edit"]) {
      const response =
        method === "enable"
          ? await request(`/${removed.id}/action`, {
              version: removed.version,
              action: "enable",
            })
          : await request(
              `/${removed.id}`,
              { version: removed.version, spec: removed.draft },
              "PUT",
            );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("skill_source_changed");
      expect(await store.read(w.id)).toEqual(before);
    }
  });
});
