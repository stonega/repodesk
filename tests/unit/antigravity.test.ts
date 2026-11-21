import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityAuth,
  packAntigravityAuthBundle,
  unpackAntigravityAuthBundle,
} from "../../src/coding/local/antigravity-auth.ts";
import {
  antigravityAuthFailure,
  antigravityFailureCode,
  antigravityTranscript,
  runAntigravityConversation,
} from "../../src/coding/local/antigravity-conversation.ts";
import { LocalRunnerClient } from "../../src/coding/local/client.ts";
import type { LocalRunner } from "../../src/coding/local/protocol.ts";
import { runnerApp } from "../../src/coding/local/runner-server.ts";
import {
  antigravitySettingsJson,
  runnerSettings,
} from "../../src/coding/local/settings.ts";
import { RunnerSupervisor } from "../../src/coding/local/supervisor.ts";
import type { TaskRuntime } from "../../src/coding/local/task-runtime.ts";
import {
  checkCodingPayload,
  codingDestination,
} from "../../src/coding/policy.ts";
import { antigravityView, saveAntigravity } from "../../src/coding/service.ts";
import {
  AntigravityLocalWorkerAdapter,
  CodexLocalWorkerAdapter,
  CodingWorkerRegistry,
} from "../../src/coding/worker-adapter.ts";
import { decrypt } from "../../src/setup/credentials.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

test("AntigravityAuth starts Google OAuth, completes with pasted code, seals bundle, and isolates workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-auth-"));
  try {
    const executable = join(dir, "fake-agy");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv[2] !== "acp" || process.argv[3] !== "--login") process.exit(2);
