import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveText,
  type ContainerEngine,
  containerArgs,
} from "../../src/coding/local/podman.ts";
import type { LocalStart } from "../../src/coding/local/protocol.ts";
import { runnerApp } from "../../src/coding/local/runner-server.ts";
import {
  codexConfig,
  runnerSettings,
} from "../../src/coding/local/settings.ts";
import {
  RunnerSupervisor,
  taskKey,
} from "../../src/coding/local/supervisor.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "deepx-codex-test-"));
  dirs.push(dir);
  const settings = runnerSettings.parse({
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_TOKEN: "management-token".repeat(3),
    CODEX_PROVIDER_API_KEY: "provider-secret",
    CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
  });
  const jobInputs: string[] = [];
  const calls: { args: string[]; env?: { [key: string]: string } }[] = [];
  let exitCode = 0;
  const engine: ContainerEngine = {
    async readText(_container, path) {
      return path.endsWith("base-sha")
        ? "a".repeat(40)
        : JSON.stringify({ prUrl: "https://github.com/example/repo/pull/43" });
    },
    async command(args, env) {
      calls.push({ args, env });
      if (args[0] === "cp" && args[1]?.endsWith(".input"))
        jobInputs.push(await readFile(args[1], "utf8"));
      if (args[0] === "inspect")
        return JSON.stringify({
          Running: false,
          Status: "exited",
          ExitCode: exitCode,
        });
      if (args[0] === "start" && args.includes("--attach"))
        return JSON.stringify({
          patch: "diff --git a/a b/a\n",
          threadId: "thread-123",
        });
      return "";
    },
  };
  const supervisor = new RunnerSupervisor(settings, engine);
  await supervisor.initialize();
  const input: LocalStart = {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    payload: {
      repositoryId: 1,
      repository: "example/repo",
      installationId: 1,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "develop",
      workflowFile: "deepx-codex.yml",
      title: "Fix bug",
      body: "Fix the bug",
      backend: "podman",
      checkCommand: "bun test",
    },
    issue: { number: 42, url: "https://github.com/example/repo/issues/42" },
    readToken: "read-only-github-token",
  };
  return {
    settings,
    jobInputs,
    calls,
    supervisor,
    input,
    engine,
    fail: () => {
      exitCode = 1;
    },
  };
}
test("task names are tenant-scoped; container boundary excludes host and bot access", async () => {
  const f = await fixture();
  const key = taskKey(f.input.workspaceId, f.input.taskId);
  expect(taskKey(randomUUID(), f.input.taskId)).not.toBe(key);
  expect(() => taskKey("../../host", f.input.taskId)).toThrow();
  const args = containerArgs(f.settings, key, `${key}-work`, "implement", {
    CODEX_TASK_TOKEN: "temporary",
  });
  for (const flag of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--pids-limit=256",
    "--pull=never",
  ])
    expect(args).toContain(flag);
  expect(args).not.toContain("--privileged");
  expect(args.join(" ")).not.toContain("podman.sock");
  expect(args.join(" ")).not.toContain("temporary");
  expect(codexConfig(f.settings)).toContain('env_key = "CODEX_TASK_TOKEN"');
  expect(codexConfig(f.settings)).not.toContain("provider-secret");
});
test("duplicate submission and supervisor restart preserve one isolated task", async () => {
  const f = await fixture();
  await Promise.all([f.supervisor.start(f.input), f.supervisor.start(f.input)]);
  expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(1);
  const state = await readFile(
    join(
      f.settings.CODEX_RUNNER_STATE,
      `${taskKey(f.input.workspaceId, f.input.taskId)}.json`,
    ),
    "utf8",
  );
  expect(state).not.toContain(f.input.readToken);
  expect(state).not.toContain("provider-secret");
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  await restarted.start(f.input);
  expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(1);
  await expect(
    restarted.start({ ...f.input, taskId: randomUUID() }),
  ).rejects.toThrow("coding_runner_busy");
  await expect(restarted.status(randomUUID(), f.input.taskId)).rejects.toThrow(
    "coding_task_not_found",
  );
});
test("checks precede publication; publication uses a fresh volume and only its scoped token", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("running");
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("ready");
  const implement = f.calls.find(
    (c) => c.args[0] === "create" && c.args.at(-1) === "implement",
  );
  expect(Object.keys(implement?.env ?? {})).toEqual(["CODEX_TASK_TOKEN"]);
  await f.supervisor.publish(
    f.input.workspaceId,
    f.input.taskId,
    "publish-token",
  );
  await f.supervisor.publish(
    f.input.workspaceId,
    f.input.taskId,
    "publish-token",
  );
  const publishers = f.calls.filter(
    (c) => c.args[0] === "create" && c.args.at(-1) === "publish",
  );
  expect(publishers).toHaveLength(1);
  expect(publishers[0]?.args).toContain(
    `${taskKey(f.input.workspaceId, f.input.taskId)}-publish:/task`,
  );
  expect(publishers[0]?.env).toEqual({ GITHUB_TOKEN: "publish-token" });
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).prUrl,
  ).toBe("https://github.com/example/repo/pull/43");
});
test("failed checks prevent publishing and cancellation cannot restart a task", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  f.fail();
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("failed");
  await expect(
    f.supervisor.publish(f.input.workspaceId, f.input.taskId, "token"),
  ).rejects.toThrow("coding_task_not_ready");
  const g = await fixture();
  await g.supervisor.start(g.input);
  await g.supervisor.cancel(g.input.workspaceId, g.input.taskId);
  await g.supervisor.start(g.input);
  expect(
    (await g.supervisor.status(g.input.workspaceId, g.input.taskId)).state,
  ).toBe("cancelled");
  expect(g.calls.filter((c) => c.args[0] === "create")).toHaveLength(1);
});
test("management authentication and task-scoped proxy never expose the provider key", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  let upstream: RequestInit | undefined;
  const app = runnerApp(f.supervisor, (async (_url, init) => {
    upstream = init;
    return new Response("data: done\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch);
  const path = `/tasks/${f.input.workspaceId}/${f.input.taskId}`;
  expect((await app.request(path)).status).toBe(401);
  const taskToken = f.calls.find(
    (c) => c.args[0] === "create" && c.args.at(-1) === "implement",
  )?.env?.CODEX_TASK_TOKEN;
  expect(
    (
      await app.request(path, {
        headers: { authorization: `Bearer ${taskToken}` },
      })
    ).status,
  ).toBe(401);
  const request = () =>
    app.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${taskToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: f.settings.CODEX_MODEL, input: "hello" }),
    });
  const response = await request();
  expect(response.status).toBe(200);
  expect(new Headers(upstream?.headers).get("authorization")).toBe(
    "Bearer provider-secret",
  );
  expect(await response.text()).not.toContain("provider-secret");
  await f.supervisor.cancel(f.input.workspaceId, f.input.taskId);
  expect((await request()).status).toBe(401);
});

