// Deterministic real-Podman smoke: fake Codex + local Git fixture, no remote calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { taskKey } from "../src/coding/local/supervisor.ts";

const exec = promisify(execFile);
const podman = async (args: string[]) =>
  (
    await exec("podman", args, { timeout: 120000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const suffix = randomUUID().slice(0, 8);
const name = `deepx-codex-smoke-${suffix}`;
const dir = await mkdtemp(join(tmpdir(), `${name}-`));
const image = `localhost/${name}:local`;
const workspaceId = randomUUID();
const taskId = randomUUID();
const key = taskKey(workspaceId, taskId);
const failedTaskId = randomUUID();
const failedKey = taskKey(workspaceId, failedTaskId);
const token = "smoke-management-token-no-real-secrets";
try {
  await writeFile(
    join(dir, "Dockerfile"),
    `FROM ${process.env.CODEX_SMOKE_JOB_IMAGE ?? "localhost/deepx-codex-job:verify"}\nUSER root\nRUN rm /usr/local/bin/codex\nCOPY --chmod=755 codex /usr/local/bin/codex\nCOPY --chmod=755 git /usr/local/bin/git\nUSER node\n`,
  );
  await writeFile(
    join(dir, "git"),
    `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('clone')) {
 const git=a=>execFileSync('/usr/bin/git',a,{cwd:'/task',stdio:'ignore'});
 git(['init','--initial-branch=develop','/task/repo']);
 writeFileSync('/task/repo/README.md','old\\n');
 git(['-C','/task/repo','add','README.md']);
 git(['-C','/task/repo','-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-m','fixture']);
} else execFileSync('/usr/bin/git',args,{stdio:'inherit'});
`,
  );
  await writeFile(
    join(dir, "codex"),
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.env.GITHUB_TOKEN||process.env.CODEX_PROVIDER_API_KEY) process.exit(2);
if(fs.existsSync('/run/podman/podman.sock')) process.exit(3);
fs.writeFileSync('/task/repo/README.md','fixed\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-thread'}));
`,
  );
  await podman(["build", "--format=docker", "-t", image, dir]);
  await podman(["network", "create", name]);
  const socket = await podman([
    "info",
    "--format",
    "{{.Host.RemoteSocket.Path}}",
  ]);
  await podman([
    "run",
    "-d",
    "--name",
    name,
    "--pull=never",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--security-opt=label=disable",
    "--tmpfs=/tmp",
    "--tmpfs=/run",
    "--network",
    name,
    "--network-alias=codex-runner",
    "-p",
    "127.0.0.1::3020",
    "-v",
    `${socket}:/run/podman/podman.sock`,
    "-v",
    `${name}-state:/var/lib/deepx-codex`,
    "-e",
    `CODEX_RUNNER_TOKEN=${token}`,
    "-e",
    "CODEX_PROVIDER_BASE_URL=https://example.invalid/v1",
    "-e",
    `CODEX_RUNNER_NETWORK=${name}`,
    "-e",
    `CODEX_RUNNER_IMAGE=${image}`,
    "-e",
    "CODEX_RUNNER_TIMEOUT_SECONDS=120",
    process.env.CODEX_SMOKE_SUPERVISOR_IMAGE ??
      "localhost/deepx-codex-supervisor:verify",
  ]);
  const port = await podman(["port", name, "3020"]);
  const base = `http://${port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw new Error(
        `Smoke endpoint ${path}: ${response.status} ${await response.text()}`,
      );
    return response.json();
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await request("/healthz");
      break;
    } catch {
      if (attempt > 20) throw new Error("Supervisor did not become healthy");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const input = {
    workspaceId,
    taskId,
    payload: {
      repositoryId: 1,
      repository: "example/smoke",
      installationId: 1,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "develop",
      workflowFile: "unused.yml",
      title: "Smoke",
      body: "Change old to fixed",
      backend: "podman",
      checkCommand: 'test "$(cat README.md)" = fixed',
    },
    issue: { number: 1, url: "https://github.com/example/smoke/issues/1" },
    readToken: "fake-read-token",
    providerApiKey: "fake-panel-provider-key",
  };
  await request("/tasks", input);
  for (let attempt = 0; ; attempt++) {
    const status = (await request(`/tasks/${workspaceId}/${taskId}`)) as {
      state: string;
      threadId?: string;
    };
    if (status.state === "ready") {
      if (status.threadId !== "smoke-thread")
        throw new Error("Thread ID was not preserved");
      break;
    }
    if (
      ["failed", "unknown", "cancelled"].includes(status.state) ||
      attempt > 30
    )
      throw new Error(`Task did not reach ready: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await request(`/tasks/${workspaceId}/${taskId}/cancel`, {});
  await request("/tasks", {
    ...input,
    taskId: failedTaskId,
    payload: { ...input.payload, checkCommand: "false" },
  });
  for (let attempt = 0; ; attempt++) {
    const status = (await request(`/tasks/${workspaceId}/${failedTaskId}`)) as {
      state: string;
      error?: string;
      threadId?: string;
    };
    if (status.state === "failed") {
      if (
        status.error !== "coding_check_failed" ||
        status.threadId !== "smoke-thread"
      )
        throw new Error(
          `Failure diagnostics were lost: ${JSON.stringify(status)}`,
        );
      break;
    }
    if (attempt > 30)
      throw new Error(`Task did not fail its check: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(
    "Podman smoke passed: successful patch export and failed checks both preserve thread IDs; cancellation confirmed.",
  );
} catch (error) {
  for (const phase of ["prepare", "implement", "export", "publish"]) {
    const state = await podman([
      "inspect",
      "--format",
      "{{json .State}}",
      `${key}-${phase}`,
    ]).catch(() => "not created");
    console.error(`${phase}: ${state}`);
  }
  console.error(
    await podman(["logs", name]).catch(() => "Supervisor logs unavailable"),
  );
  throw error;
} finally {
  await podman([
    "rm",
    "--force",
    "--ignore",
    name,
    ...["prepare", "implement", "export", "publish"].map(
      (phase) => `${key}-${phase}`,
    ),
    ...["prepare", "implement", "export", "publish"].map(
      (phase) => `${failedKey}-${phase}`,
    ),
  ]).catch(() => {});
  for (const volume of [
    `${name}-state`,
    `${key}-work`,
    `${key}-publish`,
    `${failedKey}-work`,
    `${failedKey}-publish`,
  ])
    await podman(["volume", "rm", "--force", volume]).catch(() => {});
  await podman(["network", "rm", name]).catch(() => {});
  await podman(["rmi", image]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
