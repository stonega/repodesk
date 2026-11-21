import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/app.ts";
import { codingExtension } from "../../src/coding/extension.ts";
import type {
  AntigravityAuthStatus,
  LocalAntigravityAuth,
  LocalDeviceAuth,
  LocalEnvironmentControl,
  LocalRunner,
  LocalStart,
} from "../../src/coding/local/protocol.ts";
import { CodingService } from "../../src/coding/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { GitHubService } from "../../src/github/service.ts";
import { SetupService } from "../../src/setup/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Antigravity CLI plugin integration", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `telo_antigravity_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  const encryptionKey = "ab".repeat(32);
  let store: Store;
  let sessionCookie = "";
  let csrf = "";

  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(present(url));
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'agyadmin','unused',true)",
      [operatorId],
    );
    await store.pool.query(
      "UPDATE deployment SET claimed=true, data=jsonb_set(jsonb_set(data,'{active}','true'),'{bot}','{\"id\":\"999\",\"username\":\"fixture\"}')",
    );
    const token = randomUUID();
    csrf = randomUUID();
    const { hash } = await import("../../src/setup/credentials.ts");
    await store.pool.query(
      "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [hash(token), operatorId, csrf],
    );
    sessionCookie = `telo_session=${token}`;
  });

  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });

  async function createWorkspaceFixture() {
    const w = workspace();
    w.operatorId = operatorId;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", default_branch: "main" },
      ],
    };
    grantGitHubAccess(w, ["101"]);
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return w.id;
  }

  test("admin API configures Antigravity CLI, handles Google OAuth start/complete/logout, and isolates tasks from Codex", async () => {
    const workspaceId = await createWorkspaceFixture();
    let agyAuth: AntigravityAuthStatus = { state: "disconnected" };
    let submittedCode = "";

    const deviceAuth: LocalDeviceAuth &
      LocalAntigravityAuth &
      Partial<LocalEnvironmentControl> = {
      deviceStatus: async () => ({ state: "disconnected" }),
      deviceStart: async () => ({ state: "pending" }),
      deviceLogout: async () => ({ state: "disconnected" }),
      antigravityStatus: async () => agyAuth,
      antigravityStart: async () => {
        agyAuth = {
          state: "pending",
          verificationUrl:
            "https://accounts.google.com/o/oauth2/auth?client_id=test&state=123",
        };
        return agyAuth;
      },
      antigravityComplete: async (_id, code) => {
        submittedCode = code;
        agyAuth = { state: "connected" };
        return agyAuth;
      },
      antigravityLogout: async () => {
        agyAuth = { state: "disconnected" };
        return agyAuth;
      },
    };

    const app = createApp({
      store,
      setup: new SetupService(store, encryptionKey, "http://localhost:3000"),
      origin: "http://localhost:3000",
      plugins: new PluginService({ store }),
      github: new GitHubService(store, encryptionKey, "http://localhost:3000"),
      encryptionKey,
      deviceAuth,
    });

    const req = (path: string, method = "GET", body?: unknown) =>
      app.fetch(
        new Request(`http://localhost:3000${path}`, {
          method,
          headers: {
            cookie: sessionCookie,
            origin: "http://localhost:3000",
            "x-csrf-token": csrf,
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      );

    // Initial GET returns disabled defaults.
    const initialRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity`,
    );
    expect(initialRes.status).toBe(200);
    const initial = await initialRes.json();
    expect(initial.settings.enabled).toBe(false);
    expect(initial.settings.authMode).toBe("google_oauth");
    expect(initial.oauthAuth.state).toBe("disconnected");

    // Enable with Google OAuth and model/effort.
    const saveRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity`,
      "PUT",
      {
        revision: 0,
        settings: {
          enabled: true,
          authMode: "google_oauth",
          model: "gemini-4-neon-high",
          effort: "high",
        },
      },
    );
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();
    expect(saved.revision).toBe(1);
    expect(saved.settings.enabled).toBe(true);
    expect(saved.settings.model).toBe("gemini-4-neon-high");

    // Start Google OAuth.
    const startRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity/auth/start`,
      "POST",
      {},
    );
    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.state).toBe("pending");
    expect(started.verificationUrl).toContain("accounts.google.com");

    // Complete Google OAuth with pasted code.
    const completeRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity/auth/complete`,
      "POST",
      { code: "pasted-oauth-code" },
    );
    expect(completeRes.status).toBe(200);
    expect(submittedCode).toBe("pasted-oauth-code");
    const completed = await completeRes.json();
    expect(completed.oauthAuth.state).toBe("connected");

    // Disconnect Google OAuth.
    const logoutRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity/auth/logout`,
      "POST",
      {},
    );
    expect(logoutRes.status).toBe(200);
    const loggedOut = await logoutRes.json();
    expect(loggedOut.oauthAuth.state).toBe("disconnected");

    // Switch to Gemini API key mode and verify encrypted key storage.
    const apiKeyRes = await req(
      `/api/admin/workspaces/${workspaceId}/plugins/antigravity`,
      "PUT",
      {
        revision: loggedOut.revision,
        settings: {
          enabled: true,
          authMode: "gemini_api_key",
          model: "gemini-3.8-flash-high",
        },
        apiKey: "AIza-integration-key",
      },
    );
    expect(apiKeyRes.status).toBe(200);
    const apiKeyPage = await apiKeyRes.json();
    expect(apiKeyPage.apiKeyConfigured).toBe(true);
  });

  test("codingExtension starts Antigravity task automatically when only Antigravity is enabled and executor dispatches it", async () => {
    const workspaceId = await createWorkspaceFixture();
    await store.change(workspaceId, (w) => {
      w.antigravity = {
        revision: 1,
        settings: {
          enabled: true,
          authMode: "gemini_api_key",
          model: "gemini-4-neon-high",
          effort: "high",
        },
        apiKey: undefined,
      };
    });

    const run = await store.change(workspaceId, (w) => {
      const r = createRun(
        w,
        "101",
        "Fix bug in example/workspace",
        "101",
        0,
        "gpt-4.1-mini",
      );
      r.status = "running";
      return structuredClone(r);
    });
    const w = await store.read(workspaceId);
    const catalog = ExtensionCatalog.fromSnapshot(
      [],
      [codingExtension(store, w)],
    );
    const input: AgentInput = {
      workspaceId,
      runId: run.id,
      actor: "101",
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "unused",
      system: "test",
      prompt: "Fix bug in example/workspace",
      transcript: [],
      tools: [],
      maxTurns: 1,
      signal: new AbortController().signal,
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    const host = present(await catalog.open(input));
    let parsed: { engine: string; state: string };
    try {
      const startTool = present(
        host.tools.find((t) => t.name === "start_development_task"),
      );
      const firstSource = present(run.sources[0]);
      const res = await startTool.execute(
        "call-1",
        {
          repositoryId: 7001,
          targetRepository: "example/workspace",
          sourceIds: [firstSource.id],
        },
        new AbortController().signal,
      );
      parsed = JSON.parse(
        (res.content[0] as { type: "text"; text: string }).text,
      );
    } finally {
      await host.close();
    }
    expect(parsed.engine).toBe("antigravity");
    expect(parsed.state).toBe("queued");

    // Dispatch via CodingService with a fake LocalRunner and fake GitHubApp.
    const starts: LocalStart[] = [];
    const fakeRunner: LocalRunner & Partial<LocalAntigravityAuth> = {
      start: async (startInput) => {
        starts.push(startInput);
      },
      status: async () => ({ state: "running", phase: "implement" }),
      publish: async () => {},
      cancel: async () => {},
      antigravityLogout: async () => ({ state: "disconnected" }),
    };
    const apps = new GitHubApps(store, encryptionKey);
    apps.get = async () =>
      ({
        installationToken: async () => ({
          token: "ghs_test_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      }) as never;

    const service = new CodingService(store, apps, fakeRunner, encryptionKey);
    await service.tick(workspaceId);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.payload.engine).toBe("antigravity");
    expect(starts[0]?.payload.authMode).toBe("gemini_api_key");
    expect(starts[0]?.payload.model).toBe("gemini-4-neon-high");
    expect(starts[0]?.payload.effort).toBe("high");
  });
});
