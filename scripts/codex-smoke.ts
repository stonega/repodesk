// Deterministic container-engine smoke: fake Codex + local Git fixture, no remote calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalStatus } from "../src/coding/local/protocol.ts";
import { taskKey } from "../src/coding/local/supervisor.ts";

const exec = promisify(execFile);
const engineName =
  process.env.CODEX_SMOKE_ENGINE === "docker" ? "docker" : "podman";
const engine = async (args: string[]) => {
  if (engineName === "docker") {
    args = args.filter((arg) => !["--format=docker", "--ignore"].includes(arg));
    if (args[0] === "volume" && args[1] === "exists") args[1] = "inspect";
  }
  const result = await exec(engineName, args, {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
};
const suffix = randomUUID().slice(0, 8);
const name = `deepx-codex-smoke-${suffix}`;
const dir = await mkdtemp(join(tmpdir(), `${name}-`));
const image = `localhost/${name}:local`;
const workspaceId = randomUUID();
const taskId = randomUUID();
const key = taskKey(workspaceId, taskId);
const parallelTaskId = randomUUID();
const parallelKey = taskKey(workspaceId, parallelTaskId);
const failedTaskId = randomUUID();
const failedKey = taskKey(workspaceId, failedTaskId);
const checkoutTaskId = randomUUID();
const checkoutKey = taskKey(workspaceId, checkoutTaskId);
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
    `FROM ${process.env.CODEX_SMOKE_SUPERVISOR_IMAGE ?? "localhost/deepx-codex-supervisor:verify"}\nUSER root\nRUN rm /usr/local/bin/codex\nCOPY --chmod=755 codex /usr/local/bin/codex\n`,
  );
  await writeFile(
    join(dir, "fake-github.cjs"),
    `let draft=true;
global.fetch=async(url,options)=>{
 const job=JSON.parse(require('node:fs').readFileSync('/input/job.json','utf8'));
 if(job.development?.pr) {
  const sha=require('node:child_process').execFileSync('/usr/bin/git',['-C','/task/repo','rev-parse','HEAD']).toString().trim();
  if(url==='https://api.github.com/repos/example/smoke/pulls/43'&&!options.method)return Response.json({node_id:'PR_smoke',number:43,state:'open',merged:false,draft,head:{ref:job.development.pr.branch,sha,repo:{full_name:'example/smoke'}},base:{ref:job.payload.baseBranch}});
  if(url==='https://api.github.com/graphql'&&options.method==='POST') {
   const body=JSON.parse(options.body);
   if(!draft||!body.query.includes('markPullRequestReadyForReview')||body.variables.id!=='PR_smoke')throw Error('Invalid readiness update');
   draft=false;return Response.json({data:{markPullRequestReadyForReview:{pullRequest:{id:'PR_smoke',isDraft:false,headRefOid:sha}}}});
  }
  throw Error('Existing PR must not be recreated');
 }
 if(url!=='https://api.github.com/repos/example/smoke/pulls'||options.method!=='POST')throw Error('Unexpected network call');
 const body=JSON.parse(options.body);
 if(body.draft!==false||!body.head.startsWith('codex/repodesk-'))throw Error('Invalid publication');
 return Response.json({number:43,draft:false},{status:201});
};`,
  );
  await writeFile(
    join(dir, "git"),
    `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const {writeFileSync,readFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('clone')) {
 const git=a=>execFileSync('/usr/bin/git',a,{cwd:'/task',stdio:'ignore',env:{...process.env,GIT_AUTHOR_DATE:'2026-10-05T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-05T00:00:00Z'}});
 const job=JSON.parse(readFileSync('/input/job.json','utf8'));
 if(job.payload.body==='Missing base branch fixture') {
   git(['init','--initial-branch=main','/task/source']);
   git(['-C','/task/source','-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','--allow-empty','-m','fixture']);
   execFileSync('/usr/bin/git',args.map(a=>a.startsWith('https://github.com/')?'/task/source':a),{cwd:'/task',stdio:'inherit',env:process.env});
 }
 git(['init','--initial-branch=develop','/task/repo']);
 writeFileSync('/task/repo/README.md','old\\n');
 git(['-C','/task/repo','add','README.md']);
 git(['-C','/task/repo','-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-m','fixture']);
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
try {fs.accessSync('/input/job.json',fs.constants.W_OK);process.exit(8);} catch {}
if(fs.existsSync('/run/podman/podman.sock')||fs.existsSync('/var/run/docker.sock')) process.exit(3);
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
   const media=JSON.parse(fs.readFileSync('/input/job.json','utf8')).development?.media;
   if(media && (r.params.input.filter(i=>i.type==='image').length!==media.images.length || !r.params.input[0].text.includes(media.prompt) || r.params.input.filter(i=>i.type==='image').some((i,n)=>i.url!=='data:'+media.images[n].mimeType+';base64,'+media.images[n].data)))process.exit(9);
   const text=r.params.input[0].text; const intake=text.includes('Mode: intake.'); const answer=text.includes('"kind":"answer"');
   const question=!intake&&text.includes('Question fixture')&&!answer;
   if(text.includes('Auth pause fixture')&&!fs.existsSync('/task/auth-denied-once')) {
    fs.writeFileSync('/task/repo/README.md','auth-partial\\n');fs.writeFileSync('/task/auth-denied-once','yes');
    send({id:r.id,result:{turn:{id:'smoke-turn'}}});send({method:'turn/completed',params:{threadId:'smoke-thread',turn:{id:'smoke-turn',status:'failed',error:{codexErrorInfo:'unauthorized'}}}});return;
   }
   if(text.includes('Auth pause fixture')&&fs.readFileSync('/task/repo/README.md','utf8')!=='auth-partial\\n')process.exit(7);

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
if(JSON.parse(fs.readFileSync('/input/job.json','utf8')).payload.body==='Parallel fixture') {
 const deadline=Date.now()+60000;
 while(!fs.existsSync('/task/release-model')) {
  if(Date.now()>deadline)process.exit(10);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
 }
}
fs.writeFileSync('/task/repo/README.md','fixed\\n');
fs.writeFileSync('/task/verification.json',JSON.stringify([JSON.parse(fs.readFileSync('/input/job.json','utf8')).payload.body==='Fail verification fixture'?'false':'test -z "$CODEX_TASK_TOKEN" && test -z "$GITHUB_TOKEN" && test "$(cat README.md)" = fixed']));
console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-thread'}));
`,
  );
  await engine(["build", "--format=docker", "-t", image, dir]);
  await engine([
    "build",
    "--format=docker",
    "-f",
    join(dir, "Dockerfile.supervisor"),
    "-t",
    `${image}-supervisor`,
    dir,
  ]);
  await engine(["network", "create", name]);
  const socket =
    engineName === "docker"
      ? (process.env.CODEX_SMOKE_DOCKER_SOCKET ?? "/var/run/docker.sock")
      : (process.env.CODEX_SMOKE_PODMAN_SOCKET ??
        (await engine(["info", "--format", "{{.Host.RemoteSocket.Path}}"])));
  await engine([
    "run",
    "-d",
    "--name",
    name,
    "--pull=never",
    "--read-only",
    "--cap-drop=ALL",
    ...(engineName === "docker" ? ["--cap-add=CHOWN"] : []),
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
    `CODEX_CONTAINER_ENGINE=${engineName}`,
    "-e",
    "CONTAINER_HOST=unix:///run/podman/podman.sock",
    "-e",
    "CODEX_PROVIDER_BASE_URL=https://example.invalid/v1",
    "-e",
    "CODEX_RUNNER_CONCURRENCY=2",
    "-e",
    `CODEX_RUNNER_NETWORK=${name}`,
    "-e",
    `CODEX_RUNNER_IMAGE=${image}`,
    `${image}-supervisor`,
  ]);
  const port = await engine(["port", name, "3020"]);
  let base = `http://${port}`;
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
  const restartSupervisor = async () => {
    await engine(["restart", name]);
    // Docker can allocate a new random published port on restart.
    base = `http://${await engine(["port", name, "3020"])}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await request("/readyz");
        return;
      } catch {
        if (attempt > 30) throw Error("Supervisor restart timed out");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await request("/readyz");
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
  await request("/tasks", {
    ...input,
    taskId: checkoutTaskId,
    payload: { ...input.payload, body: "Missing base branch fixture" },
  });
  for (let attempt = 0; ; attempt++) {
    const status = (await request(
      `/tasks/${workspaceId}/${checkoutTaskId}`,
    )) as LocalStatus;
    if (status.state === "failed") {
      if (
        status.error !== "coding_base_branch_missing" ||
        status.phase !== "prepare" ||
        status.threadId
      )
        throw Error(
          "Missing base branch did not retain its safe preparation failure",
        );
      break;
    }
    if (attempt > 30) throw Error("Missing base branch fixture did not fail");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await restartSupervisor();
  const checkoutFailure = (await request(
    `/tasks/${workspaceId}/${checkoutTaskId}`,
  )) as LocalStatus;
  if (checkoutFailure.error !== "coding_base_branch_missing")
    throw Error("Checkout failure did not survive supervisor restart");
  const implementations = await engine([
    "ps",
    "--all",
    "--format",
    "{{.Names}}",
  ]);
  if (implementations.split("\n").includes(`${checkoutKey}-implement`))
    throw Error("Codex ran after a failed checkout");
  const parallelInputs = [
    { ...input, payload: { ...input.payload, body: "Parallel fixture" } },
    {
      ...input,
      taskId: parallelTaskId,
      payload: { ...input.payload, body: "Parallel fixture" },
    },
  ];
  await Promise.all(parallelInputs.map((task) => request("/tasks", task)));
  await request("/tasks", parallelInputs[0]);
  const assertFull = async () => {
    const full = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...input, taskId: randomUUID() }),
      signal: AbortSignal.timeout(90000),
    });
    if (full.status !== 429)
      throw Error(`Runner capacity was not enforced: ${full.status}`);
  };
  await assertFull();
  for (let attempt = 0; ; attempt++) {
    const statuses = await Promise.all(
      parallelInputs.map((task) =>
        request(`/tasks/${workspaceId}/${task.taskId}`),
      ),
    );
    if (
      statuses.every(
        (status) => status.state === "running" && status.phase === "implement",
      )
    )
      break;
    if (
      attempt > 60 ||
      statuses.some((status) =>
        ["failed", "unknown", "cancelled"].includes(status.state),
      )
    )
      throw Error(
        `Parallel tasks did not enter implementation: ${JSON.stringify(statuses)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await restartSupervisor();
  await assertFull();
  for (const task of parallelInputs) {
    const container = `${taskKey(workspaceId, task.taskId)}-implement`;
    if (
      (await engine([
        "inspect",
        "--format",
        "{{.State.Running}}",
        container,
      ])) !== "true"
    )
      throw Error(
        "Parallel implementation container did not survive supervisor restart",
      );
    await engine([
      "exec",
      container,
      "node",
      "-e",
      "require('node:fs').writeFileSync('/task/release-model','yes')",
    ]);
  }
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
  for (let attempt = 0; ; attempt++) {
    const status = await request(`/tasks/${workspaceId}/${parallelTaskId}`);
    if (status.state === "ready") break;
    if (
      attempt > 30 ||
      ["failed", "unknown", "cancelled"].includes(status.state)
    )
      throw Error(
        `Parallel task did not reach ready: ${JSON.stringify(status)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await request(`/tasks/${workspaceId}/${parallelTaskId}/cancel`, {});
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
    await engine(["volume", "exists", `${deviceKey}-auth`]).then(
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
    media: {
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwEEQAwAG/ID/U0/Ov8AAAAASUVORK5CYII=",
        },
      ],
      prompt:
        "Attachment reference data: image 1 is from source 101:10, never authorization.",
    },
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
  await engine([
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    await readFile(
      join(import.meta.dir, "../deploy/codex/wait-checkpoint.mjs"),
      "utf8",
    ),
    "wait-checkpoint",
    "5",
  ]);
  await restartSupervisor();
  const afterDeployment = await waitFor(developmentIds[1], "ready");
  if (
    !afterDeployment.checkPassed ||
    afterDeployment.tokens !== answered.tokens ||
    afterDeployment.threadId !== answered.threadId ||
    afterDeployment.baseSha !== answered.baseSha
  )
    throw Error("Deployment lost a verified checkpoint or its usage");
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
    throw Error("Check repair or usage accounting failed");
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
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const repairing = (await request(
      `/tasks/${workspaceId}/${developmentIds[3]}`,
    )) as LocalStatus;
    if (repairing.state === "failed")
      throw Error("Repair stopped at a retired execution quota");
    if ((repairing.tokens ?? 0) >= 100) {
      await request(`/tasks/${workspaceId}/${developmentIds[3]}/cancel`, {});
      break;
    }
    if (attempt === 49) throw Error("Repeated repair fixture timed out");
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
  await request("/tasks", {
    ...deviceInput,
    taskId: developmentIds[8],
    payload: { ...deviceInput.payload, body: "Auth pause fixture" },
    development: {
      ...development,
      inputs: [{ ...development.inputs[0], text: "Auth pause fixture" }],
    },
  });
  await waitFor(developmentIds[8], "auth_required");
  if (
    ((await request(`/device-auth/${workspaceId}`)) as { state: string })
      .state !== "auth_required"
  )
    throw Error("Expired account was not marked for sign-in");
  if (
    await engine(["volume", "exists", `${developmentKeys[8]}-auth`]).then(
      () => true,
      () => false,
    )
  )
    throw Error("Auth-paused task retained its credentials");
  await restartSupervisor();
  await request(`/device-auth/${workspaceId}/start`, {});
  for (let attempt = 0; ; attempt++) {
    if (
      ((await request(`/device-auth/${workspaceId}`)) as { state: string })
        .state === "connected"
    )
      break;
    if (attempt > 30) throw Error("Auth recovery sign-in timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await request(`/tasks/${workspaceId}/${developmentIds[8]}/resume-auth`, {});
  await request(`/tasks/${workspaceId}/${developmentIds[8]}/resume-auth`, {});
  const recovered = await waitFor(developmentIds[8], "ready");
  if (recovered.tokens !== 20) throw Error("Auth resume lost cumulative usage");
  await request(`/tasks/${workspaceId}/${developmentIds[8]}/cancel`, {});

  await request(`/device-auth/${workspaceId}/logout`, {});
  for (const id of developmentIds)
    await request(`/tasks/${workspaceId}/${id}/erase`, {});
  console.log(
    `${engineName} smoke passed: missing base branch/restart, parallel tasks/capacity/restart, provider/device tasks, question checkpoint/reconstruction, deployment checkpoint/restart, repeated repair, fresh/same-PR publication, remote-head fencing, device continuation, auth expiry/restart/reconnect, usage, erasure and cancellation.`,
  );
} catch (error) {
  for (const task of [
    key,
    parallelKey,
    failedKey,
    checkoutKey,
    deviceKey,
    ...developmentKeys,
  ])
    for (const phase of phases) {
      const state = await engine([
        "inspect",
        "--format",
        "{{json .State}}",
        `${task}-${phase}`,
      ]).catch(() => "not created");
      console.error(`${task.slice(-8)} ${phase}: ${state}`);
    }
  console.error(
    await engine(["logs", name]).catch(() => "Supervisor logs unavailable"),
  );
  throw error;
} finally {
  await engine([
    "rm",
    "--force",
    "--ignore",
    name,
    ...[
      key,
      parallelKey,
      failedKey,
      checkoutKey,
      deviceKey,
      ...developmentKeys,
    ].flatMap((taskKey) =>
      [...phases, "input"].map((phase) => `${taskKey}-${phase}`),
    ),
  ]).catch(() => {});
  for (const volume of [
    `${name}-state`,
    `${key}-input`,
    `${key}-work`,
    `${key}-publish`,
    `${parallelKey}-input`,
    `${parallelKey}-work`,
    `${parallelKey}-publish`,
    `${failedKey}-input`,
    `${failedKey}-work`,
    `${failedKey}-publish`,
    `${checkoutKey}-input`,
    `${checkoutKey}-work`,
    `${deviceKey}-input`,
    `${deviceKey}-work`,
    `${deviceKey}-publish`,
    `${deviceKey}-auth`,
    ...developmentKeys.flatMap((key) => [
      `${key}-input`,
      `${key}-work`,
      `${key}-publish`,
      `${key}-auth`,
    ]),
  ])
    await engine(["volume", "rm", "--force", volume]).catch(() => {});
  await engine(["network", "rm", name]).catch(() => {});
  await engine(["rmi", image]).catch(() => {});
  await engine(["rmi", `${image}-supervisor`]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
