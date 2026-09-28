import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type Sql, transaction } from "../db/pool.ts";
import { type Admin, requireThat, type Session } from "../domain.ts";
import {
  hash,
  passwordHash,
  token,
  verifyPassword,
} from "../setup/credentials.ts";
export async function throttle(pool: Pool, key: string) {
  const result = await pool.query(
    "INSERT INTO auth_limits(key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.expires_at<now() THEN 1 ELSE auth_limits.attempts+1 END, expires_at=CASE WHEN auth_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_limits.expires_at END RETURNING attempts",
    [hash(key)],
  );
  requireThat(result.rows[0].attempts <= 15, "try_again_later", 429);
}
async function makeSession(sql: Sql, adminId: string) {
  const raw = token();
  const csrf = token();
  const expiresAt = new Date(Date.now() + 8 * 3600000).toISOString();
  await sql.query(
    "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,$4)",
    [hash(raw), adminId, csrf, expiresAt],
  );
  return { raw, csrf, expiresAt };
}
export async function session(
  pool: Pool,
  raw?: string,
): Promise<Session | undefined> {
  if (!raw) return;
  const row = (
    await pool.query(
      "SELECT a.id,a.username,a.telegram_id,a.operator,s.csrf,s.expires_at FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [hash(raw)],
    )
  ).rows[0];
  if (!row) return;
  return {
    admin: {
      id: row.id,
      username: row.username,
      telegramId: row.telegram_id ?? undefined,
      operator: row.operator,
    },
    csrf: row.csrf,
    expiresAt: row.expires_at.toISOString(),
  };
}
export async function claim(pool: Pool, username: string, password: string) {
  const encoded = await passwordHash(password);
  return transaction(pool, async (sql) => {
    const row = (
      await sql.query("SELECT claimed FROM deployment WHERE id=true FOR UPDATE")
    ).rows[0];
    requireThat(row && !row.claimed, "already_claimed", 409);
    const id = randomUUID();
    await sql.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,$3,true)",
      [id, username, encoded],
    );
    await sql.query(
      "UPDATE deployment SET claimed=true,bootstrap_hash=NULL,bootstrap_expires_at=NULL WHERE id=true",
    );
    await sql.query(
      "INSERT INTO operator_audit(actor,action,target) VALUES($1,'deployment.claimed','deployment')",
      [id],
    );
    return makeSession(sql, id);
  });
}
export async function login(pool: Pool, username: string, password: string) {
  const row = (
    await pool.query("SELECT id,password_hash FROM admins WHERE username=$1", [
      username,
    ])
  ).rows[0];
  // Equal-cost password work also runs for unknown accounts.
  const fallback = `scrypt:7cfaa5dbf417b4029c974cde4fe0a1e4:${"0".repeat(128)}`;
  const valid = await verifyPassword(password, row?.password_hash ?? fallback);
  requireThat(row && valid, "invalid_login", 401);
  return transaction(pool, (sql) => makeSession(sql, row.id));
}
export function operator(admin: Admin) {
  requireThat(admin.operator, "operator_required", 403);
}
