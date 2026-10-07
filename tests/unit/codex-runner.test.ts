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

test("task media survives runner restart and is scrubbed with task erasure", async () => {
  const f = await fixture();
  f.input.issue = undefined;
  const media = {
    images: [
      {
        type: "image" as const,
        mimeType: "image/png" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwEEQAwAG/ID/U0/Ov8AAAAASUVORK5CYII=",
      },
    ],
    prompt: "Attachment reference data from the authenticated request.",
  };
  f.input.development = {
    taskId: randomUUID(),
    revision: 1,
    mode: "intake",
    context: "",
    media,
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "source",
        text: "Match the screenshot",
        kind: "request",
        hasAttachments: true,
      },
    ],
  };
  await f.supervisor.start(f.input);
  expect(JSON.parse(f.jobInputs[0] ?? "{}").development.media).toEqual(media);
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  await restarted.start(f.input);
  expect(f.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
  await restarted.erase(f.input.workspaceId, f.input.taskId);
  const state = await readFile(
    join(
      f.settings.CODEX_RUNNER_STATE,
      `${taskKey(f.input.workspaceId, f.input.taskId)}.json`,
    ),
    "utf8",
  );
  expect(state).not.toContain(media.images[0]?.data ?? "");
  expect(JSON.parse(state).input.development).toBeUndefined();
  const g = await fixture();
  g.input.issue = undefined;
  g.input.development = f.input.development;
  await g.supervisor.start(g.input);
  const path = join(
    g.settings.CODEX_RUNNER_STATE,
    `${taskKey(g.input.workspaceId, g.input.taskId)}.json`,
  );
  const expired = JSON.parse(await readFile(path, "utf8"));
  expired.state = "succeeded";
  expired.finishedAt = Date.now() - 48 * 3600000;
  await writeFile(path, JSON.stringify(expired));
  const cleaner = new RunnerSupervisor(g.settings, g.engine);
  await cleaner.initialize();
  await cleaner.sweep();
  const tombstone = await readFile(path, "utf8");
  expect(tombstone).not.toContain(media.images[0]?.data ?? "");
  expect(JSON.parse(tombstone).input.development.media).toBeUndefined();
  await new RunnerSupervisor(g.settings, g.engine).initialize();
});
async function fixture(concurrency = 4) {
  const dir = await mkdtemp(join(tmpdir(), "deepx-codex-test-"));
  dirs.push(dir);
  const settings = runnerSettings.parse({
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_CONCURRENCY: concurrency,
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
        : path.endsWith("verification.json")
          ? JSON.stringify(["bun test"])
          : path.endsWith("thread-id")
            ? "thread-123"
            : path.endsWith("failure-code")
              ? "coding_check_failed"
              : JSON.stringify({
                  prUrl: "https://github.com/example/repo/pull/43",
                });
    },
    async command(args, env) {
      calls.push({ args, env });
      if (args[0] === "cp" && args[1]?.endsWith(".input"))
        jobInputs.push(await readFile(args[1], "utf8"));
      if (args[0] === "volume" && args[1] === "ls")
        return args.at(-1)?.replace(/^name=/, "") ?? "";
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
      title: "Fix bug",
      body: "Fix the bug",
      backend: "podman",
      authMode: "provider_key",
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
  const f = await fixture(1);
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
function holdImplementations(f: Awaited<ReturnType<typeof fixture>>) {
  const completed = new Set<string>();
  const authCopies = new Map<string, string>();
  const command = f.engine.command;
  const read = f.engine.readText;
  f.engine.command = async (args, env) => {
    const name = args.at(-1) ?? "";
    if (
      args[0] === "inspect" &&
      name.endsWith("-implement") &&
      !completed.has(name)
    )
      return JSON.stringify({ Running: true, Status: "running", ExitCode: 0 });
    if (args[0] === "cp" && args[1] && name.endsWith(":/auth/auth.json"))
      authCopies.set(name.split(":")[0] ?? "", await readFile(args[1], "utf8"));
    return command(args, env);
  };
  f.engine.readText = async (container, path, max) =>
    path === "/auth/auth.json"
      ? JSON.stringify({ tokens: { access_token: `rotated-${container}` } })
      : read(container, path, max);
  return { completed, authCopies };
}

test("parallel starts respect global capacity, remain idempotent at capacity and recover after restart", async () => {
  const f = await fixture();
  holdImplementations(f);
  const inputs = Array.from({ length: 5 }, (_, n) => ({
    ...f.input,
    workspaceId: n === 2 ? randomUUID() : f.input.workspaceId,
    taskId: randomUUID(),
    payload: {
      ...f.input.payload,
      repositoryId: n + 1,
      repository: `example/repo${n}`,
    },
  }));
  const starts = await Promise.allSettled(
    inputs.map((input) => f.supervisor.start(input)),
  );
  expect(starts.filter((r) => r.status === "fulfilled")).toHaveLength(4);
  expect(starts[4]).toMatchObject({
    status: "rejected",
    reason: { code: "coding_runner_busy", status: 429 },
  });
  const active = inputs.slice(0, 4);
  for (const input of active) {
    await f.supervisor.start(input);
    await f.supervisor.status(input.workspaceId, input.taskId);
    expect(
      await f.supervisor.status(input.workspaceId, input.taskId),
    ).toMatchObject({ state: "running", phase: "implement" });
  }
  expect(
    f.calls.filter(
      (c) =>
        c.args[0] === "create" &&
        c.args.some((arg) => arg.endsWith("-implement")),
    ),
  ).toHaveLength(4);
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  const [first, second] = active;
  const overflow = inputs[4];
  if (!first || !second || !overflow)
    throw Error("Missing concurrency fixture");
  await restarted.start(first);
  await expect(restarted.start(overflow)).rejects.toThrow("coding_runner_busy");
  await expect(restarted.cancel(randomUUID(), first.taskId)).rejects.toThrow(
    "coding_task_not_found",
  );
  await restarted.cancel(first.workspaceId, first.taskId);
  await restarted.start(overflow);
  expect(
    await restarted.status(second.workspaceId, second.taskId),
  ).toMatchObject({ state: "running", phase: "implement" });
});

test("a continuing task keeps one active attempt while independent tasks share the runner", async () => {
  const f = await fixture();
  const input: LocalStart = {
    ...f.input,
    issue: undefined,
    development: {
      taskId: randomUUID(),
      revision: 1,
      mode: "work",
      context: "",
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "source",
          text: "Fix pagination",
          kind: "request",
        },
      ],
    },
  };
  await f.supervisor.start(input);
  await expect(
    f.supervisor.start({ ...input, taskId: randomUUID() }),
  ).rejects.toThrow("coding_runner_busy");
  await f.supervisor.start({
    ...input,
    taskId: randomUUID(),
    workspaceId: randomUUID(),
  });
  await f.supervisor.start({ ...f.input, taskId: randomUUID() });
  expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(3);
});

test("shared account implementations serialize while preparation, checks and other credentials run in parallel", async () => {
  const f = await fixture();
  const { completed, authCopies } = holdImplementations(f);
  const first: LocalStart = {
    ...f.input,
    payload: { ...f.input.payload, authMode: "device_code" },
  };
  const second = { ...first, taskId: randomUUID() };
  const independent = {
    ...first,
    workspaceId: randomUUID(),
    taskId: randomUUID(),
  };
  const provider = { ...f.input, taskId: randomUUID() };
  await f.supervisor.device.save(
    first.workspaceId,
    '{"tokens":{"access_token":"workspace-one"}}',
  );
  await f.supervisor.device.save(
    independent.workspaceId,
    '{"tokens":{"access_token":"workspace-two"}}',
  );
  const inputs = [first, second, independent, provider];
  await Promise.all(inputs.map((input) => f.supervisor.start(input)));
  for (const input of inputs)
    await f.supervisor.status(input.workspaceId, input.taskId);
  for (const input of inputs)
    await f.supervisor.status(input.workspaceId, input.taskId);
  const firstName = `${taskKey(first.workspaceId, first.taskId)}-implement`;
  const secondName = `${taskKey(second.workspaceId, second.taskId)}-implement`;
  expect(authCopies.get(firstName)).toContain("workspace-one");
  expect(authCopies.has(secondName)).toBe(false);
  expect(
    authCopies.get(
      `${taskKey(independent.workspaceId, independent.taskId)}-implement`,
    ),
  ).toContain("workspace-two");
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  expect(
    await restarted.status(second.workspaceId, second.taskId),
  ).toMatchObject({ state: "running", phase: "setup" });
  completed.add(firstName);
  expect(await restarted.status(first.workspaceId, first.taskId)).toMatchObject(
    { phase: "check" },
  );
  expect(
    await restarted.status(second.workspaceId, second.taskId),
  ).toMatchObject({ phase: "implement" });
  expect(authCopies.get(secondName)).toContain(`rotated-${firstName}`);
  expect(await restarted.status(first.workspaceId, first.taskId)).toMatchObject(
    { state: "ready" },
  );
  expect(
    await restarted.status(independent.workspaceId, independent.taskId),
  ).toMatchObject({ state: "running", phase: "implement" });
  expect(
    await restarted.status(provider.workspaceId, provider.taskId),
  ).toMatchObject({ state: "running", phase: "implement" });
});

test("auth resume competes for its account stream even when global slots remain", async () => {
  const f = await authPausedFixture();
  const { completed } = holdImplementations(f);
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"reconnected"}}',
  );
  const other: LocalStart = {
    ...f.input,
    taskId: randomUUID(),
    issue: { number: 43, url: "https://github.com/example/repo/issues/43" },
    development: undefined,
  };
  await f.supervisor.start(other);
  await f.supervisor.status(other.workspaceId, other.taskId);
  await f.supervisor.status(other.workspaceId, other.taskId);
  await expect(
    f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
  ).rejects.toThrow("coding_runner_busy");
  f.allow();
  completed.add(`${taskKey(other.workspaceId, other.taskId)}-implement`);
  await f.supervisor.status(other.workspaceId, other.taskId);
  await Promise.all([
    f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
    f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
  ]);
  expect(
    await f.supervisor.status(f.input.workspaceId, f.input.taskId),
  ).toMatchObject({ state: "running", phase: "implement" });
  expect(
    f.calls.filter(
      (c) =>
        c.args[0] === "create" &&
        c.args.includes(
          `${taskKey(f.input.workspaceId, f.input.taskId)}-implement`,
        ),
    ),
  ).toHaveLength(2);
});

