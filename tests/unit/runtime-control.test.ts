import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunnerClient } from "../../src/coding/local/client.ts";
import type { LocalStart } from "../../src/coding/local/protocol.ts";
import { runnerApp } from "../../src/coding/local/runner-server.ts";
import { RuntimeSelection } from "../../src/coding/local/runtime-control.ts";
import {
  type RunnerSettings,
  runnerSettings,
} from "../../src/coding/local/settings.ts";
import { RunnerSupervisor } from "../../src/coding/local/supervisor.ts";
import type { TaskRuntime } from "../../src/coding/local/task-runtime.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-runtime-control-"));
  dirs.push(dir);
  const env = runnerSettings.parse({
    CODEX_CONTAINER_ENGINE: "docker",
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_TOKEN: randomUUID(),
    CODEX_PROVIDER_API_KEY: "private-provider",
    CODEX_OPENSANDBOX_IMAGE: "execd-compatible:local",
  });
  const probes: string[] = [];
  let failed = false;
  let probeGate: Promise<void> | undefined;
  let probeEntered = () => {};
  const created: string[] = [];
  const factory = (settings: RunnerSettings): TaskRuntime => ({
    async ready() {
      probes.push(settings.CODEX_CONTAINER_ENGINE);
      probeEntered();
      await probeGate;
      if (failed) throw Error("private endpoint and key");
    },
    async create() {
      created.push(settings.CODEX_CONTAINER_ENGINE);
    },
    async copyFile() {},
    async start() {
      return "";
    },
    async inspect() {
      return { Running: true, Status: "running", ExitCode: 0 };
    },
    async readText() {
      return "";
    },
    async stop() {},
    async remove() {},
    async createVolume() {},
    async listVolumes() {
      return [];
    },
    async removeVolumes() {},
  });
  const supervisor = new RunnerSupervisor({ ...env }, undefined, factory);
  await supervisor.initialize();
  const input: LocalStart = {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    readToken: "private-github",
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
      repositoryId: 7,
      repository: "example/repo",
      installationId: 9,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      backend: "podman",
      authMode: "provider_key",
      title: "Fixture",
      body: "Fixture",
    },
  };
  return {
    dir,
    env,
    supervisor,
    probes,
    factory,
    input,
    created,
    pauseProbe: (gate: Promise<void>, entered: () => void) => {
      probeGate = gate;
      probeEntered = entered;
    },
    fail: () => {
      failed = true;
    },
  };
}

