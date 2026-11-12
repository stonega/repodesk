import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeDriver } from "../../src/coding/local/native-driver.ts";
import {
  nativeIdentity,
  stopNativeProcess,
} from "../../src/coding/local/native-process.ts";
import type { LocalStart } from "../../src/coding/local/protocol.ts";
import { SandboxTaskRuntime } from "../../src/coding/local/sandbox-runtime.ts";
import {
  codexConfig,
  runnerSettings,
} from "../../src/coding/local/settings.ts";
import {
  RunnerSupervisor,
  taskKey,
} from "../../src/coding/local/supervisor.ts";

const dirs: string[] = [];
const supervisors: RunnerSupervisor[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.sweep().catch(() => {});
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture(hang = false) {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-native-"));
  dirs.push(dir);
  const phase = join(dir, "phase.mjs"),
    job = join(dir, "job.mjs"),
    binary = join(dir, "codex");
  const build = await Bun.build({
    entrypoints: ["src/coding/local/native-phase.ts"],
    target: "node",
    outdir: dir,
    naming: "phase.mjs",
  });
  expect(build.success).toBe(true);
  await writeFile(binary, "#!/bin/sh\nprintf 'codex-cli 0.155.1\\n'\n");
  await chmod(binary, 0o700);
  await writeFile(
    job,
    `
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const e=process.env, root=e.REPODESK_TASK_ROOT, mode=process.argv[2];
if(e.DATABASE_URL || e.CODEX_RUNNER_TOKEN || e.OPENAI_API_KEY) process.exit(9);
if(mode !== 'prepare' && mode !== 'publish' && e.GITHUB_TOKEN) process.exit(10);
if(mode !== 'implement' && e.CODEX_TASK_TOKEN) process.exit(11);
if(mode==='export') { process.stdout.write(JSON.stringify({patch:'diff --git a/a b/a\\n'})); }
else {
 const job=JSON.parse(await readFile(e.REPODESK_INPUT_ROOT+'/job.json','utf8'));
 await writeFile(root+'/phase-'+mode,JSON.stringify({home:e.HOME,mode,binary:e.REPODESK_CODEX_BIN}));
 if(mode==='prepare') {
   await writeFile(root+'/base-sha','a'.repeat(40));
   ${hang ? "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); await writeFile(root+'/child-pid',String(c.pid)); setInterval(()=>{},1000);" : ""}
 }
 if(mode==='implement') {
   await writeFile(root+'/conversation.json',JSON.stringify({threadId:'thread-native',tokens:10,result:{status:'completed',intent:'implement',evidenceRevision:1,evidence:'Fix bug',publishRequested:true,summary:'Fixed',question:null,title:'Fix',body:'Checked',verificationCommands:['bun test']}}));
   if(job.payload.authMode==='device_code') await writeFile(e.REPODESK_AUTH_ROOT+'/auth.json','{"tokens":{"access_token":"rotated-account"}}');
 }
 if(mode==='publish') await writeFile(root+'/publication.json','{"prUrl":"https://github.com/example/repo/pull/1"}');
}
`,
  );
  const settings = runnerSettings.parse({
    CODEX_CONTAINER_ENGINE: "native",
    CODEX_NATIVE_ENABLED: "true",
    CODEX_NATIVE_CODEX_BIN: binary,
    CODEX_RUNNER_STATE: dir,
    CODEX_RUNNER_TOKEN: randomUUID(),
    CODEX_RUNNER_PROXY_URL: "http://127.0.0.1:3020",
    CODEX_PROVIDER_API_KEY: "private-provider",
  });
  const runtime = () =>
    new SandboxTaskRuntime(
      settings,
      new NativeDriver(settings, { phase, job }),
    );
  const supervisor = new RunnerSupervisor(settings, runtime());
  supervisors.push(supervisor);
  await supervisor.initialize();
  await supervisor.ready();
  const input: LocalStart = {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    readToken: "private-read",
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
    runtime,
    supervisor,
    input,
    root: join(
      dir,
      "native-data",
      "volumes",
      `${taskKey(input.workspaceId, input.taskId)}-work`,
    ),
  };
}
async function until<T>(get: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await get();
    if (done(value)) return value;
    await Bun.sleep(20);
  }
  throw Error("Native fixture timed out");
}

