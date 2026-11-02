import { PluginService } from "../../src/agent/plugin-service.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { config } from "../../src/config.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { configuredGitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";

// Same production service and current credential lookup; no saved grant is restored.
const cfg = config();
const pool = database(cfg.DATABASE_URL);
const store = new Store(pool, undefined, cfg.ENCRYPTION_KEY);
try {
  const workspaceId = "3b2dfe82-61c6-444e-8058-7a179f2bf27a";
  const w = await store.read(workspaceId);
  const plugins = new PluginService(
    store,
    cfg.PI_EXTENSIONS_FILE,
    new CodeTruthClient(cfg.CODE_TRUTH_URL ?? "", cfg.CODE_TRUTH_TOKEN ?? ""),
    new GitHubApps(store, cfg.ENCRYPTION_KEY, configuredGitHubApp(cfg)),
  );
  const operator = {
    id: w.operatorId,
    username: "incident-operator",
    operator: true,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await plugins.codeTruthStatus(operator, workspaceId);
    console.log(JSON.stringify({ codeTruthProbe: true, ...status }));
    if (!status.syncing) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch (error) {
  console.log(
    JSON.stringify({
      codeTruthProbe: true,
      code:
        error instanceof Error && /^\w+$/.test(error.message)
          ? error.message
          : "diagnostic_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
