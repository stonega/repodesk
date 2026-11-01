import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claim } from "../../src/admin/auth.ts";
import { PostgresBrowserRepository } from "../../src/browser/repository.ts";
import {
  acquireBrowser,
  requestBrowserInput,
} from "../../src/browser/state.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { workspace } from "../fixtures.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "private Browser repository (isolated PostgreSQL)",
  () => {
    const root = database(url ?? "postgres://unused@localhost/unused");
    const name = `repodesk_browser_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    let pool: ReturnType<typeof database>;
    let repository: PostgresBrowserRepository;
    let workspaceId: string;
    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const target = new URL(url ?? "");
      target.pathname = `/${name}`;
      pool = database(target.toString());
      await migrate(pool);
      await claim(pool, "browseroperator", "browser test password");
      const admin = (
        await pool.query(
          "SELECT id FROM admins WHERE username='browseroperator'",
        )
      ).rows[0];
      const w = workspace();
      w.operatorId = admin.id;
      workspaceId = w.id;
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, admin.id, JSON.stringify(w)],
      );
      repository = new PostgresBrowserRepository(pool, key);
    });
    afterAll(async () => {
      await pool?.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });
    test("encrypts private site/input metadata and persists across reconstruction", async () => {
      const owner = { workspaceId, actor: "101" };
      const controller = { kind: "chat" as const, id: randomUUID(), fence: 1 };
      await repository.change(owner, (state) => {
        const lease = acquireBrowser(state, controller);
        requestBrowserInput(state, controller, lease.generation, {
          origin: "https://private.example",
          pageId: randomUUID(),
          pageRevision: 1,
          selector: "#password",
          label: "Private account",
          kind: "password",
        });
      });
      const data = (
        await pool.query(
          "SELECT data FROM browser_profiles WHERE workspace_id=$1 AND actor=$2",
          [workspaceId, "101"],
        )
      ).rows[0]?.data;
      expect(data).toStartWith("v2.");
      expect(data).not.toContain("private.example");
      expect(data).not.toContain("Private account");
      const restored = await new PostgresBrowserRepository(pool, key).read(
        owner,
      );
      expect(restored.input?.origin).toBe("https://private.example");
      expect(restored.input?.state).toBe("waiting");
    });
    test("does not share profiles between members of the same workspace", async () => {
      const owner = { workspaceId, actor: "202" };
      expect((await repository.read(owner)).input).toBeUndefined();
      await repository.change(owner, (state) =>
        acquireBrowser(state, { kind: "codex", id: randomUUID(), fence: 1 }),
      );
      expect(
        (await repository.read({ workspaceId, actor: "101" })).input?.label,
      ).toBe("Private account");
    });
    test("ciphertext cannot be swapped into another user's row", async () => {
      const rows = (
        await pool.query(
          "SELECT actor,data FROM browser_profiles WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows;
      const a = rows.find((row) => row.actor === "101");
      const b = rows.find((row) => row.actor === "202");
      if (!a || !b) throw new Error("missing fixture profiles");
      await pool.query(
        "UPDATE browser_profiles SET data=$3 WHERE workspace_id=$1 AND actor=$2",
        [workspaceId, "202", a.data],
      );
      await expect(
        repository.read({ workspaceId, actor: "202" }),
      ).rejects.toThrow();
      await pool.query(
        "UPDATE browser_profiles SET data=$3 WHERE workspace_id=$1 AND actor=$2",
        [workspaceId, "202", b.data],
      );
    });
    test("database locking admits exactly one concurrent controller", async () => {
      const owner = { workspaceId, actor: "303" };
      const contenders = await Promise.allSettled(
        [1, 2].map(() =>
          repository.change(owner, (state) =>
            acquireBrowser(state, { kind: "chat", id: randomUUID(), fence: 1 }),
          ),
        ),
      );
      expect(contenders.filter((v) => v.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(contenders.filter((v) => v.status === "rejected")).toHaveLength(1);
    });
    test("a failed transaction cannot change persisted ownership or control", async () => {
      const owner = { workspaceId, actor: "303" };
      const previous = await repository.read(owner);
      await expect(
        repository.change(owner, (state) => {
          state.actor = "202";
          state.lease = undefined;
        }),
      ).rejects.toThrow("access_denied");
      expect(await repository.read(owner)).toEqual(previous);
    });
  },
);
