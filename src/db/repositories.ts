import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type Deployment, Fault, type Workspace } from "../domain.ts";
import { RuntimeLogger } from "../observability/logs.ts";
import { type Sql, transaction } from "./pool.ts";
export class Store {
  constructor(
    public pool: Pool,
    public log = new RuntimeLogger(),
  ) {}
  async deployment(sql: Sql = this.pool, lock = false): Promise<Deployment> {
    const row = (
      await sql.query(
        "SELECT data FROM deployment WHERE id=true" +
          (lock ? " FOR UPDATE" : ""),
      )
    ).rows[0];
    if (!row) throw new Fault("database_not_migrated", 503);
    return row.data;
  }
  async saveDeployment(sql: Sql, value: Deployment) {
    await sql.query("UPDATE deployment SET data=$1 WHERE id=true", [
      JSON.stringify(value),
    ]);
  }
  async read(
    id: string,
    sql: Sql = this.pool,
    lock = false,
  ): Promise<Workspace> {
    const row = (
      await sql.query(
        `SELECT data FROM workspaces WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Fault("not_found", 404);
    return row.data;
  }
  async save(sql: Sql, workspace: Workspace) {
    await sql.query(
      "UPDATE workspaces SET data=$2,updated_at=now() WHERE id=$1",
      [workspace.id, JSON.stringify(workspace)],
    );
    for (const [kind, records] of [
      ["run", workspace.runs.filter((r) => r.status === "queued")],
      ["delivery", workspace.deliveries.filter((d) => d.state === "pending")],
    ] as const) {
      for (const record of records)
        await sql.query(
          "INSERT INTO outbox(id,kind,workspace_id,target_id) VALUES($1,$2,$3,$4) ON CONFLICT(kind,workspace_id,target_id) DO NOTHING",
          [randomUUID(), kind, workspace.id, record.id],
        );
    }
  }
  async change<T>(
    id: string,
    action: (workspace: Workspace, sql: Sql) => T | Promise<T>,
  ) {
    return transaction(this.pool, async (sql) => {
      const workspace = await this.read(id, sql, true);
      const result = await action(workspace, sql);
      await this.save(sql, workspace);
      return result;
    });
  }
  async all(): Promise<Workspace[]> {
    return (
      await this.pool.query("SELECT data FROM workspaces ORDER BY id")
    ).rows.map((r) => r.data);
  }
  async ids(): Promise<string[]> {
    return (
      await this.pool.query("SELECT id FROM workspaces ORDER BY id")
    ).rows.map((r) => r.id);
  }
}
