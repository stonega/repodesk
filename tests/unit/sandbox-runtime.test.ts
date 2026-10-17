import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchmarkOptions,
  distribution,
} from "../../scripts/sandbox-benchmark.ts";
import type { LocalStart } from "../../src/coding/local/protocol.ts";
import { taskRuntime } from "../../src/coding/local/runtime-factory.ts";
import {
  type SandboxDriver,
  type SandboxLaunch,
  SandboxTaskRuntime,
} from "../../src/coding/local/sandbox-runtime.ts";
import { runnerSettings } from "../../src/coding/local/settings.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "repodesk-sandbox-test-"));
  dirs.push(dir);
  const settings = runnerSettings.parse({
    CODEX_CONTAINER_ENGINE: "opensandbox",
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_TOKEN: randomUUID(),
    CODEX_PROVIDER_API_KEY: "private-provider-key",
    CODEX_RUNNER_IMAGE: "trusted:local",
  });
  const launches: SandboxLaunch[] = [];
  const active = new Map<string, SandboxLaunch>();
  const destroyed: string[] = [];
  let destroyFails = false;
  let createFails = false;
  let runFails = false;
  const driver: SandboxDriver = {
    async ready() {},
    async create(spec) {
      launches.push(spec);
      active.set(spec.name, spec);
      if (createFails) throw Error("Lost create response");
      return spec.name;
    },
    async run(id, _command, attach) {
      if (runFails) throw Error("Lost launch response");
      const spec = active.get(id);
      if (!spec) throw Error("Missing sandbox");
      const volume = spec.mounts.find((m) => m.target === "/task")?.source;
      if (!volume) throw Error("Missing task storage");
      if (id.endsWith("-prepare"))
        await writeFile(join(volume, "base-sha"), "a".repeat(40));
      if (id.endsWith("-implement")) {
        await writeFile(
          join(volume, "conversation.json"),
          JSON.stringify({
            threadId: "thread-123",
            tokens: 10,
            result: {
              status: "completed",
              intent: "implement",
              evidenceRevision: 1,
              evidence: "Fix bug",
              publishRequested: true,
              summary: "Fixed",
              question: null,
              title: "Fix",
              body: "Checked",
              verificationCommands: ["bun test"],
            },
          }),
        );
        const auth = spec.mounts.find((m) => m.target === "/auth");
        if (auth)
          await writeFile(
            join(auth.source, "auth.json"),
            '{"tokens":{"access_token":"rotated-account"}}',
          );
      }
      if (id.endsWith("-publish"))
        await writeFile(
          join(volume, "publication.json"),
          '{"prUrl":"https://github.com/example/repo/pull/1"}',
        );
      return attach
        ? { stdout: '{"patch":"diff --git a/a b/a\\n"}', exitCode: 0 }
        : { jobId: id };
    },
    async inspect() {
      return { Running: false, Status: "exited", ExitCode: 0 };
    },
    async destroy(name) {
      if (destroyFails) throw Error("Offline");
      destroyed.push(name);
      active.delete(name);
    },
  };
  const runtime = new SandboxTaskRuntime(settings, driver);
  const supervisor = new RunnerSupervisor(settings, runtime);
  await supervisor.initialize();
  const input: LocalStart = {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    readToken: "private-read-token",
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
          text: "Fix bug",
          kind: "request",
        },
      ],
    },
    payload: {
      repositoryId: 1,
      repository: "example/repo",
      installationId: 1,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      title: "Fix",
      body: "Fix bug",
      backend: "podman",
      authMode: "provider_key",
    },
  };
  return {
    dir,
    settings,
    driver,
    runtime,
    supervisor,
    input,
    launches,
    active,
    destroyed,
    destroyFails: (value = true) => {
      destroyFails = value;
    },
    createFails: () => {
      createFails = true;
    },
    runFails: () => {
      runFails = true;
    },
  };
}

