import { readFile } from "node:fs/promises";
import { database } from "../src/db/pool.ts";
import { Store } from "../src/db/repositories.ts";
import { Fault, requireThat } from "../src/domain.ts";
import { configurePrivateTopicFallback } from "../src/telegram/topic-fallback.ts";

// Explicit operator recovery after the specified member asks for main-chat fallback.
// No message is sent and no failed/unknown delivery is replayed by this command.
const [mode, workspaceId, actor, botId] = process.argv.slice(2);
requireThat(
  (mode === "enable" || mode === "disable") && workspaceId && actor && botId,
  "topic_fallback_arguments_required",
);
const pool = database(process.env.DATABASE_URL ?? "");
try {
  const key = (
    await readFile(process.env.ENCRYPTION_KEY_FILE ?? "", "utf8")
  ).trim();
  const store = new Store(pool, undefined, key);
  const deployment = await store.deployment();
  requireThat(deployment.bot?.id === botId, "telegram_identity_changed", 409);
  await store.change(workspaceId, (w) => {
    configurePrivateTopicFallback(
      w,
      w.operatorId,
      actor,
      botId,
      mode === "enable",
    );
  });
  console.log(JSON.stringify({ enabled: mode === "enable", audited: true }));
} catch (error) {
  console.error(
    JSON.stringify({
      code:
        error instanceof Fault
          ? error.code
          : "topic_fallback_configuration_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