if (!process.env.SSH_CONNECTION) process.exit(3);
process.stdout.write("Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc123\\n\\nThen paste the authorization code:\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", (line) => {
  const code = line.trim();
  if (code !== "valid-code-123" && !code.includes("code=valid-code-123")) {
    process.stderr.write("invalid_grant: invalid authorization code\\n");
    process.exit(1);
  }
  const dirPath = path.join(process.env.HOME, ".gemini", "antigravity-cli");
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "oauth_tokens.json"), JSON.stringify({ refresh_token: "super-secret-refresh" }));
  process.exit(0);
});
`,
    );
    await chmod(executable, 0o755);
    const settings = runnerSettings.parse({
      CODEX_RUNNER_STATE: dir,
      CODEX_RUNNER_TOKEN: "management-token".repeat(3),
      CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
    });
    const auth = new AntigravityAuth(settings, executable);
    await auth.initialize();

    const ws = randomUUID();
    const started = await auth.start(ws);
    expect(started.state).toBe("pending");
    expect(started.verificationUrl).toContain(
      "https://accounts.google.com/o/oauth2/auth",
    );

    const completed = await auth.complete(
      ws,
      "https://antigravity.google/oauth-callback?code=valid-code-123&state=abc123",
    );
    expect(completed).toEqual({ state: "connected" });
    expect(await auth.status(ws)).toEqual({ state: "connected" });

    // Stored on disk encrypted, not plaintext.
    const sealed = await readFile(
      join(dir, "antigravity-auth", ws, "credential.json"),
      "utf8",
    );
    expect(sealed).not.toContain("super-secret-refresh");

    // Unpacking restores the file in a fresh task HOME.
    const bundle = await auth.read(ws);
    const restoreHome = join(dir, "task-home");
    await mkdir(restoreHome, { recursive: true });
    await unpackAntigravityAuthBundle(bundle, restoreHome);
    const restored = await readFile(
      join(restoreHome, ".gemini", "antigravity-cli", "oauth_tokens.json"),
      "utf8",
    );
    expect(restored).toContain("super-secret-refresh");

    // Another workspace stays disconnected.
    const other = randomUUID();
    expect(await auth.status(other)).toEqual({ state: "disconnected" });
    await expect(auth.read(other)).rejects.toThrow(
      "coding_device_auth_required",
    );

    // Invalid code is rejected cleanly.
    const ws2 = randomUUID();
    await auth.start(ws2);
    await expect(auth.complete(ws2, "wrong-code")).rejects.toThrow(
      "coding_antigravity_login_rejected",
    );
    expect(await auth.status(ws2)).toEqual({ state: "failed" });

    // Logout removes credentials.
    expect(await auth.logout(ws)).toEqual({ state: "disconnected" });
    await expect(auth.read(ws)).rejects.toThrow("coding_device_auth_required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AntigravityAuth generation fencing protects token refresh and invalidation across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-fence-"));
  const settings = runnerSettings.parse({
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_TOKEN: "management-token".repeat(3),
    CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
  });
  const ws = randomUUID();
  const makeBundle = (token: string) =>
    JSON.stringify({
      format: "repodesk-antigravity-files-v1",
      files: {
        ".gemini/antigravity-cli/oauth_tokens.json":
          Buffer.from(token).toString("base64"),
      },
    });
  try {
    let auth = new AntigravityAuth(settings);
    const oldGen = await auth.save(ws, makeBundle("token-old"));
    expect(await auth.capture(ws, oldGen, makeBundle("token-refreshed"))).toBe(
      true,
    );
    auth = new AntigravityAuth(settings);
    await auth.initialize();
    expect(await auth.read(ws)).toContain(
      Buffer.from("token-refreshed").toString("base64"),
    );

    await auth.invalidate(ws, oldGen);
    expect(await auth.status(ws)).toEqual({ state: "auth_required" });
    expect(await auth.capture(ws, oldGen, makeBundle("token-stale"))).toBe(
      false,
    );

    const nextGen = await auth.save(ws, makeBundle("token-new"));
    await auth.invalidate(ws, oldGen);
    expect(await auth.read(ws)).toContain(
      Buffer.from("token-new").toString("base64"),
    );
    await auth.logout(ws);
    expect(await auth.capture(ws, nextGen, makeBundle("token-stale"))).toBe(
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packAntigravityAuthBundle ignores logs, databases, and settings.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-pack-"));
  try {
    const cliDir = join(dir, ".gemini", "antigravity-cli");
    await mkdir(join(cliDir, "log"), { recursive: true });
    await writeFile(join(cliDir, "log", "cli.log"), "verbose log");
    await writeFile(join(cliDir, "conversation_summaries.db"), "sqlite");
    await writeFile(join(cliDir, "settings.json"), '{"model":"test"}');
    await writeFile(join(cliDir, "oauth_creds.json"), '{"token":"abc"}');
    const packed = await packAntigravityAuthBundle(dir);
    expect(packed).toBeDefined();
    const parsed = JSON.parse(packed as string);
    expect(Object.keys(parsed.files)).toEqual([
      ".gemini/antigravity-cli/oauth_creds.json",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAntigravityConversation parses stream-json, records usage and transcripts, and runs validation correction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-conv-"));
  try {
    const executable = join(dir, "fake-agy");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let turn = 0;
process.stdout.write(JSON.stringify({ event: "init", conversation_id: "agy-conv-123", init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "always-proceed" } }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.event !== "user") process.exit(1);
  turn++;
  if (turn === 1) {
    process.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "agy-conv-123",
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "bun test" }, output: "ok API_KEY=secret-value-12345" }
      }
    }) + "\\n");
    // Return invalid completed result (missing verificationCommands) to exercise 1-turn correction.
    const bad = {
      status: "completed",
      intent: "implement",
      evidenceRevision: 1,
      evidence: "fix bug",
      publishRequested: true,
      summary: "Fixed bug",
      blocker: null,
      question: null,
      title: "Fix bug",
      body: "Body",
      verificationCommands: []
    };
    process.stdout.write(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "agy-conv-123",
        status: "SUCCESS",
        response: JSON.stringify(bad),
        structured_output: bad,
        num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1200 }
      }
    }) + "\\n");
  } else {
    const good = {
      status: "completed",
      intent: "implement",
      evidenceRevision: 1,
      evidence: "fix bug",
      publishRequested: true,
      summary: "Fixed bug cleanly",
      blocker: null,
      question: null,
      title: "Fix bug",
      body: "Body",
      verificationCommands: ["bun test"]
    };
    process.stdout.write(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "agy-conv-123",
        status: "SUCCESS",
        response: JSON.stringify(good),
        structured_output: good,
        num_turns: 2,
        usage: { input_tokens: 1500, output_tokens: 300, thinking_tokens: 80, cache_read_tokens: 900, total_tokens: 1800 }
      }
    }) + "\\n");
  }
});
`,
    );
    await chmod(executable, 0o755);

    const recorded: unknown[] = [];
    const fakeChannel = {
      record: (entry: unknown) => recorded.push(entry),
      close: () => {},
      flushTranscript: async () => {},
    } as unknown as Parameters<typeof runAntigravityConversation>[0]["channel"];

    const res = await runAntigravityConversation({
      binary: executable,
      cwd: dir,
      env: { PATH: process.env.PATH, GEMINI_API_KEY: "secret-value-12345" },
      prompt: "Fix the bug",
      schemaPath: join(dir, "schema.json"),
      model: "gemini-4-neon-high",
      effort: "high",
      channel: fakeChannel,
    });

    expect(res.threadId).toBe("agy-conv-123");
    expect(res.result.status).toBe("completed");
    expect(res.result.verificationCommands).toEqual(["bun test"]);
    expect(res.tokens).toBe(1800);
    expect(res.tokenUsage).toEqual({
      input: 600,
      output: 300,
      cacheRead: 900,
      cacheWrite: 0,
      reasoning: 80,
      total: 1800,
    });
    expect(res.usageUnknown).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain("secret-value-12345");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAntigravityConversation classifies auth failures as CodexAuthError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-autherr-"));
  try {
    const executable = join(dir, "fake-agy");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", () => {
  process.stdout.write(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: "authentication required: You are not logged into Antigravity.",
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
    }
  }) + "\\n");
  process.exit(1);
});
`,
    );
    await chmod(executable, 0o755);
    await expect(
      runAntigravityConversation({
        binary: executable,
        cwd: dir,
        env: { PATH: process.env.PATH },
        prompt: "Test",
        schemaPath: join(dir, "schema.json"),
      }),
    ).rejects.toThrow("coding_device_auth_required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("antigravityAuthFailure, antigravityFailureCode, antigravityTranscript, and settingsJson helpers", () => {
  expect(antigravityAuthFailure("You are not logged into Antigravity.")).toBe(
    true,
  );
  expect(antigravityAuthFailure("API_KEY_INVALID")).toBe(true);
  expect(antigravityAuthFailure("syntax error in file")).toBe(false);

  expect(antigravityFailureCode("429 RESOURCE_EXHAUSTED")).toBe(
    "coding_provider_rate_limited",
  );
  expect(antigravityFailureCode("context window exceeded")).toBe(
    "coding_context_exceeded",
  );
  expect(antigravityFailureCode("invalid model selection")).toBe(
    "coding_provider_request_invalid",
  );

  const entry = antigravityTranscript(
    "conv-1",
    0,
    {
      state: "DONE",
      step_index: 2,
      step_type: "agent_response",
      text_delta: JSON.stringify({
        status: "completed",
        summary: "Updated module",
      }),
    },
    [],
  );
  expect(entry?.role).toBe("codex");
  expect(entry?.title).toBe("Task result");
  expect(entry?.text).toBe("Updated module");

  const geminiSettings = JSON.parse(
    antigravitySettingsJson({
      authMode: "gemini_api_key",
      repoPath: "/task/repo",
      readOnly: true,
    }),
  );
  expect(geminiSettings.modelProvider).toBe("gemini");
  expect(geminiSettings.trustedWorkspaces).toEqual(["/task/repo"]);
  expect(geminiSettings.disableSlashCommands).toBe(true);
  expect(geminiSettings.permissions.deny).toContain("write_file(*)");
});

test("saveAntigravity, codingDestination, checkCodingPayload, and AntigravityLocalWorkerAdapter", () => {
  const w = workspace();
  const admin = { id: w.operatorId, username: "op", operator: true };
  const key = "ab".repeat(32);
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      { id: 7001, full_name: "example/repo", default_branch: "main" },
    ],
  };
  grantGitHubAccess(w, ["101"]);

  const initial = antigravityView(w, admin);
  expect(initial.revision).toBe(0);
  expect(initial.settings.enabled).toBe(false);
  expect(initial.apiKeyConfigured).toBe(false);

  const saved = saveAntigravity(
    w,
    admin,
    {
      revision: 0,
      settings: {
        enabled: true,
        authMode: "gemini_api_key",
        model: "gemini-4-neon-high",
        effort: "high",
        baseUrl: "https://gemini.example.test",
      },
      apiKey: "AIza-secret-test-key",
    },
    key,
  );
  expect(saved.revision).toBe(1);
  expect(saved.apiKeyConfigured).toBe(true);
  expect(w.antigravity?.apiKey).toBeDefined();
  expect(w.antigravity?.apiKey).not.toContain("AIza-secret-test-key");
  expect(
    decrypt(key, `antigravity-api-key:${w.id}`, w.antigravity?.apiKey ?? ""),
  ).toBe("AIza-secret-test-key");

  const payload = codingDestination(
    w,
    "101",
    { repositoryId: 7001, title: "Fix issue", body: "Please fix" },
    "antigravity",
  );
  expect(payload.engine).toBe("antigravity");
  expect(payload.authMode).toBe("gemini_api_key");
  expect(payload.model).toBe("gemini-4-neon-high");
  expect(payload.effort).toBe("high");
  expect(payload.baseUrl).toBe("https://gemini.example.test");
  expect(() => checkCodingPayload(w, "101", payload)).not.toThrow();

  // Changing revision invalidates payload.
  saveAntigravity(
    w,
    admin,
    {
      revision: 1,
      settings: { enabled: true, authMode: "google_oauth" },
      apiKey: null,
    },
    key,
  );
  expect(() => checkCodingPayload(w, "101", payload)).toThrow(
    "coding_configuration_changed",
  );

  // Worker registry supports Antigravity alongside Codex.
  const fakeRunner = {} as LocalRunner;
  const registry = new CodingWorkerRegistry([
    new CodexLocalWorkerAdapter(fakeRunner),
    new AntigravityLocalWorkerAdapter(fakeRunner),
  ]);
  expect(registry.resolve("antigravity")?.kind).toBe("antigravity");
  expect(registry.resolve("antigravity")?.capabilities().available).toBe(true);
});

test("runnerApp & LocalRunnerClient proxy Gemini API keys and expose antigravity-auth endpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-agy-runner-"));
  const token = "runner-secret-token-".repeat(2);
  try {
    const fakeEngine: TaskRuntime = {
      ready: async () => {},
      create: async () => {},
      copyFile: async () => {},
      start: async () => "",
      inspect: async () => ({ Running: true, Status: "running", ExitCode: 0 }),
      readText: async () => "",
      stop: async () => {},
      remove: async () => {},
      createVolume: async () => {},
      listVolumes: async () => [],
      removeVolumes: async () => {},
    };
    const supervisor = new RunnerSupervisor(
      runnerSettings.parse({
        CODEX_RUNNER_STATE: dir,
        CODEX_RUNNER_TOKEN: token,
      }),
      fakeEngine,
    );
    await supervisor.initialize();
    const ws = randomUUID();
    const bundle = JSON.stringify({
      format: "repodesk-antigravity-files-v1",
      files: {
        ".gemini/antigravity-cli/oauth_tokens.json":
          Buffer.from('{"token":"ok"}').toString("base64"),
      },
    });
    await supervisor.antigravity.save(ws, bundle);

    const upstreamCalls: { url: string; apiKey: string | null }[] = [];
    const app = runnerApp(supervisor, (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      upstreamCalls.push({ url, apiKey: headers.get("x-goog-api-key") });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const client = new LocalRunnerClient("http://runner.local", token, ((
      u: RequestInfo | URL,
      i?: RequestInit,
    ) =>
      Promise.resolve(
        app.fetch(new Request(u.toString(), i)),
      )) as typeof fetch);
    expect(await client.antigravityStatus(ws)).toEqual({ state: "connected" });
    expect(await client.antigravityLogout(ws)).toEqual({
      state: "disconnected",
    });
    expect(await client.antigravityStatus(ws)).toEqual({
      state: "disconnected",
    });

    // Unauthorized Gemini proxy call is denied.
    const denied = await app.fetch(
      new Request("http://runner.local/gemini/v1beta/models", {
        headers: { "x-goog-api-key": "invalid-proxy-token" },
      }),
    );
    expect(denied.status).toBe(401);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
