import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { config, DEFAULT_RUN_TIMEOUT_SECONDS } from "../config.ts";
import { database, transaction } from "./pool.ts";
export async function migrate(pool: Pool) {
  await transaction(pool, async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(701932581)");
    await sql.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (
        await sql.query<{ name: string }>("SELECT name FROM schema_migrations")
      ).rows.map((r) => r.name),
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (applied.has(name)) continue;
      await sql.query(await readFile(`migrations/${name}`, "utf8"));
      await sql.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}
export async function migrateJobs(
  url: string,
  runTimeoutSeconds = DEFAULT_RUN_TIMEOUT_SECONDS,
) {
  const boss = new PgBoss({ connectionString: url });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("dead-letter");
  for (const name of ["run", "delivery"]) {
    const expireInSeconds = name === "run" ? runTimeoutSeconds + 60 : 180;
    await boss.createQueue(name, {
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds,
      deadLetter: "dead-letter",
    });
    // createQueue does not alter an existing queue's settings.
    await boss.updateQueue(name, { expireInSeconds });
  }
  await boss.stop();
}
if (import.meta.main) {
  const cfg = config();
  const pool = database(cfg.DATABASE_URL);
  try {
    await migrate(pool);
    await migrateJobs(cfg.DATABASE_URL, cfg.RUN_TIMEOUT_SECONDS);
  } finally {
    await pool.end();
  }
}
