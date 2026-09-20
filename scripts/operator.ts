import { readFile } from "node:fs/promises";
import { issueClaim } from "../src/admin/auth.ts";
import { config } from "../src/config.ts";
import { database, transaction } from "../src/db/pool.ts";
import { requireThat } from "../src/domain.ts";
import { passwordHash } from "../src/setup/credentials.ts";

const cfg = config();
const pool = database(cfg.DATABASE_URL);
try {
  const [action, username, path] = process.argv.slice(2);
  if (action === "claim") process.stdout.write(`${await issueClaim(pool)}\n`);
  else if (action === "recover") {
    requireThat(username && path, "usage_recover_USERNAME_PASSWORD_FILE");
    const password = (await readFile(path, "utf8")).trimEnd();
    const encoded = await passwordHash(password);
    await transaction(pool, async (sql) => {
      const result = await sql.query(
        "UPDATE admins SET password_hash=$2 WHERE username=$1 AND operator=true RETURNING id",
        [username, encoded],
      );
      requireThat(result.rows[0], "operator_not_found");
      await sql.query("DELETE FROM sessions WHERE admin_id=$1", [
        result.rows[0].id,
      ]);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES('host','admin.recovered',$1)",
        [result.rows[0].id],
      );
    });
    process.stdout.write("Operator recovered; sessions revoked.\n");
  } else
    throw new Error(
      "Usage: operator claim | operator recover USERNAME PASSWORD_FILE",
    );
} finally {
  await pool.end();
}
