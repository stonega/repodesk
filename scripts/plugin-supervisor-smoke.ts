import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [supervisor, job] = process.argv.slice(2);
assert.ok(supervisor && job, "Supply supervisor image and immutable job image");
const name = `repodesk-plugin-smoke-${randomUUID()}`;
try {
  await execute("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "repodesk.plugin-test=true",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-e",
    "PORT=3030",
    "-e",
    "PLUGIN_RUNNER_TOKEN=synthetic-private-supervisor-smoke-token-12345",
    "-e",
    `PLUGIN_RUNNER_IMAGE=${job}`,
    supervisor,
  ]);
  const code = `const assert=require('node:assert/strict');
(async()=>{
 for(let i=0;i<20;i++){try{await fetch('http://127.0.0.1:3030/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const denied=await fetch('http://127.0.0.1:3030/healthz');
 const ok=await fetch('http://127.0.0.1:3030/healthz',{headers:{authorization:'Bearer synthetic-private-supervisor-smoke-token-12345'}});
 assert.equal(denied.status,403);assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{protocolVersion:1});
})().catch(()=>process.exit(1));`;
  await execute("docker", ["exec", name, "node", "-e", code], {
    timeout: 10000,
  });
  await execute("docker", ["exec", name, "docker", "--version"]);
  console.log(
    "Exact private supervisor image: authentication, health and Docker client passed (offline).",
  );
} finally {
  await execute("docker", ["rm", "-f", name]).catch(() => {});
}