test("device check repairs wait for the account stream without consuming repair attempts", async () => {
  const f = await fixture();
  const { completed, authCopies } = holdImplementations(f);
  f.input.payload.authMode = "device_code";
  f.input.issue = undefined;
  f.input.development = {
    taskId: randomUUID(),
    revision: 1,
    mode: "work",
    context: "",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "source",
        text: "Fix pagination",
        kind: "request",
      },
    ],
  };
  const read = f.engine.readText,
    command = f.engine.command;
  f.engine.readText = async (container, path, max) =>
    path.endsWith("conversation.json")
      ? JSON.stringify({
          threadId: "repair-thread",
          tokens: 10,
          result: {
            status: "completed",
            intent: "implement",
            evidenceRevision: 1,
            evidence: "Fix pagination",
            publishRequested: true,
            summary: "Fixed",
            question: null,
            title: "Pagination",
            body: "Checked",
            verificationCommands: ["bun test"],
          },
        })
      : read(container, path, max);
  f.engine.command = async (args, env) =>
    args[0] === "inspect" && args.at(-1)?.endsWith("-check")
      ? JSON.stringify({ Running: false, Status: "exited", ExitCode: 1 })
      : command(args, env);
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"initial"}}',
  );
  const other: LocalStart = {
    ...f.input,
    taskId: randomUUID(),
    development: undefined,
    issue: { number: 43, url: "https://github.com/example/repo/issues/43" },
  };
  await f.supervisor.start(f.input);
  await f.supervisor.start(other);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const ownName = `${taskKey(f.input.workspaceId, f.input.taskId)}-implement`;
  completed.add(ownName);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(other.workspaceId, other.taskId);
  await f.supervisor.status(other.workspaceId, other.taskId);
  for (let n = 0; n < 2; n++)
    expect(
      await f.supervisor.status(f.input.workspaceId, f.input.taskId),
    ).toMatchObject({ phase: "check", repairCount: undefined });
  expect(
    f.calls.filter((c) => c.args[0] === "create" && c.args.includes(ownName)),
  ).toHaveLength(1);
  await f.supervisor.cancel(other.workspaceId, other.taskId);
  expect(
    await f.supervisor.status(f.input.workspaceId, f.input.taskId),
  ).toMatchObject({ phase: "implement", repairCount: 1 });
  expect(authCopies.get(ownName)).toContain(
    `rotated-${taskKey(other.workspaceId, other.taskId)}-implement`,
  );
  expect(
    f.calls.filter((c) => c.args[0] === "create" && c.args.includes(ownName)),
  ).toHaveLength(2);
});

