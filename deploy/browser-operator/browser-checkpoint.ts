import { readFile } from "node:fs/promises";
import { PostgresBrowserRepository } from "../../src/browser/repository.ts";
import { database } from "../../src/db/pool.ts";

// Run inside the current app. Report aggregate coordination metadata only.
const pool = database(process.env.DATABASE_URL ?? "");
try {
  const key = (
    await readFile(process.env.ENCRYPTION_KEY_FILE ?? "", "utf8")
  ).trim();
  const repository = new PostgresBrowserRepository(pool, key);
  const owners = await pool.query(
    "SELECT workspace_id,actor FROM browser_profiles",
  );
  const now = Date.now();
  const counts = { leases: 0, inputs: 0, requests: 0 };
  for (const row of owners.rows) {
    const state = await repository.read({
      workspaceId: row.workspace_id,
      actor: row.actor,
    });
    if (state.lease && state.lease.expiresAt > now) counts.leases++;
    if (
      state.input &&
      ["waiting", "applying"].includes(state.input.state) &&
      state.input.expiresAt > now
    )
      counts.inputs++;
    counts.requests += (state.access?.requests ?? []).filter(
      (request) =>
        ["waiting", "approved", "applying"].includes(request.state) &&
        request.expiresAt > now,
    ).length;
  }
  console.log(JSON.stringify(counts));
} catch {
  console.error("browser_checkpoint_unavailable");
  process.exitCode = 1;
} finally {
  await pool.end();
}