test("OpenSandbox executes isolated phases, survives restart and fences publication", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  const metadata = await readFile(
    join(
      f.dir,
      "sandbox-runtime",
      `${taskKey(f.input.workspaceId, f.input.taskId)}-prepare.json`,
    ),
    "utf8",
  );
  expect(metadata).not.toContain(f.input.readToken);
  expect(metadata).not.toContain("private-provider-key");
  const supervisor = new RunnerSupervisor(
    f.settings,
    new SandboxTaskRuntime(f.settings, f.driver),
  );
  await supervisor.initialize();
  await supervisor.start(f.input);
  expect(f.launches).toHaveLength(1);
  for (let i = 0; i < 4; i++)
    await supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(
    (await supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("ready");
  expect(f.active.size).toBe(0);
  expect(f.launches.map((s) => s.name.split("-").at(-1))).toEqual([
    "prepare",
    "setup",
    "implement",
    "export",
    "check",
    "export",
  ]);
  for (const phase of f.launches) {
    expect(phase.env).not.toHaveProperty("DATABASE_URL");
    expect(phase.env).not.toHaveProperty("OPENSANDBOX_API_KEY");
    expect(phase.mounts.find((m) => m.target === "/input")?.readOnly).toBe(
      true,
    );
    expect(phase.mounts.some((m) => m.target === "/auth")).toBe(false);
    if (!phase.name.endsWith("-prepare"))
      expect(phase.env).not.toHaveProperty("GITHUB_TOKEN");
    if (!phase.name.endsWith("-implement"))
      expect(phase.env).not.toHaveProperty("CODEX_TASK_TOKEN");
  }
  const exported = f.launches.at(-1);
  expect(exported?.network).toBe(false);
  expect(exported?.mounts.find((m) => m.target === "/task")?.readOnly).toBe(
    true,
  );
  await supervisor.publish(
    f.input.workspaceId,
    f.input.taskId,
    "private-publish-token",
  );
  expect(
    (await supervisor.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("succeeded");
  const publication = f.launches.at(-1);
  expect(publication?.env.GITHUB_TOKEN).toBe("private-publish-token");
  expect(publication?.env).not.toHaveProperty("CODEX_TASK_TOKEN");
  expect(
    publication?.mounts.find((m) => m.target === "/task")?.source,
  ).not.toBe(f.launches[0]?.mounts[0]?.source);
  await supervisor.erase(f.input.workspaceId, f.input.taskId);
  expect(
    await f.runtime.listVolumes(taskKey(f.input.workspaceId, f.input.taskId)),
  ).toEqual([]);
  expect(await readdir(join(f.dir, "sandbox-runtime"))).toEqual([]);
});

test("account credentials exist only in implementation storage and rotation is captured before cleanup", async () => {
  const f = await fixture();
  f.input.payload.authMode = "device_code";
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"initial-account"}}',
  );
  await f.supervisor.start(f.input);
  for (let i = 0; i < 4; i++)
    await f.supervisor.status(f.input.workspaceId, f.input.taskId);
  expect(await f.supervisor.device.read(f.input.workspaceId)).toContain(
    "rotated-account",
  );
  expect(
    f.launches
      .filter((s) => s.mounts.some((m) => m.target === "/auth"))
      .map((s) => s.name.split("-").at(-1)),
  ).toEqual(["implement"]);
  expect(
    await f.runtime.listVolumes(
      `${taskKey(f.input.workspaceId, f.input.taskId)}-auth`,
    ),
  ).toEqual([]);
});

