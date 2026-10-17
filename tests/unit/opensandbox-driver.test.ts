import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenSandboxDriver } from "../../src/coding/local/opensandbox.ts";
import type { SandboxLaunch } from "../../src/coding/local/sandbox-runtime.ts";
import { runnerSettings } from "../../src/coding/local/settings.ts";

function fixture() {
  const settings = runnerSettings.parse({
    CODEX_CONTAINER_ENGINE: "opensandbox",
    CODEX_RUNNER_TOKEN: randomUUID(),
    CODEX_RUNNER_STATE: "/test/state",
    OPENSANDBOX_URL: "http://localhost:3021",
    OPENSANDBOX_API_KEY: "private-management-key",
  });
  let options: Record<string, unknown> = {};
  let metadata: Record<string, string> = {};
  let entries: {
    id: string;
    metadata: Record<string, string>;
    status: { state: string };
  }[] = [];
  const killed: string[] = [];
  let closed = 0;
  let status: { running?: boolean; exitCode?: number | null; error?: string } =
    { running: false, exitCode: 0 };
  let received: unknown;
  const sandbox = {
    id: "sandbox-id",
    async close() {
      closed++;
    },
    commands: {
      async run(command: string, opts: unknown) {
        received = opts;
        const result = Bun.spawnSync(["bash", "-c", command]);
        return {
          id: "job-id",
          exitCode: result.exitCode,
          logs: { stdout: [{ text: result.stdout.toString() }] },
        };
      },
      async getCommandStatus() {
        return status;
      },
    },
  };
  const sdk = {
    Sandbox: {
      async create(input: Record<string, unknown>) {
        options = input;
        metadata = input.metadata as Record<string, string>;
        entries = [
          { id: "sandbox-id", metadata, status: { state: "Running" } },
        ];
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
    },
    SandboxManager: {
      create() {
        return {
          async close() {
            closed++;
          },
          async listSandboxInfos() {
            return { items: entries };
          },
          async killSandbox(id: string) {
            killed.push(id);
          },
        };
      },
    },
  } as unknown as typeof import("@alibaba-group/opensandbox");
  const driver = new OpenSandboxDriver(settings, async () => sdk);
  const spec: SandboxLaunch = {
    name: `deepx-codex-${"a".repeat(32)}-implement`,
    image: "trusted:local",
    cpus: 2,
    memoryMb: 4096,
    env: { CODEX_TASK_TOKEN: "temporary-task-token" },
    network: true,
    mounts: [
      { source: "/data/task", target: "/task", readOnly: false },
      { source: "/data/input", target: "/input", readOnly: true },
    ],
  };
  return {
    driver,
    spec,
    settings,
    options: () => options,
    closed: () => closed,
    received: () => received,
    killed,
    status: (value: typeof status) => {
      status = value;
    },
    entries: (value: typeof entries) => {
      entries = value;
    },
    metadata: () => metadata,
  };
}

test("OpenSandbox uses Docker-compatible options, read-only inputs and a deny-default policy", async () => {
  const f = fixture();
  await f.driver.create(f.spec);
  expect(f.options().secureAccess).toBe(false);
  expect(f.options().resource).toEqual({ cpu: "2", memory: "4096Mi" });
  expect(f.options().env).toEqual({ CODEX_TASK_TOKEN: "temporary-task-token" });
  const { connectionConfig, ...workload } = f.options();
  expect(connectionConfig).toMatchObject({ apiKey: "private-management-key" });
  expect(JSON.stringify(workload)).not.toContain("private-management-key");
  expect(f.options().volumes).toEqual([
    {
      name: "mount-0",
      host: { path: "/data/task" },
      mountPath: "/task",
      readOnly: false,
    },
    {
      name: "mount-1",
      host: { path: "/data/input" },
      mountPath: "/input",
      readOnly: true,
    },
  ]);
  expect(f.options().networkPolicy).toMatchObject({ defaultAction: "deny" });
  await f.driver.create({ ...f.spec, network: false });
  expect(f.options().networkPolicy).toEqual({
    defaultAction: "deny",
    egress: [],
  });
  expect(f.closed()).toBe(2);
});

test("the pinned execd receives shell form with literal arguments and unprivileged execution", async () => {
  const f = fixture();
  const literal = "spaces 'quotes' $(printf injected) ; false";
  const output = await f.driver.run(
    "sandbox-id",
    ["node", "-e", "process.stdout.write(process.argv[1])", literal],
    true,
  );
  expect(output.stdout).toBe(literal);
  expect(output.exitCode).toBe(0);
  expect(f.received()).toEqual({ background: false, uid: 1000, gid: 1000 });
  await f.driver.run("sandbox-id", ["node", "-e", ""], false);
  expect(f.received()).toEqual({ background: true, uid: 1000, gid: 1000 });
  expect(f.closed()).toBe(2);
});

test("missing or uncertain command status cannot pass verification", async () => {
  const f = fixture();
  for (const status of [
    { running: false },
    { running: false, exitCode: null },
    { running: true, error: "unavailable" },
    {},
  ]) {
    f.status(status);
    await expect(
      f.driver.inspect("sandbox-id", "job-id"),
    ).rejects.toMatchObject({ code: "coding_outcome_unknown" });
  }
  f.status({ running: false, exitCode: 7, error: "exit status 7" });
  expect(await f.driver.inspect("sandbox-id", "job-id")).toEqual({
    Running: false,
    Status: "exited",
    ExitCode: 7,
  });
  expect(f.closed()).toBe(5);
});

test("cleanup verifies ownership even when a remote metadata filter returns another tenant", async () => {
  const f = fixture();
  await f.driver.create(f.spec);
  f.entries([
    {
      id: "sandbox-id",
      metadata: { ...f.metadata(), "repodesk-owner": "another-tenant" },
      status: { state: "Running" },
    },
  ]);
  await expect(
    f.driver.destroy(f.spec.name, "sandbox-id"),
  ).rejects.toMatchObject({ code: "coding_sandbox_identity_invalid" });
  expect(f.killed).toEqual([]);
  f.entries([
    {
      id: "replacement-id",
      metadata: f.metadata(),
      status: { state: "Running" },
    },
  ]);
  await expect(f.driver.destroy(f.spec.name, "sandbox-id")).rejects.toThrow();
  expect(f.killed).toEqual([]);
  f.entries([
    { id: "sandbox-id", metadata: f.metadata(), status: { state: "Running" } },
  ]);
  await f.driver.destroy(f.spec.name); // Recover a lost create response by its owned phase metadata.
  expect(f.killed).toEqual(["sandbox-id"]);
});

test("secure-access settings round trip and IP-literal proxies fail before a sandbox starts", () => {
  const f = fixture();
  expect(runnerSettings.parse(f.settings).OPENSANDBOX_SECURE_ACCESS).toBe(
    false,
  );
  expect(
    runnerSettings.parse({ ...f.settings, OPENSANDBOX_SECURE_ACCESS: "true" })
      .OPENSANDBOX_SECURE_ACCESS,
  ).toBe(true);
  expect(
    () =>
      new OpenSandboxDriver({
        ...f.settings,
        CODEX_RUNNER_PROXY_URL: "http://127.0.0.1:3020",
      }),
  ).toThrow();
});
