import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConversation } from "../../src/coding/local/conversation.ts";

test("PR analysis pins credential-denying filesystem and clean shell policies without a legacy override", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-review-sandbox-"));
  const binary = join(root, "codex.mjs"),
    capture = join(root, "requests.jsonl");
  const result = {
    status: "analysis",
    intent: "analyze",
    evidenceRevision: 1,
    evidence: "review",
    publishRequested: false,
    summary: "No supported findings.",
    question: null,
    title: "Review",
    body: "",
    verificationCommands: [],
  };
  await writeFile(
    binary,
    `import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',(line)=>{
const m=JSON.parse(line);appendFileSync(${JSON.stringify(capture)},line+'\\n');
if(m.id===undefined)return;
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'review-thread'}}});
else if(m.method==='turn/start'){
 send({id:m.id,result:{turn:{id:'review-turn'}}});
 setTimeout(()=>{send({method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify(${JSON.stringify(result)})}}});send({method:'turn/completed',params:{turn:{id:'review-turn',status:'completed'}}});},10);
}});`,
  );
  try {
    const outcome = await runConversation({
      binary: process.execPath,
      args: [binary],
      cwd: root,
      env: { PATH: process.env.PATH },
      prompt: "Review only.",
      readOnly: true,
      protectCredentials: true,
    });
    expect(outcome.result.summary).toBe("No supported findings.");
    const requests = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const start = requests.find((r) => r.method === "thread/start");
    expect(start.params.sandbox).toBeUndefined();
    expect(start.params.config.filesystem).toMatchObject({
      ":root": "read",
      "/auth": "deny",
      "/task/codex": "deny",
      "/proc": "deny",
    });
    expect(start.params.config.shell_environment_policy.inherit).toBe("none");
    expect(start.params.config.shell_environment_policy.set).not.toHaveProperty(
      "CODEX_TASK_TOKEN",
    );
    expect(
      requests.find((r) => r.method === "turn/start").params,
    ).not.toHaveProperty("sandboxPolicy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
