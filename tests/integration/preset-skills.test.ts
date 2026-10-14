import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { SetupService } from "../../src/setup/service.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("preset skill admin API", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_presets_${randomUUID().replaceAll("-", "")}`;
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
      "preset-skills",
      "preset-skills-test-password",
    );
    operatorId = (await pool.query("SELECT id FROM admins")).rows[0].id;
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  test("legacy presets expose toggle-only metadata and reject all other management endpoints", async () => {
    const w = workspace();
    w.operatorId = operatorId;
    for (const skill of w.skills) delete skill.preset;
    const skill = w.skills[0];
    if (!skill) throw Error("Missing preset");
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    const app = createApp(
      store,
      new SetupService(store, "ab".repeat(32), "http://localhost:3000"),
      "http://localhost:3000",
    );
    const request = (path = "", method = "GET", body?: unknown) =>
      app.request(`/api/admin/workspaces/${w.id}/skills${path}`, {
        method,
        headers: {
          origin: "http://localhost:3000",
          cookie: `repodesk_session=${credentials.raw}`,
          "x-csrf-token": credentials.csrf,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const list = await (await request()).json();
    expect(list.items.map((s: { preset: boolean }) => s.preset)).toEqual([
      true,
      true,
    ]);
    const before = await store.read(w.id);
    const edited = await request(`/${skill.id}`, "PUT", {
      version: 1,
      spec: { ...skill.draft, body: "Unauthorized preset edit." },
    });
    expect(edited.status).toBe(403);
    expect((await edited.json()).error).toBe("preset_skill_read_only");
    for (const action of ["publish", "rollback", "archive"]) {
      const rejected = await request(`/${skill.id}/action`, "POST", {
        version: 1,
        action,
        pin: 1,
      });
      expect(rejected.status).toBe(403);
      expect((await rejected.json()).error).toBe("preset_skill_read_only");
    }
    expect(
      (await request(`/${skill.id}/test`, "POST", { sample: "sample" })).status,
    ).toBe(403);
    expect(await store.read(w.id)).toEqual(before);
    const disabled = await request(`/${skill.id}/action`, "POST", {
      version: 1,
      action: "disable",
    });
    expect(disabled.status).toBe(200);
    const saved = await disabled.json();
    expect(saved.enabled).toBe(false);
    expect(saved.preset).toBe(true);
    expect(
      (
        await request(`/${skill.id}/action`, "POST", {
          version: 1,
          action: "enable",
        })
      ).status,
    ).toBe(409);
    const enabled = await request(`/${skill.id}/action`, "POST", {
      version: saved.version,
      action: "enable",
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).enabled).toBe(true);
    expect((await store.read(w.id)).skills[0]?.published).toEqual(
      skill.published,
    );
  });
});
