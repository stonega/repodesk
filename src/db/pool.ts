import { Pool, type PoolClient } from "pg";
export type Sql = Pick<PoolClient, "query">;
export function database(url: string) {
  return new Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
}
export async function transaction<T>(
  pool: Pool,
  action: (sql: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