test("runner concurrency accepts deployment strings and rejects unsafe capacities", async () => {
  const f = await fixture();
  expect(
    runnerSettings.parse({ ...f.settings, CODEX_RUNNER_CONCURRENCY: "8" })
      .CODEX_RUNNER_CONCURRENCY,
  ).toBe(8);
  for (const value of [0, -1, 1.5, 33, "invalid"])
    expect(() =>
      runnerSettings.parse({ ...f.settings, CODEX_RUNNER_CONCURRENCY: value }),
    ).toThrow();
});

test("checks precede publication; publication uses a fresh volume and only its scoped token", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("running");
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
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
test("an interrupted patch export retries without rerunning implementation", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const command = f.engine.command.bind(f.engine);
  let interrupted = true;
  f.engine.command = async (args, env) => {
    if (interrupted && args[0] === "start" && args.includes("--attach")) {
      interrupted = false;
      throw new Error("export interrupted");
    }
    return command(args, env);
  };
  await expect(
    f.supervisor.status(f.input.workspaceId, f.input.taskId),
  ).rejects.toThrow("coding_runner_unavailable");
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  expect(
    (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("ready");
  expect(
    f.calls.filter((c) => c.args[0] === "create" && c.args.at(-1) === "export"),
  ).toHaveLength(2);
  expect(
    f.calls.filter(
      (c) => c.args[0] === "create" && c.args.at(-1) === "implement",
    ),
  ).toHaveLength(1);
});
test("failed checks prevent publishing and cancellation cannot restart a task", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  f.fail();
  expect(
    await f.supervisor.status(f.input.workspaceId, f.input.taskId),
  ).toMatchObject({
    state: "failed",
    error: "coding_check_failed",
    threadId: "thread-123",
  });
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

test("restart preserves old active tasks without a deadline and retention cleans only stopped tasks", async () => {
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
    await restarted.status(f.input.workspaceId, f.input.taskId),
  ).toMatchObject({ state: "running", phase: "implement" });
  expect(f.calls.some((c) => c.args[0] === "stop")).toBe(false);
  await restarted.cancel(f.input.workspaceId, f.input.taskId);
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
    else {
      await restarted.status(f.input.workspaceId, f.input.taskId);
      await restarted.status(f.input.workspaceId, f.input.taskId);
      expect(
        (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
      ).toBe("ready");
    }
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
test("device-auth tasks use only their workspace credential and remove the task auth volume", async () => {
  const f = await fixture();
  f.input.payload.authMode = "device_code";
  await expect(f.supervisor.start(f.input)).rejects.toThrow(
    "coding_device_auth_required",
  );
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"old-secret"}}',
  );
  const readText = f.engine.readText.bind(f.engine);
  f.engine.readText = (container, path, maxBytes) =>
    path === "/auth/auth.json"
      ? Promise.resolve('{"tokens":{"access_token":"refreshed-secret"}}')
      : readText(container, path, maxBytes);
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const key = taskKey(f.input.workspaceId, f.input.taskId);
  const implement = f.calls.find(
    (c) => c.args[0] === "create" && c.args.at(-1) === "implement",
  );
  expect(implement?.args).toContain(`${key}-auth:/auth:U`);
  expect(implement?.env).toEqual({});
  expect(f.jobInputs.at(-1)).not.toContain("old-secret");
  expect(f.jobInputs.at(-1)).not.toContain("refreshed-secret");
  expect(f.jobInputs.at(-1)).not.toContain('env_key = "CODEX_TASK_TOKEN"');
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(await f.supervisor.device.read(f.input.workspaceId)).toContain(
    "refreshed-secret",
  );
  expect(
    f.calls.some((c) =>
      c.args.join(" ").includes(`volume rm --force ${key}-auth`),
    ),
  ).toBe(true);
  const raw = await readFile(
    join(
      f.settings.CODEX_RUNNER_STATE,
      "device-auth",
      f.input.workspaceId,
      "credential.json",
    ),
    "utf8",
  );
  expect(raw).not.toContain("refreshed-secret");
});

test("continuous questions checkpoint and release the runner; tenant-scoped answers reconstruct", async () => {
  const f = await fixture(1);
  const taskId = randomUUID();
  const input = {
    ...f.input,
    issue: undefined,
    development: {
      taskId,
      pr: {
        number: 43,
        url: "https://github.com/example/repo/pull/43",
        branch: `codex/repodesk-${taskId}`,
        headSha: "a".repeat(40),
      },
      revision: 1,
      mode: "work" as const,
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "101:10",
          text: "Fix pagination",
          kind: "request" as const,
        },
      ],
      context: "",
    },
  };
  const originalRead = f.engine.readText;
  let question = true;
  f.engine.readText = async (container, path, max) =>
    path.endsWith("conversation.json")
      ? JSON.stringify({
          threadId: "thread-123",
          tokens: 10,
          result: {
            status: question ? "needs_input" : "completed",
            intent: "implement",
            evidenceRevision: 1,
            evidence: "Fix pagination",
            publishRequested: false,
            summary: "Fixed pagination",
            question: question ? "Keep page one for empty results?" : null,
            title: "Fix pagination",
            body: "Repository checks passed.",
            verificationCommands: ["bun test"],
          },
        })
      : originalRead(container, path, max);
  await f.supervisor.start(input);
  for (let i = 0; i < 3; i++)
    await f.supervisor.status(input.workspaceId, input.taskId);
  expect(
    (await f.supervisor.status(input.workspaceId, input.taskId)).state,
  ).toBe("succeeded");
  const next = {
    ...input,
    taskId: randomUUID(),
    development: {
      ...input.development,
      previousAttemptId: input.taskId,
      revision: 2,
      threadId: "thread-123",
      inputs: [
        ...input.development.inputs,
        {
          revision: 2,
          actor: "101",
          sourceId: "101:11",
          text: "Yes, keep page one",
          kind: "answer" as const,
        },
      ],
    },
  };
  question = false;
  await f.supervisor.start(next);
  expect(
    f.calls.some((c) =>
      c.args.includes(
        `${taskKey(next.workspaceId, next.taskId)}-prepare:/input/checkpoint.patch`,
      ),
    ),
  ).toBe(true);
  for (let i = 0; i < 4; i++)
    await f.supervisor.status(next.workspaceId, next.taskId);
  const ready = await f.supervisor.status(next.workspaceId, next.taskId);
  expect(ready.state).toBe("ready");
  expect(ready.checkPassed).toBe(true);
  expect(ready.tokens).toBe(10);
  await f.supervisor.erase(input.workspaceId, input.taskId);
  const record = await readFile(
    join(
      f.settings.CODEX_RUNNER_STATE,
      `${taskKey(input.workspaceId, input.taskId)}.json`,
    ),
    "utf8",
  );
  expect(record).not.toContain("Fix pagination");
  expect(record).not.toContain("Keep page one");
});