test("native phases preserve supervisor idempotency, restart, verification, publication and erasure", async () => {
  const f = await fixture();
  await f.supervisor.start(f.input);
  const restarted = new RunnerSupervisor(f.settings, f.runtime());
  await restarted.initialize();
  await restarted.start(f.input);
  await until(
    () => restarted.status(f.input.workspaceId, f.input.taskId),
    (s) => s.state === "ready",
  );
  expect(
    (await readdir(f.root)).filter((n) => n.startsWith("phase-")),
  ).toHaveLength(4);
  const metadata = await readFile(
    join(
      f.dir,
      "native-runtime",
      `${taskKey(f.input.workspaceId, f.input.taskId)}-prepare.json`,
    ),
    "utf8",
  );
  expect(metadata).not.toContain("private-read");
  expect(metadata).not.toContain("private-provider");
  await restarted.publish(f.input.workspaceId, f.input.taskId, "private-write");
  const result = await until(
    () => restarted.status(f.input.workspaceId, f.input.taskId),
    (s) => s.state === "succeeded",
  );
  expect(result.prUrl).toBe("https://github.com/example/repo/pull/1");
  await restarted.erase(f.input.workspaceId, f.input.taskId);
  expect(await readdir(join(f.dir, "native-processes"))).toEqual([]);
  expect(
    await f.runtime().listVolumes(taskKey(f.input.workspaceId, f.input.taskId)),
  ).toEqual([]);
}, 25000);

test("native account rotation stays scoped and its plaintext auth directory is removed", async () => {
  const f = await fixture();
  f.input.payload.authMode = "device_code";
  await f.supervisor.device.save(
    f.input.workspaceId,
    '{"tokens":{"access_token":"initial-account"}}',
  );
  await f.supervisor.start(f.input);
  await until(
    () => f.supervisor.status(f.input.workspaceId, f.input.taskId),
    (s) => s.state === "ready",
  );
  expect(await f.supervisor.device.read(f.input.workspaceId)).toContain(
    "rotated-account",
  );
  expect(
    await f
      .runtime()
      .listVolumes(`${taskKey(f.input.workspaceId, f.input.taskId)}-auth`),
  ).toEqual([]);
  await f.supervisor.erase(f.input.workspaceId, f.input.taskId);
}, 25000);