test("environment default, persistent panel selection and reset survive restart", async () => {
  const f = await fixture();
  expect(await f.supervisor.runtimeStatus()).toMatchObject({
    engine: "docker",
    selection: null,
    revision: 0,
    retainedTasks: 0,
  });
  expect(
    await f.supervisor.runtimeSave({ revision: 0, selection: "opensandbox" }),
  ).toMatchObject({
    engine: "opensandbox",
    selection: "opensandbox",
    revision: 1,
  });
  const restarted = new RunnerSupervisor({ ...f.env }, undefined, f.factory);
  await restarted.initialize();
  expect(await restarted.runtimeStatus()).toMatchObject({
    engine: "opensandbox",
    environmentDefault: "docker",
    revision: 1,
  });
  expect(
    await restarted.runtimeSave({ revision: 1, selection: null }),
  ).toMatchObject({ engine: "docker", selection: null, revision: 2 });
  expect((await stat(join(f.dir, "runtime-selection.json"))).mode & 0o777).toBe(
    0o600,
  );
  const saved = await readFile(join(f.dir, "runtime-selection.json"), "utf8");
  expect(JSON.parse(saved)).toEqual({ revision: 2, selection: null });
  expect(saved).not.toContain("private");
});
test("readiness failure leaves live and durable selection unchanged and hides driver details", async () => {
  const f = await fixture();
  f.fail();
  await expect(
    f.supervisor.runtimeSave({ revision: 0, selection: "opensandbox" }),
  ).rejects.toThrow("coding_runtime_unavailable");
  expect(await f.supervisor.runtimeStatus()).toMatchObject({
    engine: "docker",
    revision: 0,
  });
  await expect(
    readFile(join(f.dir, "runtime-selection.json")),
  ).rejects.toThrow();
});
test("retained jobs from any workspace block changing engine until erasure", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  await expect(
    f.supervisor.runtimeSave({ revision: 0, selection: "opensandbox" }),
  ).rejects.toThrow("coding_runtime_in_use");
  expect(f.probes).toEqual([]);
  // Pinning the same effective engine changes no task environment.
  await f.supervisor.runtimeSave({ revision: 0, selection: "docker" });
  expect((await f.supervisor.runtimeStatus()).retainedTasks).toBe(1);
  await f.supervisor.erase(f.input.workspaceId, f.input.taskId);
  expect(
    await f.supervisor.runtimeSave({ revision: 1, selection: "opensandbox" }),
  ).toMatchObject({ engine: "opensandbox", retainedTasks: 0 });
});
test("concurrent saves use revisions and do not replay a successful change", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.supervisor.runtimeSave({ revision: 0, selection: "opensandbox" }),
    f.supervisor.runtimeSave({ revision: 0, selection: "opensandbox" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { message: "coding_runtime_version_conflict" },
  });
  expect(f.probes).toEqual(["opensandbox"]);
});
test("runtime management requires the management credential and reports safe client errors", async () => {
  const f = await fixture();
  const app = runnerApp(f.supervisor);
  expect((await app.request("/runtime")).status).toBe(401);
  expect(
    (
      await app.request("/runtime", {
        method: "POST",
        body: JSON.stringify({ revision: 0, selection: "opensandbox" }),
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(401);
  const client = new LocalRunnerClient(
    "http://runner",
    f.env.CODEX_RUNNER_TOKEN,
    ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
  );
  expect((await client.runtimeStatus()).engine).toBe("docker");
  await client.runtimeSave({ revision: 0, selection: "opensandbox" });
  await expect(
    client.runtimeSave({ revision: 0, selection: null }),
  ).rejects.toThrow("coding_runtime_version_conflict");
  f.fail();
  await expect(
    client.runtimeSave({ revision: 1, selection: "docker" }),
  ).rejects.toThrow("coding_runtime_unavailable");
  const response = await app.request("/runtime", {
    headers: { authorization: `Bearer ${f.env.CODEX_RUNNER_TOKEN}` },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("private");
});
test("corrupt, oversized or symlinked runtime metadata fails closed", async () => {
  for (const mode of ["corrupt", "oversized", "symlink"] as const) {
    const f = await fixture();
    const path = join(f.dir, "runtime-selection.json");
    if (mode === "symlink") {
      const target = join(f.dir, "outside.json");
      await writeFile(target, '{"revision":1,"selection":"opensandbox"}');
      await symlink(target, path);
    } else await writeFile(path, mode === "corrupt" ? "{}" : " ".repeat(5000));
    await expect(new RuntimeSelection(f.env).initialize()).rejects.toThrow(
      "coding_runtime_state_invalid",
    );
  }
});
test("alternate host profiles preserve defaults, socket overrides and separate storage", async () => {
  const f = await fixture();
  const settings = {
    ...f.env,
    CODEX_OPENSANDBOX_IMAGE: undefined,
    CONTAINER_HOST: "unix:///trusted-default.sock",
    CODEX_SANDBOX_ROOT: "/private/sandboxes",
    CODEX_SANDBOX_HOST_ROOT: "/host/sandboxes",
  };
  const selection = new RuntimeSelection(settings);
  expect(selection.settings(null).CONTAINER_HOST).toBe(
    "unix:///trusted-default.sock",
  );
  expect(() => selection.settings("opensandbox")).toThrow(
    "coding_runtime_not_configured",
  );
  const prepared = new RuntimeSelection({
    ...settings,
    CODEX_OPENSANDBOX_IMAGE: "execd:local",
    CODEX_DOCKER_HOST: "unix:///docker-custom.sock",
  });
  expect(prepared.settings("docker").CONTAINER_HOST).toBe(
    "unix:///docker-custom.sock",
  );
  expect(prepared.settings("opensandbox").CODEX_SANDBOX_ROOT).toBe(
    "/private/sandboxes/opensandbox",
  );
});

test("task starts wait for an in-flight selection probe and use the selected engine", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.pauseProbe(release.promise, entered.resolve);
  const save = f.supervisor.runtimeSave({
    revision: 0,
    selection: "opensandbox",
  });
  await entered.promise;
  const start = f.supervisor.start(f.input);
  expect(f.created).toEqual([]);
  release.resolve();
  await Promise.all([save, start]);
  expect(f.created).toEqual(["opensandbox"]);
  expect((await f.supervisor.runtimeStatus()).retainedTasks).toBe(1);
});
test("removed runtimes are rejected in environment and saved selections", async () => {
  const f = await fixture();
  for (const removed of ["microsandbox", "podman"]) {
    expect(
      runnerSettings.safeParse({ ...f.env, CODEX_CONTAINER_ENGINE: removed })
        .success,
    ).toBe(false);
    await writeFile(
      join(f.dir, "runtime-selection.json"),
      JSON.stringify({ revision: 1, selection: removed }),
    );
    await expect(new RuntimeSelection(f.env).initialize()).rejects.toThrow(
      "coding_runtime_state_invalid",
    );
  }
});
test("blank optional Compose profile values retain environment fallbacks", () => {
  const settings = runnerSettings.parse({
    CODEX_RUNNER_TOKEN: randomUUID(),
    CODEX_DOCKER_IMAGE: "",
    CODEX_DOCKER_HOST: "",
    CODEX_SANDBOX_ROOT: "",
    OPENSANDBOX_URL: "",
    OPENSANDBOX_API_KEY: "",
  });
  expect(settings.CODEX_DOCKER_IMAGE).toBeUndefined();
  expect(settings.CODEX_SANDBOX_ROOT).toBeUndefined();
  expect(settings.OPENSANDBOX_URL).toBeUndefined();
  expect(() =>
    runnerSettings.parse({ ...settings, OPENSANDBOX_URL: "not-a-url" }),
  ).toThrow();
});