test("failed automatic checks continue repair beyond old quotas with sealed credentials and cumulative usage", async () => {
  const f = await fixture();
  const input = {
    ...f.input,
    providerApiKey: "panel-repair-secret",
    issue: undefined,
    development: {
      taskId: randomUUID(),
      revision: 1,
      mode: "work" as const,
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "101:10",
          text: "Fix pagination",
          kind: "request" as const,
        },
      ],
      context: "",
    },
  };
  const originalRead = f.engine.readText,
    originalCommand = f.engine.command;
  let checks = 0;
  f.engine.readText = async (container, path, max) =>
    path.endsWith("conversation.json")
      ? JSON.stringify({
          threadId: "thread-123",
          tokens: 10,
          result: {
            status: "completed",
            intent: "implement",
            evidenceRevision: 1,
            evidence: "Fix pagination",
            publishRequested: true,
            summary: "Fixed pagination",
            question: null,
            title: "Fix pagination",
            body: "Repository checks passed.",
            verificationCommands: checks ? ["true"] : ["bun test"],
          },
        })
      : originalRead(container, path, max);
  f.engine.command = async (args, env) => {
    if (args[0] === "inspect" && args.at(-1)?.endsWith("-check")) {
      checks++;
      return JSON.stringify({
        Running: false,
        Status: "exited",
        ExitCode: checks <= 4 ? 1 : 0,
      });
    }
    return originalCommand(args, env);
  };
  await f.supervisor.start(input);
  for (let i = 0; i < 12; i++)
    await f.supervisor.status(input.workspaceId, input.taskId);
  const ready = await f.supervisor.status(input.workspaceId, input.taskId);
  expect(ready.state).toBe("ready");
  expect(ready.tokens).toBe(50);
  expect(checks).toBe(5);
  expect(
    f.calls.filter(
      (c) =>
        c.args[0] === "create" &&
        c.args.includes(
          `${taskKey(input.workspaceId, input.taskId)}-implement`,
        ),
    ),
  ).toHaveLength(5);
  const repairedInputs = f.jobInputs
    .map((s) => JSON.parse(s))
    .filter((j) => j.development);
  for (const j of repairedInputs)
    for (const key of ["maxRepairAttempts", "activeSeconds", "maxTokens"])
      expect(j.development).not.toHaveProperty(key);
  expect(JSON.stringify(repairedInputs)).not.toContain(input.providerApiKey);
  const checkInputs = repairedInputs.filter((j) => j.verificationCommands);
  expect(checkInputs.length).toBeGreaterThanOrEqual(2);
  expect(
    checkInputs.every(
      (j) => JSON.stringify(j.verificationCommands) === '["bun test"]',
    ),
  ).toBe(true);
  expect(ready.result?.verificationCommands).toEqual(["bun test"]);
});