test("native Stop after restart terminates the entire tracked process group", async () => {
  const f = await fixture(true);
  await f.supervisor.start(f.input);
  const child = Number(
    await until(
      () => readFile(join(f.root, "child-pid"), "utf8").catch(() => ""),
      Boolean,
    ),
  );
  const restarted = new RunnerSupervisor(f.settings, f.runtime());
  await restarted.initialize();
  await restarted.cancel(f.input.workspaceId, f.input.taskId);
  await until(async () => {
    try {
      const stat = await readFile(`/proc/${child}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
    } catch {
      return true;
    }
  }, Boolean);
  expect(
    (await restarted.status(f.input.workspaceId, f.input.taskId)).state,
  ).toBe("cancelled");
  await restarted.erase(f.input.workspaceId, f.input.taskId);
});

test("native metadata cannot signal a reused PID and artifact reads reject symlinks", async () => {
  const identity = await nativeIdentity(process.pid);
  await expect(
    stopNativeProcess({ ...identity, start: `${identity.start}0` }),
  ).rejects.toThrow("coding_outcome_unknown");
  const f = await fixture(true);
  await f.supervisor.start(f.input);
  const runtime = f.runtime(),
    key = taskKey(f.input.workspaceId, f.input.taskId);
  await symlink(join(f.dir, "runtime-selection.json"), join(f.root, "link"));
  await expect(
    runtime.readText(`${key}-prepare`, "/task/link"),
  ).rejects.toThrow();
  await expect(
    runtime.readText(`${key}-prepare`, "/task/../outside"),
  ).rejects.toThrow();
  await expect(runtime.removeVolumes(["../../private"])).rejects.toThrow();
  await f.supervisor.erase(f.input.workspaceId, f.input.taskId);
});

test("native execution requires explicit operator enablement and usable CLI files", async () => {
  const settings = runnerSettings.parse({ CODEX_RUNNER_TOKEN: randomUUID() });
  await expect(new NativeDriver(settings).ready()).rejects.toThrow(
    "coding_runtime_not_configured",
  );
  const f = await fixture();
  await expect(
    new NativeDriver(
      { ...f.settings, CODEX_NATIVE_CODEX_BIN: "/nonexistent/codex" },
      { phase: join(f.dir, "phase.mjs"), job: join(f.dir, "job.mjs") },
    ).ready(),
  ).rejects.toThrow();
});

test("the production native job invokes the installed CLI, checks its patch and exports it without remote calls", async () => {
  const f = await fixture();
  const built = await Bun.build({
    entrypoints: ["src/coding/local/job.ts"],
    target: "node",
    outdir: f.dir,
    naming: "job.mjs",
  });
  expect(built.success).toBe(true);
  const server = join(f.dir, "fake-codex.cjs");
  await writeFile(
    server,
    `
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv[2]==='--version') { console.log('codex-cli 0.155.1'); process.exit(0); }
if(process.argv[2]!=='app-server' || !process.env.CODEX_HOME.includes('native-data') || process.env.GITHUB_TOKEN || process.env.CODEX_RUNNER_TOKEN) process.exit(9);
rl.on('line',line=>{
 const m=JSON.parse(line); if(m.id==null)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native-thread'}}});
 if(m.method==='turn/start') {
  fs.writeFileSync('native.txt','Native CLI patch\\n');
  send({id:m.id,result:{turn:{id:'native-turn'}}});
  send({method:'item/completed',params:{threadId:'native-thread',item:{type:'agentMessage',text:JSON.stringify({status:'completed',intent:'implement',evidenceRevision:1,evidence:'Fix bug',publishRequested:true,summary:'Fixed',question:null,title:'Fix',body:'Checked',verificationCommands:['test -f native.txt']})}}});
  send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}}});
 }
});
`,
  );
  await writeFile(
    f.settings.CODEX_NATIVE_CODEX_BIN,
    `#!/bin/sh\nexec /usr/bin/node '${server}' "$@"\n`,
  );
  const runtime = f.runtime(),
    key = taskKey(f.input.workspaceId, f.input.taskId);
  await runtime.create({
    name: `${key}-implement`,
    volume: `${key}-work`,
    mode: "implement",
    env: { CODEX_TASK_TOKEN: "temporary-task-token" },
  });
  const repo = join(f.root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  git("init");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Base",
  );
  const { readToken: _token, ...safe } = f.input;
  const input = join(f.dir, "job-input.json");
  await writeFile(
    input,
    JSON.stringify({
      ...safe,
      baseSha: git("rev-parse", "HEAD"),
      config: codexConfig(f.settings),
      verificationCommands: ["test -f native.txt"],
    }),
  );
  await runtime.copyFile(input, `${key}-implement`, "/input/job.json");
  await runtime.start(`${key}-implement`);
  const implemented = await until(
    () => runtime.inspect(`${key}-implement`),
    (s) => !s.Running,
  );
  expect(implemented.ExitCode).toBe(0);
  expect(
    await runtime.readText(`${key}-implement`, "/task/result.patch"),
  ).toContain("+Native CLI patch");
  await runtime.create({
    name: `${key}-check`,
    volume: `${key}-work`,
    mode: "check",
    env: {},
  });
  await runtime.copyFile(input, `${key}-check`, "/input/job.json");
  await runtime.start(`${key}-check`);
  expect(
    (
      await until(
        () => runtime.inspect(`${key}-check`),
        (s) => !s.Running,
      )
    ).ExitCode,
  ).toBe(0);
  await runtime.create({
    name: `${key}-export`,
    volume: `${key}-work`,
    mode: "export",
    env: {},
  });
  expect(
    JSON.parse(await runtime.start(`${key}-export`, true)).patch,
  ).toContain("+Native CLI patch");
  await runtime.remove([`${key}-implement`, `${key}-check`, `${key}-export`]);
  await runtime.removeVolumes([`${key}-work`]);
}, 25000);
