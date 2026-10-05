// Deterministic real-Podman smoke: fake Codex + local Git fixture, no remote calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalStatus } from "../src/coding/local/protocol.ts";
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
const deviceTaskId = randomUUID();
const deviceKey = taskKey(workspaceId, deviceTaskId);
const developmentIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
] as const;
const developmentKeys = developmentIds.map((id) => taskKey(workspaceId, id));
const phases = ["prepare", "setup", "implement", "check", "export", "publish"];
const token = "smoke-management-token-no-real-secrets";
try {
  await writeFile(
    join(dir, "Dockerfile"),
    `FROM ${process.env.CODEX_SMOKE_JOB_IMAGE ?? "localhost/deepx-codex-job:verify"}\nUSER root\nRUN rm /usr/local/bin/codex\nCOPY --chmod=755 codex /usr/local/bin/codex\nCOPY --chmod=755 git /usr/local/bin/git\nCOPY fake-github.cjs /opt/deepx/fake-github.cjs\nENV NODE_OPTIONS=--require=/opt/deepx/fake-github.cjs\nUSER node\n`,
  );
  await writeFile(
    join(dir, "Dockerfile.supervisor"),
    `FROM ${process.env.CODEX_SMOKE_SUPERVISOR_IMAGE ?? "localhost/deepx-codex-supervisor:verify"}\nUSER root\nCOPY --chmod=755 codex /usr/local/bin/codex\n`,
  );
  await writeFile(
    join(dir, "fake-github.cjs"),
    `global.fetch=async(url,options)=>{if(require('node:fs').existsSync('/input/job.json')&&JSON.parse(require('node:fs').readFileSync('/input/job.json','utf8')).development?.pr)throw Error('Existing PR must not be recreated');if(!String(url).startsWith('https://api.github.com/repos/example/smoke/pulls'))throw Error('Unexpected network call');const body=JSON.parse(options.body);if(!body.draft||!body.head.startsWith('codex/repodesk-'))throw Error('Invalid publication');return new Response(JSON.stringify({number:43}),{status:201});};`,
  );
  await writeFile(
    join(dir, "git"),
    `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const {writeFileSync,readFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('clone')) {
 const git=a=>execFileSync('/usr/bin/git',a,{cwd:'/task',stdio:'ignore',env:{...process.env,GIT_AUTHOR_DATE:'2026-10-05T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-05T00:00:00Z'}});
 git(['init','--initial-branch=develop','/task/repo']);
 writeFileSync('/task/repo/README.md','old\\n');
 git(['-C','/task/repo','add','README.md']);
 git(['-C','/task/repo','-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-m','fixture']);
 const job=JSON.parse(readFileSync('/input/job.json','utf8'));
 if(job.development?.pr) {
   writeFileSync('/task/repo/README.md','fixed\\n');
   git(['-C','/task/repo','add','--all']);
   git(['-C','/task/repo','-c','user.name=RepoDesk Codex','-c','user.email=codex@users.noreply.github.com','-c','commit.gpgSign=false','commit','-m','Implement maintainer-approved RepoDesk task']);
 }

} else if(args.includes('ls-remote')) {
 const job=JSON.parse(readFileSync('/input/job.json','utf8'));
 process.stdout.write((job.payload.body==='Remote race fixture'?'0'.repeat(40):job.development.pr.headSha)+'\\trefs/heads/'+job.development.pr.branch+'\\n');
} else if(args.includes('push')) { /* local publication fixture */ } else execFileSync('/usr/bin/git',args,{stdio:'inherit',env:{...process.env,GIT_AUTHOR_DATE:'2026-10-05T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-05T00:00:00Z'}});
`,
  );
  await writeFile(
    join(dir, "codex"),
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='login') {
 console.log('Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\nEnter this one-time code (expires in 15 minutes)\\n   ABCD-EFGH');
 setTimeout(()=>{fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({tokens:{access_token:'smoke-account'}}));},200);
 setTimeout(()=>process.exit(0),300);
 return;
}
if(process.env.GITHUB_TOKEN||process.env.CODEX_PROVIDER_API_KEY) process.exit(2);
if(fs.existsSync('/run/podman/podman.sock')) process.exit(3);
if(process.env.CODEX_HOME==='/auth') {
 if(!fs.existsSync('/auth/auth.json')||process.env.CODEX_TASK_TOKEN) process.exit(4);
 fs.writeFileSync('/auth/auth.json',JSON.stringify({tokens:{access_token:'refreshed-smoke-account'}}));
}
if(process.argv[2]==='app-server') {
 const rl=require('node:readline').createInterface({input:process.stdin});
 const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 rl.on('line',line=>{
  const r=JSON.parse(line); if(r.id===undefined)return;
  if(r.method==='initialize')return send({id:r.id,result:{}});
  if(r.method==='thread/resume'&&!fs.existsSync(process.env.CODEX_HOME+'/session'))return send({id:r.id,error:{code:-32600,message:'no rollout found for thread id'}});
  if(r.method==='thread/start'||r.method==='thread/resume') {fs.writeFileSync(process.env.CODEX_HOME+'/session','smoke-thread');return send({id:r.id,result:{thread:{id:'smoke-thread'}}});}
  if(r.method==='turn/start') {
   const text=r.params.input[0].text; const intake=text.includes('Mode: intake.'); const answer=text.includes('"kind":"answer"');
   const question=!intake&&text.includes('Question fixture')&&!answer;
   if(!intake) {
    if(answer&&!text.includes('Followup fixture')&&fs.readFileSync('/task/repo/README.md','utf8')!=='partial\\n')process.exit(6);
    fs.writeFileSync('/task/repo/README.md',question?'partial\\n':text.includes('Repair fixture')&&!text.includes('Verification checks failed.')?'broken\\n':'fixed\\n');
   }
   if(text.includes('Followup fixture'))fs.writeFileSync('/task/repo/extra.txt','updated\\n');
   const result={status:intake?'intent':question?'needs_input':'completed',intent:'implement',evidenceRevision:1,evidence:'Fixture',publishRequested:true,summary:'Fixture checked.',question:question?'Keep page one for empty results?':null,title:'Smoke fix',body:'Local smoke checks passed.',verificationCommands:intake||question?[]:text.includes('Verification checks failed.')?['true']:text.includes('Exhaust fixture')?['false']:['test -z "$CODEX_TASK_TOKEN" && test -z "$GITHUB_TOKEN" && test "$(cat README.md)" = fixed']};
   send({id:r.id,result:{turn:{id:'smoke-turn'}}});send({method:'turn/started',params:{threadId:'smoke-thread',turn:{id:'smoke-turn'}}});
   send({method:'thread/tokenUsage/updated',params:{threadId:'smoke-thread',turnId:'smoke-turn',tokenUsage:{total:{totalTokens:20},last:{totalTokens:20}}}});
   send({method:'item/completed',params:{threadId:'smoke-thread',turnId:'smoke-turn',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(result)}}});
   send({method:'turn/completed',params:{threadId:'smoke-thread',turn:{id:'smoke-turn',status:'completed'}}});return;
  }
  send({id:r.id,error:{code:-32601,message:'unsupported'}});
 });return;
}
fs.writeFileSync('/task/repo/README.md','fixed\\n');
fs.writeFileSync('/task/verification.json',JSON.stringify([JSON.parse(fs.readFileSync('/input/job.json','utf8')).payload.body==='Fail verification fixture'?'false':'test -z "$CODEX_TASK_TOKEN" && test -z "$GITHUB_TOKEN" && test "$(cat README.md)" = fixed']));
console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-thread'}));
`,
  );
  await podman(["build", "--format=docker", "-t", image, dir]);
  await podman([
    "build",
    "--format=docker",
    "-f",
    join(dir, "Dockerfile.supervisor"),
    "-t",
    `${image}-supervisor`,
    dir,
  ]);
  await podman(["network", "create", name]);
  const socket =
    process.env.CODEX_SMOKE_PODMAN_SOCKET ??
    (await podman(["info", "--format", "{{.Host.RemoteSocket.Path}}"]));
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
    `${image}-supervisor`,
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
      title: "Smoke",
      body: "Change old to fixed",
      backend: "podman",
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
    payload: { ...input.payload, body: "Fail verification fixture" },
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
  const login = (await request(`/device-auth/${workspaceId}/start`, {})) as {
    state: string;
    verificationUrl?: string;
    userCode?: string;
  };
  if (
    login.userCode !== "ABCD-EFGH" ||
    login.verificationUrl !== "https://auth.openai.com/codex/device"
  )
    throw new Error(
      `Device login instructions missing: ${JSON.stringify(login)}`,
    );
  for (let attempt = 0; ; attempt++) {
    const status = (await request(`/device-auth/${workspaceId}`)) as {
      state: string;
    };
    if (status.state === "connected") break;
    if (attempt > 30) throw new Error("Device login did not complete");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await request("/tasks", {
    ...input,
    taskId: deviceTaskId,
    payload: { ...input.payload, authMode: "device_code" },
    providerApiKey: undefined,
  });
  for (let attempt = 0; ; attempt++) {
    const status = (await request(`/tasks/${workspaceId}/${deviceTaskId}`)) as {
      state: string;
      threadId?: string;
    };
    if (status.state === "ready") {
      if (status.threadId !== "smoke-thread")
        throw new Error("Device task lost its thread ID");
      break;
    }
    if (
      ["failed", "unknown", "cancelled"].includes(status.state) ||
      attempt > 30
    )
      throw new Error(
        `Device task did not reach ready: ${JSON.stringify(status)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (
    await podman(["volume", "exists", `${deviceKey}-auth`]).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Device task auth volume was retained");
  await request(`/device-auth/${workspaceId}/logout`, {});
  if (
    ((await request(`/device-auth/${workspaceId}`)) as { state: string })
      .state !== "disconnected"
  )
    throw new Error("Device logout did not clear the workspace");
  const logicalTaskId = randomUUID();
  const development = {
    taskId: logicalTaskId,
    revision: 1,
    mode: "work",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "101:10",
        text: "Question fixture",
        kind: "request",
      },
    ],
    context: "",
    maxRepairAttempts: 2,
    activeSeconds: 120,
    maxTokens: 1000,
  };
  const waitFor = async (id: string, expected: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = (await request(
        `/tasks/${workspaceId}/${id}`,
      )) as LocalStatus;
      if (status.state === expected) return status;
      if (["failed", "cancelled", "unknown"].includes(status.state))
        throw Error(`Continuous fixture failed: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw Error("Continuous fixture timed out");
  };
  await request("/tasks", {
    ...input,
    taskId: developmentIds[0],
    issue: undefined,
    development,
  });
  const waiting = await waitFor(developmentIds[0], "succeeded");
  if (waiting.result?.status !== "needs_input")
    throw Error("Question checkpoint missing");
  await request("/tasks", {
    ...input,
    taskId: developmentIds[1],
    issue: undefined,
    development: {
      ...development,
      revision: 2,
      previousAttemptId: developmentIds[0],
      threadId: waiting.threadId,
      inputs: [
        ...development.inputs,
        {
          revision: 2,
          actor: "101",
          sourceId: "101:11",
          text: "Yes, keep page one",
          kind: "answer",
        },
      ],
    },
  });
  const answered = await waitFor(developmentIds[1], "ready");
  if (!answered.checkPassed || answered.result?.status !== "completed")
    throw Error("Answer/checkpoint reconstruction failed");
  await request(`/tasks/${workspaceId}/${developmentIds[1]}/publish`, {
    token: "fake-write-token",
  });
  const published = await waitFor(developmentIds[1], "succeeded");
  if (
    published.prUrl !== "https://github.com/example/smoke/pull/43" ||
    !published.publishedSha
  )
    throw Error("Continuous publication failed");
  await request("/tasks", {
    ...input,
    taskId: developmentIds[2],
    issue: undefined,
    development: {
      ...development,
      taskId: randomUUID(),
      inputs: [{ ...development.inputs[0], text: "Repair fixture" }],
    },
  });
  const repaired = await waitFor(developmentIds[2], "ready");
  if (repaired.tokens !== 40 || !repaired.checkPassed)
    throw Error("Bounded repair or usage accounting failed");
  await request(`/tasks/${workspaceId}/${developmentIds[2]}/cancel`, {});
  await request("/tasks", {
    ...input,
    taskId: developmentIds[3],
    issue: undefined,
    development: {
      ...development,
      taskId: randomUUID(),
      inputs: [
        { ...development.inputs[0], text: "Repair fixture Exhaust fixture" },
      ],
      maxRepairAttempts: 1,
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const failed = (await request(
      `/tasks/${workspaceId}/${developmentIds[3]}`,
    )) as LocalStatus;
    if (failed.state === "failed") {
      if (failed.error !== "coding_check_failed" || failed.tokens !== 40)
        throw Error("Repair limit failed");
      break;
    }
    if (attempt === 49) throw Error("Repair limit timed out");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const pr = {
    number: 43,
    url: published.prUrl,
    branch: `codex/repodesk-${logicalTaskId}`,
    headSha: published.publishedSha,
  };
  await request("/tasks", {
    ...input,
    taskId: developmentIds[4],
    issue: undefined,
    development: {
      ...development,
      pr,
      revision: 3,
      inputs: [{ ...development.inputs[0], text: "Followup fixture" }],
    },
  });
  await waitFor(developmentIds[4], "ready");
  await request(`/tasks/${workspaceId}/${developmentIds[4]}/publish`, {
    token: "fake-write-token",
  });
  const followup = await waitFor(developmentIds[4], "succeeded");
  if (
    followup.prUrl !== published.prUrl ||
    followup.publishedSha === published.publishedSha
  )
    throw Error("Follow-up did not update the same PR");
  await request("/tasks", {
    ...input,
    taskId: developmentIds[5],
    issue: undefined,
    payload: { ...input.payload, body: "Remote race fixture" },
    development: {
      ...development,
      pr,
      inputs: [{ ...development.inputs[0], text: "Followup fixture" }],
    },
  });
  await waitFor(developmentIds[5], "ready");
  await request(`/tasks/${workspaceId}/${developmentIds[5]}/publish`, {
    token: "fake-write-token",
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const raced = (await request(
      `/tasks/${workspaceId}/${developmentIds[5]}`,
    )) as LocalStatus;
    if (raced.state === "failed") {
      if (raced.error !== "coding_remote_head_changed")
        throw Error("Expected remote-head fence");
      break;
    }
    if (attempt === 29) throw Error("Remote-head fence timed out");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await request(`/device-auth/${workspaceId}/start`, {});
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      ((await request(`/device-auth/${workspaceId}`)) as { state: string })
        .state === "connected"
    )
      break;
    if (attempt === 29) throw Error("Device reconnection timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const deviceLogicalTaskId = randomUUID();
  const deviceInput = {
    ...input,
    issue: undefined,
    providerApiKey: undefined,
    payload: { ...input.payload, authMode: "device_code" },
  };
  await request("/tasks", {
    ...deviceInput,
    taskId: developmentIds[6],
    development: { ...development, taskId: deviceLogicalTaskId },
  });
  const deviceQuestion = await waitFor(developmentIds[6], "succeeded");
  if (deviceQuestion.result?.status !== "needs_input")
    throw Error("Device question result was lost");
  await request("/tasks", {
    ...deviceInput,
    taskId: developmentIds[7],
    development: {
      ...development,
      taskId: deviceLogicalTaskId,
      revision: 2,
      previousAttemptId: developmentIds[6],
      inputs: [
        ...development.inputs,
        {
          revision: 2,
          actor: "101",
          sourceId: "101:12",
          text: "Keep page one",
          kind: "answer",
        },
      ],
    },
  });
  await waitFor(developmentIds[7], "ready");
  await request(`/tasks/${workspaceId}/${developmentIds[7]}/cancel`, {});
  await request(`/device-auth/${workspaceId}/logout`, {});
  for (const id of developmentIds)
    await request(`/tasks/${workspaceId}/${id}/erase`, {});
  console.log(
    "Podman smoke passed: provider/device tasks, question checkpoint/reconstruction, bounded repair, fresh/same-PR publication, remote-head fencing, device continuation, usage, erasure and cancellation.",
  );
} catch (error) {
  for (const task of [key, failedKey, deviceKey, ...developmentKeys])
    for (const phase of phases) {
      const state = await podman([
        "inspect",
        "--format",
        "{{json .State}}",
        `${task}-${phase}`,
      ]).catch(() => "not created");
      console.error(`${task.slice(-8)} ${phase}: ${state}`);
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
    ...[key, failedKey, deviceKey, ...developmentKeys].flatMap((taskKey) =>
      phases.map((phase) => `${taskKey}-${phase}`),
    ),
  ]).catch(() => {});
  for (const volume of [
    `${name}-state`,
    `${key}-work`,
    `${key}-publish`,
    `${failedKey}-work`,
    `${failedKey}-publish`,
    `${deviceKey}-work`,
    `${deviceKey}-publish`,
    `${deviceKey}-auth`,
    ...developmentKeys.flatMap((key) => [
      `${key}-work`,
      `${key}-publish`,
      `${key}-auth`,
    ]),
  ])
    await podman(["volume", "rm", "--force", volume]).catch(() => {});
  await podman(["network", "rm", name]).catch(() => {});
  await podman(["rmi", image]).catch(() => {});
  await podman(["rmi", `${image}-supervisor`]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