test("device continuous result is captured before deleting its credentialed container", async () => {
  const f = await fixture();
  f.input.payload.authMode = "device_code";
  f.input.issue = undefined;
  f.input.development = {
    taskId: randomUUID(),
    revision: 1,
    mode: "work",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "101:10",
        text: "Fix pagination",
        kind: "request",
      },
    ],
    context: "",
  };
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"account-secret"}}',
  );
  const read = f.engine.readText,
    command = f.engine.command;
  let removed = false;
  f.engine.command = async (args, env) => {
    if (
      args[0] === "rm" &&
      args.includes(`${taskKey(f.input.workspaceId, f.input.taskId)}-implement`)
    )
      removed = true;
    return command(args, env);
  };
  f.engine.readText = async (container, path, max) => {
    if (path === "/auth/auth.json")
      return '{"tokens":{"access_token":"account-secret"}}';
    if (path === "/task/conversation.json") {
      if (removed) throw Error("Container already deleted");
      return JSON.stringify({
        threadId: "thread-123",
        tokens: 10,
        result: {
          status: "needs_input",
          intent: "implement",
          evidenceRevision: 1,
          evidence: "Fix pagination",
          publishRequested: false,
          summary: "Question checkpoint",
          question: "Keep page one?",
          title: "Pagination",
          body: "",
        },
      });
    }
    return read(container, path, max);
  };
  await f.supervisor.start(f.input);
  for (let i = 0; i < 3; i++)
    await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const status = await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(status.state).toBe("succeeded");
  expect(status.result?.question).toBe("Keep page one?");
  expect(removed).toBe(true);
});

