import { PluginService } from "../../src/agent/plugin-service.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { targetsFor } from "../../src/code-truth/config.ts";
import { config } from "../../src/config.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { requireThat } from "../../src/domain.ts";
import { configuredGitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { repositoryAccess } from "../../src/github/user-access.ts";

// Same production service and current credential lookup; no saved grant is restored.
const cfg = config();
const pool = database(cfg.DATABASE_URL);
const store = new Store(pool, undefined, cfg.ENCRYPTION_KEY);
try {
  const workspaceId = "3b2dfe82-61c6-444e-8058-7a179f2bf27a";
  const w = await store.read(workspaceId);
  const apps = new GitHubApps(
    store,
    cfg.ENCRYPTION_KEY,
    configuredGitHubApp(cfg),
  );
  const plugins = new PluginService(
    store,
    cfg.PI_EXTENSIONS_FILE,
    new CodeTruthClient(cfg.CODE_TRUTH_URL ?? "", cfg.CODE_TRUTH_TOKEN ?? ""),
    apps,
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
  const actor = w.runs.find(
    (run) => run.id === "f4a1cac1-f7f6-47dd-906d-29a9b3bd5c9e",
  )?.actor;
  requireThat(
    actor && w.members.some((member) => member.id === actor && member.active),
    "access_denied",
    403,
  );
  const targets = targetsFor(
    w.plugins?.codeTruth ?? { enabled: false, repositories: [] },
    workspaceId,
  );
  const ids = targets.map((target) => {
    const repository = w.github?.repositories.find(
      (repo) =>
        `https://github.com/${repo.full_name}`.toLowerCase() ===
        target.repositoryUrl.toLowerCase(),
    );
    requireThat(
      repository && repositoryAccess(w, actor, repository.id),
      "github_user_access_denied",
      403,
    );
    return repository.id;
  });
  const client = new CodeTruthClient(
    cfg.CODE_TRUTH_URL ?? "",
    cfg.CODE_TRUTH_TOKEN ?? "",
  ).withGitHub(async () => {
    const current = await store.read(workspaceId);
    requireThat(
      current.members.some((member) => member.id === actor && member.active) &&
        ids.every((id) => repositoryAccess(current, actor, id)),
      "github_user_access_denied",
      403,
    );
    requireThat(
      current.github?.installationId === w.github?.installationId &&
        current.github?.revision === w.github?.revision,
      "github_user_access_denied",
      403,
    );
    const app = await apps.get(current.operatorId);
    requireThat(
      app && current.github?.installationId,
      "github_app_not_configured",
      409,
    );
    const credential = await app.installationToken(
      current.github.installationId,
      ids,
    );
    return {
      token: credential.token,
      identity: `app:${app.config.id}:${current.github.installationId}:${current.github.revision}`,
    };
  });
  const target = targets.find(
    (target) =>
      target.repositoryUrl === "https://github.com/stonega/street-polls",
  );
  requireThat(target, "github_repository_not_connected", 409);
  await client.use(
    workspaceId,
    targets,
    AbortSignal.timeout(60000),
    async (mcp) => {
      const result = await mcp.callTool({
        name: "get_file_excerpt",
        arguments: {
          target: target.id,
          network: "default",
          file: "README.md",
          offset: 1,
          limit: 5,
        },
      });
      const evidence = result.structuredContent as
        | { target?: { commit?: string; branch?: string } }
        | undefined;
      console.log(
        JSON.stringify({
          sourceReadProbe: true,
          repository: "stonega/street-polls",
          isError: result.isError === true,
          commit: evidence?.target?.commit,
          branch: evidence?.target?.branch,
          returnedBytes: JSON.stringify(
            result.structuredContent ?? result.content,
          ).length,
        }),
      );
      requireThat(
        result.isError !== true && evidence?.target?.commit,
        "source_probe_failed",
        503,
      );
    },
  );
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