for (const failure of ["create", "run"] as const)
  test(`uncertain ${failure} is never replayed and erasure recovers the original identity`, async () => {
    const f = await fixture();
    if (failure === "create") f.createFails();
    else f.runFails();
    await expect(f.supervisor.start(f.input)).rejects.toMatchObject({
      code: "coding_outcome_unknown",
    });
    const restarted = new RunnerSupervisor(
      f.settings,
      new SandboxTaskRuntime(f.settings, f.driver),
    );
    await restarted.initialize();
    await restarted.start(f.input);
    expect(f.launches).toHaveLength(1);
    expect(
      (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
    ).toBe("unknown");
    await restarted.erase(f.input.workspaceId, f.input.taskId);
    expect(f.active.size).toBe(0);
  });

test("failed cleanup retains storage and erasure can retry after restart", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  f.destroyFails();
  await expect(
    f.supervisor.erase(f.input.workspaceId, f.input.taskId),
  ).rejects.toThrow();
  expect(
    await f.runtime.listVolumes(taskKey(f.input.workspaceId, f.input.taskId)),
  ).toHaveLength(1);
  f.destroyFails(false);
  const restarted = new RunnerSupervisor(
    f.settings,
    new SandboxTaskRuntime(f.settings, f.driver),
  );
  await restarted.initialize();
  await restarted.erase(f.input.workspaceId, f.input.taskId);
  expect(
    await f.runtime.listVolumes(taskKey(f.input.workspaceId, f.input.taskId)),
  ).toEqual([]);
});

test("sandbox artifacts reject traversal, symlinks, oversized files and writes after start", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  const name = f.launches[0]?.name ?? "";
  const volume = f.launches[0]?.mounts[0]?.source ?? "";
  await expect(f.runtime.readText(name, "/task/../private")).rejects.toThrow();
  await writeFile(join(volume, "large"), "x".repeat(20));
  await expect(f.runtime.readText(name, "/task/large", 10)).rejects.toThrow();
  const secret = join(f.dir, "secret");
  await writeFile(secret, "private");
  await symlink(secret, join(volume, "link"));
  await expect(f.runtime.readText(name, "/task/link")).rejects.toThrow();
  await expect(
    f.runtime.copyFile(secret, name, "/input/job.json"),
  ).rejects.toMatchObject({ code: "coding_input_denied" });
});

test("task storage cannot be substituted with another tenant's volume", async () => {
  const f = await fixture();
  const key = taskKey(f.input.workspaceId, f.input.taskId);
  await expect(
    f.runtime.create({
      name: `${key}-prepare`,
      volume: `${taskKey(randomUUID(), randomUUID())}-work`,
      mode: "prepare",
      env: {},
    }),
  ).rejects.toMatchObject({ code: "coding_job_invalid" });
  await expect(f.runtime.removeVolumes(["../../private"])).rejects.toThrow();
});

test("retained tasks refuse a backend change rather than replaying or deleting the wrong sandbox", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  const settings = {
    ...f.settings,
    CODEX_CONTAINER_ENGINE: "docker" as const,
  };
  await expect(
    new RunnerSupervisor(
      settings,
      new SandboxTaskRuntime(settings, f.driver),
    ).initialize(),
  ).rejects.toMatchObject({ code: "coding_runtime_mismatch" });
  expect(f.launches).toHaveLength(1);
});

test("factory requires explicit OpenSandbox management configuration", () => {
  expect(() =>
    taskRuntime(
      runnerSettings.parse({
        CODEX_CONTAINER_ENGINE: "opensandbox",
        CODEX_RUNNER_TOKEN: randomUUID(),
      }),
    ),
  ).toThrow();
  expect(
    runnerSettings.safeParse({
      CODEX_RUNNER_TOKEN: randomUUID(),
      CODEX_SANDBOX_ROOT: "relative",
    }).success,
  ).toBe(false);
});

test("benchmark percentiles use complete samples and reject unsafe workload settings", () => {
  expect(distribution([40, 10, 30, 20])).toEqual({
    count: 4,
    p50: 20,
    p95: 40,
    min: 10,
    max: 40,
  });
  expect(distribution([]).p50).toBe(null);
  expect(
    benchmarkOptions.safeParse({
      engines: ["docker"],
      image: "production:latest",
      iterations: 1,
      concurrency: 1,
      pollMs: 25,
      timeoutMs: 1000,
      root: "/tmp",
      output: "/tmp/result",
    }).success,
  ).toBe(false);
});