test("completed work without a valid verification plan cannot become ready", async () => {
  for (const commands of [undefined, []]) {
    const f = await fixture();
    f.input.issue = undefined;
    f.input.development = {
      taskId: randomUUID(),
      revision: 1,
      mode: "work",
      context: "",
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "101:10",
          text: "Fix bug",
          kind: "request",
        },
      ],
    };
    const read = f.engine.readText;
    f.engine.readText = async (container, path, max) =>
      path.endsWith("conversation.json")
        ? JSON.stringify({
            tokens: 10,
            threadId: "thread-123",
            result: {
              status: "completed",
              intent: "implement",
              evidenceRevision: 1,
              evidence: "Fix bug",
              publishRequested: true,
              summary: "Fixed",
              question: null,
              title: "Fix bug",
              body: "",
              verificationCommands: commands,
            },
          })
        : read(container, path, max);
    await f.supervisor.start(f.input);
    for (let i = 0; i < 3; i++)
      await f.supervisor.status(f.input.workspaceId, f.input.taskId);
    const status = await f.supervisor.status(
      f.input.workspaceId,
      f.input.taskId,
    );
    expect(status.state).toBe("failed");
    expect(status.error).toBe("coding_result_invalid");
    expect(status.checkPassed).not.toBe(true);
    expect(
      f.calls.some(
        (c) =>
          c.args[0] === "create" && c.args.some((a) => a.endsWith("-check")),
      ),
    ).toBe(false);
  }
});

async function authPausedFixture(continuous = true, concurrency = 4) {
  const f = await fixture(concurrency);
  f.input.payload.authMode = "device_code";
  if (continuous) {
    f.input.issue = undefined;
    f.input.development = {
      taskId: randomUUID(),
      revision: 1,
      mode: "work",
      context: "",
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "101:10",
          text: "Fix pagination",
          kind: "request",
        },
      ],
    };
  }
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"old-account"}}',
  );
  const read = f.engine.readText,
    command = f.engine.command;
  let denied = true;
  f.engine.readText = async (container, path, max) => {
    if (path === "/auth/auth.json")
      return '{"tokens":{"access_token":"refreshed-account"}}';
    if (path === "/task/failure-code") return "coding_device_auth_required";
    if (path === "/task/auth-failure.json")
      return JSON.stringify({ tokens: 7, threadId: "auth-thread" });
    if (path === "/task/conversation.json")
      return JSON.stringify({
        tokens: 10,
        threadId: "auth-thread",
        result: {
          status: "completed",
          intent: "implement",
          evidenceRevision: 1,
          evidence: "Fix pagination",
          publishRequested: true,
          summary: "Fixed",
          question: null,
          title: "Fix pagination",
          body: "Checked",
          verificationCommands: ["bun test"],
        },
      });
    return read(container, path, max);
  };
  f.engine.command = async (args, env) => {
    if (args[0] === "inspect" && args.at(-1)?.endsWith("-implement"))
      return JSON.stringify({
        Running: false,
        Status: "exited",
        ExitCode: denied ? 1 : 0,
      });
    return command(args, env);
  };
  await f.supervisor.start(f.input);
  for (let n = 0; n < 3; n++)
    await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("auth_required");
  return {
    ...f,
    allow: () => {
      denied = false;
    },
  };
}

