import { config } from "../src/config.ts";
import { database } from "../src/db/pool.ts";
import { Store } from "../src/db/repositories.ts";
import { requireThat } from "../src/domain.ts";
import { SetupService } from "../src/setup/service.ts";

// Deliberate operator command. Never run by migrations, startup, tests or Compose.
requireThat(
  process.env.REGISTER_STAGING_WEBHOOK === "yes",
  "Set REGISTER_STAGING_WEBHOOK=yes for your dedicated staging bot.",
);
const cfg = config();
const pool = database(cfg.DATABASE_URL);
const store = new Store(pool);
try {
  const row = (
    await pool.query(
      "SELECT id,username,telegram_id FROM admins WHERE operator=true ORDER BY id LIMIT 1",
    )
  ).rows[0];
  requireThat(row, "claim_setup_first");
  const result = await new SetupService(
    store,
    cfg.ENCRYPTION_KEY,
    cfg.PUBLIC_ORIGIN,
    undefined,
    cfg.TELEGRAM_TRANSPORT,
  ).register({
    id: row.id,
    username: row.username,
    telegramId: row.telegram_id,
    operator: true,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