test("metadata archives reject links and oversized entries without filesystem extraction", () => {
  const archive = Buffer.alloc(2048);
  archive.write("base-sha", 0);
  archive.write("00000000003\0", 124);
  archive[156] = 48;
  archive.write("abc", 512);
  expect(archiveText(archive)).toBe("abc");
  archive[156] = 50;
  expect(() => archiveText(archive)).toThrow("Invalid archive entry");
  archive[156] = 48;
  archive.write("00000077777\0", 124);
  expect(() => archiveText(archive)).toThrow();
});

test("restart enforces deadlines and retention cleans only the owning task", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  const key = taskKey(f.input.workspaceId, f.input.taskId);
  const path = join(f.settings.CODEX_RUNNER_STATE, `${key}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.createdAt = Date.now() - 7200000;
  await writeFile(path, JSON.stringify(record));
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  await restarted.sweep();
  expect(
    (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("cancelled");
  const expired = JSON.parse(await readFile(path, "utf8"));
  expired.finishedAt = Date.now() - 48 * 3600000;
  await writeFile(path, JSON.stringify(expired));
  const cleaner = new RunnerSupervisor(f.settings, f.engine);
  await cleaner.initialize();
  await cleaner.sweep();
  expect(JSON.parse(await readFile(path, "utf8")).cleaned).toBe(true);
  const removed = f.calls
    .filter((c) => c.args[0] === "rm")
    .flatMap((c) => c.args.slice(3));
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every((name) => name.startsWith(key))).toBe(true);
});

test("panel credentials override fallback, survive restart encrypted and never enter jobs", async () => {
  for (const fallback of [undefined, "fallback-secret"]) {
    const f = await fixture();
    f.settings.CODEX_PROVIDER_API_KEY = fallback;
    await f.supervisor.start({ ...f.input, providerApiKey: "panel-secret" });
    const path = join(
      f.settings.CODEX_RUNNER_STATE,
      `${taskKey(f.input.workspaceId, f.input.taskId)}.json`,
    );
    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain("panel-secret");
    expect(JSON.parse(disk).providerApiKey).toBeString();
    expect(JSON.parse(disk).input.providerApiKey).toBeUndefined();
    const restarted = new RunnerSupervisor(f.settings, f.engine);
    await restarted.initialize();
    await restarted.start({ ...f.input, providerApiKey: "duplicate-secret" });
    await restarted.status(f.input.workspaceId, f.input.taskId);
    const taskToken =
      f.calls.find((c) => c.args.at(-1) === "implement")?.env
        ?.CODEX_TASK_TOKEN ?? "";
    expect(restarted.providerKey(taskToken)).toBe("panel-secret");
    expect(() => restarted.providerKey("wrong-token")).toThrow(
      "coding_proxy_denied",
    );
    const authorizations: (string | null)[] = [];
    const app = runnerApp(restarted, (async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response("data: done\n\n");
    }) as typeof fetch);
    expect(
      (
        await app.request("/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${taskToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: f.settings.CODEX_MODEL,
            input: "hello",
          }),
        })
      ).status,
    ).toBe(200);
    expect(authorizations).toEqual(["Bearer panel-secret"]);
    expect(JSON.stringify(f.calls)).not.toContain("panel-secret");
    expect(f.jobInputs.join("\n")).not.toContain("panel-secret");
    if (fallback) await restarted.cancel(f.input.workspaceId, f.input.taskId);
    else
      expect(
        (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
      ).toBe("ready");
    expect(
      JSON.parse(await readFile(path, "utf8")).providerApiKey,
    ).toBeUndefined();
    expect(() => restarted.providerKey(taskToken)).toThrow(
      "coding_proxy_denied",
    );
  }
});

test("missing provider credentials reject start before any container is reserved", async () => {
  const f = await fixture();
  f.settings.CODEX_PROVIDER_API_KEY = "";
  await expect(f.supervisor.start(f.input)).rejects.toThrow(
    "coding_provider_not_configured",
  );
  expect(f.calls).toHaveLength(0);
  await f.supervisor.start({ ...f.input, providerApiKey: "now-configured" });
  expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(1);
});