test("auth failure releases runner; restart and idempotent resume keep the checkout and cumulative usage", async () => {
  for (const continuous of [true, false]) {
    const f = await authPausedFixture(continuous, 1);
    expect(await f.supervisor.device.status(f.input.workspaceId)).toEqual({
      state: "auth_required",
    });
    await expect(
      f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
    ).rejects.toThrow("coding_device_auth_required");
    const other = {
      ...f.input,
      taskId: randomUUID(),
      payload: { ...f.input.payload, authMode: "provider_key" as const },
    };
    await f.supervisor.start(other);
    await f.supervisor.device.save(
      f.input.workspaceId,
      '{"tokens":{"access_token":"new-account"}}',
    );
    await expect(
      f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
    ).rejects.toThrow("coding_runner_busy");
    await f.supervisor.cancel(other.workspaceId, other.taskId);
    const key = taskKey(f.input.workspaceId, f.input.taskId);
    const path = join(f.settings.CODEX_RUNNER_STATE, `${key}.json`);
    const paused = JSON.parse(await readFile(path, "utf8"));
    paused.createdAt -= 7200000;
    paused.authPausedAt -= 7200000;
    await writeFile(path, JSON.stringify(paused));
    const restarted = new RunnerSupervisor(f.settings, f.engine);
    await restarted.initialize();
    await restarted.sweep();
    expect(
      (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
    ).toBe("auth_required");
    f.allow();
    await Promise.all([
      restarted.resumeAuth(f.input.workspaceId, f.input.taskId),
      restarted.resumeAuth(f.input.workspaceId, f.input.taskId),
    ]);
    expect(
      f.calls.filter(
        (c) => c.args[0] === "create" && c.args.includes(`${key}-implement`),
      ),
    ).toHaveLength(2);
    expect(
      f.calls.filter(
        (c) => c.args[0] === "create" && c.args.includes(`${key}-prepare`),
      ),
    ).toHaveLength(1);
    for (let n = 0; n < 2; n++)
      await restarted.status(f.input.workspaceId, f.input.taskId);
    const ready = await restarted.status(f.input.workspaceId, f.input.taskId);
    expect(ready.state).toBe("ready");
    if (continuous) expect(ready.tokens).toBe(17);
    expect(await restarted.device.read(f.input.workspaceId)).toContain(
      "refreshed-account",
    );
    await expect(
      restarted.resumeAuth(randomUUID(), f.input.taskId),
    ).rejects.toThrow("coding_task_not_found");
  }
});

test("disconnect and retained-checkout expiry prevent automatic auth resume", async () => {
  const f = await authPausedFixture();
  await f.supervisor.logoutDevice(f.input.workspaceId);
  expect(
    (await f.supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("cancelled");
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"new-account"}}',
  );
  await expect(
    f.supervisor.resumeAuth(f.input.workspaceId, f.input.taskId),
  ).rejects.toThrow("coding_task_not_ready");
  const g = await authPausedFixture();
  const path = join(
    g.settings.CODEX_RUNNER_STATE,
    `${taskKey(g.input.workspaceId, g.input.taskId)}.json`,
  );
  const paused = JSON.parse(await readFile(path, "utf8"));
  paused.finishedAt -= 48 * 3600000;
  await writeFile(path, JSON.stringify(paused));
  const restarted = new RunnerSupervisor(g.settings, g.engine);
  await restarted.initialize();
  await restarted.sweep();
  expect(
    await restarted.status(g.input.workspaceId, g.input.taskId),
  ).toMatchObject({ state: "failed", error: "coding_checkpoint_expired" });
  await expect(
    restarted.resumeAuth(g.input.workspaceId, g.input.taskId),
  ).rejects.toThrow("coding_checkpoint_expired");
});

test("cancellation stops Codex before capturing its last rotated credential", async () => {
  const f = await fixture();
  f.input.payload.authMode = "device_code";
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"before-stop"}}',
  );
  let stopped = false;
  const command = f.engine.command,
    read = f.engine.readText;
  f.engine.command = async (args, env) => {
    if (args[0] === "stop") stopped = true;
    return command(args, env);
  };
  f.engine.readText = async (container, path, max) =>
    path === "/auth/auth.json"
      ? JSON.stringify({
          tokens: { access_token: stopped ? "final-rotated" : "before-stop" },
        })
      : read(container, path, max);
  await f.supervisor.start(f.input);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  await f.supervisor.cancel(f.input.workspaceId, f.input.taskId);
  expect(await f.supervisor.device.read(f.input.workspaceId)).toContain(
    "final-rotated",
  );
});

