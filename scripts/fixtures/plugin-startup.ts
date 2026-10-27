import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { emptyCloudflare } from "../../src/cloudflare/config.ts";
import { CloudflareService } from "../../src/cloudflare/service.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";
import { codeTruthTools } from "../../src/code-truth/config.ts";
import { emptyCoding } from "../../src/coding/config.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { type Deployment, Fault, settingsSchema } from "../../src/domain.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GoogleService } from "../../src/google/service.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { SearchConsoleService } from "../../src/search-console/service.ts";
import {
  createRun,
  enrollOwner,
  newWorkspace,
} from "../../src/workspaces/service.ts";

export const pluginStartupCases = [
  "connected",
  "stale",
  "unavailable",
  "disconnected",
  "denied",
  "missing_service",
  "missing_app",
  "stale_revision",
] as const;

/** Same factories as production, with synthetic tenant state and no external access. */
export async function verifyPluginStartup() {
  const cases = pluginStartupCases.flatMap((mode) =>
    (["owner", "member"] as const).map((role) => ({ mode, role })),
  );
  for (const { mode, role } of cases) {
    let network = 0,
      credentials = 0,
      unexpectedDatabase = 0;
    const forbidden = Object.assign(
      async () => {
        network++;
        throw new Error("Optional dependency contacted during startup");
      },
      {
        preconnect() {
          network++;
          throw new Error("Optional dependency preconnected during startup");
        },
      },
    );
    const store = new Store(
      database("postgres://unused@127.0.0.1:1/unused"),
      new RuntimeLogger(undefined, "worker", () => {}),
    );
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = forbidden;
    try {
      store.pool.query = async () => {
        unexpectedDatabase++;
        throw new Error("Unexpected database access in startup fixture");
      };
      const w = newWorkspace(
        "00000000-0000-4000-8000-000000000001",
        settingsSchema.parse({ name: "Startup fixture", timezone: "UTC" }),
      );
      enrollOwner(w, role === "owner" ? "101" : "303");
      if (role === "member") w.members.push({ id: "101", role, active: true });
      w.github = {
        revision: 1,
        installationId: 1,
        repositories: [
          {
            id: 1,
            full_name: "example/source",
            default_branch: "main",
            private: true,
          },
        ],
      };
      const actor = w.members.find((member) => member.id === "101");
      assert.ok(actor);
      actor.github = {
        id: 101,
        login: "fixture",
        status:
          mode === "disconnected"
            ? "disconnected"
            : mode === "unavailable"
              ? "unavailable"
              : "connected",
        connectionRevision: mode === "stale_revision" ? 0 : 1,
        syncedAt:
          mode === "stale"
            ? "2000-01-01T00:00:00.000Z"
            : new Date().toISOString(),
        repositories:
          mode === "denied"
            ? []
            : [
                {
                  id: 1,
                  full_name: "example/source",
                  permissions: { pull: true, push: true, admin: true },
                },
              ],
      };
      w.plugins = {
        revision: 1,
        entries: [],
        google: {
          google: {
            settings: { enabled: true },
            clientId: "fixture.apps.googleusercontent.com",
            clientSecret: "synthetic",
          },
        },
        cloudflare: { settings: { ...emptyCloudflare, enabled: true } },
        codeTruth: {
          enabled: true,
          repositories: [
            {
              id: "source",
              repositoryUrl: "https://github.com/example/source",
              workspaces: [w.id],
            },
          ],
        },
      };
      w.coding = { revision: 1, settings: { ...emptyCoding, enabled: true } };
      const run = createRun(w, "101", "hi", "101", 0, "gpt-4.1-mini");
      run.status = "running";
      run.fence = 1;
      store.read = async (id) => {
        assert.equal(id, w.id);
        return structuredClone(w);
      };
      const key = "ab".repeat(32);
      const apps = new GitHubApps(store, key, undefined, forbidden);
      apps.get = async () => {
        credentials++;
        if (mode === "missing_app") return undefined;
        throw new Fault("github_unavailable", 503);
      };
      const code = new CodeTruthClient("http://unused.invalid", "synthetic");
      code.use = forbidden;
      const google = new GoogleService(
        store,
        key,
        "https://fixture.invalid",
        forbidden,
      );
      const plugins = new PluginService(
        store,
        undefined,
        mode === "missing_service" ? undefined : code,
        apps,
        new CloudflareService(store, key, forbidden),
        new SearchConsoleService(store, key, forbidden, google),
        google,
      );
      const model = selectedModel("gpt-4.1-mini");
      const input: AgentInput = {
        workspaceId: w.id,
        runId: run.id,
        actor: "101",
        model,
        apiKey: "synthetic",
        system: "Startup fixture",
        prompt: "hi",
        transcript: [],
        tools: [],
        maxTurns: 1,
        signal: AbortSignal.timeout(5000),
        guard: async () => {},
        reserve: async () => "synthetic",
        checkpoint: async () => {},
      };
      const deployment: Deployment = {
        version: 1,
        active: true,
        paused: false,
        credentials: {},
        model: model.id,
        ownerVerified: true,
        webhookReady: false,
      };
      let modelCalls = 0;
      const runner = await plugins.runner(
        deployment,
        w.id,
        (_model, context) => {
          modelCalls++;
          const names = context.tools?.map((tool) => tool.name) ?? [];
          for (const name of [
            "obsidian_query",
            "query_google_docs",
            "query_search_console",
            "query_cloudflare",
            "start_development_task",
            "propose_github_issue",
            ...codeTruthTools,
          ])
            assert.ok(names.includes(name), `${mode}: missing ${name}`);
          const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "stop",
            timestamp: 1,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          const stream = new AssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        },
      );
      assert.equal((await runner.run(input)).text, "Hello", mode);
      assert.equal(modelCalls, 1, mode);
      assert.equal(network, 0, `${mode}: unexpected network access`);
      assert.equal(credentials, 0, `${mode}: unexpected credential lookup`);
      assert.equal(unexpectedDatabase, 0, mode);
    } finally {
      globalThis.fetch = fetchBefore;
      await store.pool.end();
    }
  }
  return cases.length;
}