test("safe implementation failures preserve reported usage before temporary account cleanup", async () => {
  const f = await fixture();
  f.input.issue = undefined;
  f.input.payload.authMode = "device_code";
  f.input.development = {
    taskId: randomUUID(),
    revision: 1,
    mode: "work",
    context: "",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "101:10",
        text: "Fix pagination",
        kind: "request",
      },
    ],
  };
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"fixture-account"}}',
  );
  const originalRead = f.engine.readText,
    originalCommand = f.engine.command;
  const events: string[] = [];
  f.engine.readText = async (container, path, max) => {
    if (path === "/auth/auth.json")
      return '{"tokens":{"access_token":"fixture-account"}}';
    if (path === "/task/failure-code") return "coding_provider_usage_limit";
    if (path === "/task/conversation-failure.json") {
      events.push("safe-failure-read");
      return JSON.stringify({
        code: "coding_provider_usage_limit",
        threadId: "thread-123",
        tokens: 654321,
        message: "bearer private-value",
      });
    }
    return originalRead(container, path, max);
  };
  f.engine.command = async (args, env) => {
    if (args[0] === "inspect" && args.at(-1)?.endsWith("-implement"))
      return JSON.stringify({ Running: false, Status: "exited", ExitCode: 1 });
    if (args[0] === "rm" && args.at(-1)?.endsWith("-implement"))
      events.push("credentials-removed");
    return originalCommand(args, env);
  };
  await f.supervisor.start(f.input);
  for (let i = 0; i < 3; i++)
    await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const status = await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(status).toMatchObject({
    state: "failed",
    error: "coding_provider_usage_limit",
    tokens: 654321,
    threadId: "thread-123",
    usageUnknown: false,
  });
  expect(events.indexOf("safe-failure-read")).toBeLessThan(
    events.indexOf("credentials-removed"),
  );
  const record = await readFile(
    join(
      f.settings.CODEX_RUNNER_STATE,
      `${taskKey(f.input.workspaceId, f.input.taskId)}.json`,
    ),
    "utf8",
  );
  expect(record).not.toContain("private-value");
});

test("result-validation diagnostics survive runner restart and are erased with the task", async () => {
  const f = await fixture();
  f.input.issue = undefined;
  f.input.development = {
    taskId: randomUUID(),
    revision: 1,
    mode: "work",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "source",
        text: "Fix bug",
        kind: "request",
      },
    ],
    context: "",
  };
  const read = f.engine.readText,
    command = f.engine.command;
  const issues = [{ path: ["verificationCommands"], code: "custom" }];
  f.engine.readText = async (container, path, max) => {
    if (path === "/task/conversation-failure.json")
      return JSON.stringify({
        code: "coding_result_invalid",
        threadId: "thread-123",
        tokens: 25,
        usageUnknown: true,
        resultIssues: issues,
        message: "private rejected value",
      });
    if (path === "/task/failure-code") return "coding_result_invalid";
    return read(container, path, max);
  };
  f.engine.command = async (args, env) =>
    args[0] === "inspect" && args.at(-1)?.endsWith("-implement")
      ? JSON.stringify({ Running: false, Status: "exited", ExitCode: 1 })
      : command(args, env);
  await f.supervisor.start(f.input);
  for (let i = 0; i < 3; i++)
    await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  const restarted = new RunnerSupervisor(f.settings, f.engine);
  await restarted.initialize();
  expect(
    await restarted.status(f.input.workspaceId, f.input.taskId),
  ).toMatchObject({
    state: "failed",
    error: "coding_result_invalid",
    tokens: 25,
    usageUnknown: true,
    resultIssues: issues,
  });
  const path = join(
    f.settings.CODEX_RUNNER_STATE,
    `${taskKey(f.input.workspaceId, f.input.taskId)}.json`,
  );
  expect(await readFile(path, "utf8")).not.toContain("private rejected");
  await restarted.erase(f.input.workspaceId, f.input.taskId);
  expect(JSON.parse(await readFile(path, "utf8")).resultIssues).toBeUndefined();
});

test("Docker task arguments preserve isolation without Podman-only flags", async () => {
  const f = await fixture();
  const settings = { ...f.settings, CODEX_CONTAINER_ENGINE: "docker" as const };
  const args = containerArgs(
    settings,
    taskKey(f.input.workspaceId, f.input.taskId),
    "work",
    "implement",
    { CODEX_TASK_TOKEN: "temporary-task-token" },
    "task-auth",
  );
  expect(args).toContain("task-auth:/auth");
  expect(args).toContain(
    `${taskKey(f.input.workspaceId, f.input.taskId)}-input:/input:ro`,
  );
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--read-only");
  expect(args).toContain("--user=1000:1000");
  expect(args.some((arg) => arg.startsWith("--timeout="))).toBe(false);
  expect(args).not.toContain("--http-proxy=false");
  expect(args.join(" ")).not.toContain("docker.sock");
  expect(args).not.toContain("temporary-task-token");
});
test("runner readiness requires the task image and network, while liveness remains independent", async () => {
  const f = await fixture();
  const app = runnerApp(f.supervisor);
  expect((await app.request("/readyz")).status).toBe(200);
  expect(
    f.calls.some(
      ({ args }) =>
        args[0] === "image" && args.includes(f.settings.CODEX_RUNNER_IMAGE),
    ),
  ).toBe(true);
  expect(
    f.calls.some(
      ({ args }) =>
        args[0] === "network" && args.includes(f.settings.CODEX_RUNNER_NETWORK),
    ),
  ).toBe(true);
  f.engine.command = async () => {
    throw Error("private engine diagnostics");
  };
  const failed = await app.request("/readyz");
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private engine diagnostics");
  expect((await app.request("/healthz")).status).toBe(200);
});
