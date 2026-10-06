import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DevelopmentRun,
  developmentSchema,
} from "../../src/coding/development.ts";
import { runConversation } from "../../src/coding/local/conversation.ts";

function retry(text = "Try again"): DevelopmentRun {
  return {
    taskId: randomUUID(),
    revision: 2,
    mode: "intake",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "initial",
        kind: "request",
        text: "Fix pagination and open a draft PR",
      },
      {
        revision: 2,
        actor: "101",
        sourceId: "retry",
        kind: "followup",
        text,
      },
    ],
    context: "Reference context may describe the previous request.",
  };
}

test("intake binds evidence to the consumed authenticated input, including short retries and literal Unicode", () => {
  for (const text of ["Try again", 'Keep “draft” PRs.\nDo not merge "main".']) {
    const run = retry(text);
    const schema = developmentSchema(run);
    expect(schema.properties.status.enum).toEqual(["intent", "needs_input"]);
    expect(schema.properties.evidenceRevision).toEqual({
      type: "integer",
      enum: [2],
    });
    expect(schema.properties.evidence).toEqual({
      type: "string",
      enum: [text],
    });
  }
  const missing = retry();
  missing.revision = 3;
  expect(() => developmentSchema(missing)).toThrow(
    "coding_input_revision_missing",
  );
  expect(
    developmentSchema({ ...retry(), mode: "analysis" }).properties.status.enum,
  ).toEqual(["analysis", "needs_input"]);
  expect(
    developmentSchema({ ...retry(), mode: "work" }).properties.status.enum,
  ).toEqual(["completed", "needs_input"]);
});

test("the Codex turn receives the intake schema and returns current retry evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-intent-protocol-"));
  try {
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line',line=>{
  const request=JSON.parse(line);
  if(request.id==null)return;
  if(request.method==='initialize')send({id:request.id,result:{}});
  if(request.method==='thread/start')send({id:request.id,result:{thread:{id:'intent-thread'}}});
  if(request.method==='turn/start'){
    const schema=request.params.outputSchema;
    const result={status:'intent',intent:'implement',evidenceRevision:schema.properties.evidenceRevision.enum[0],evidence:schema.properties.evidence.enum[0],publishRequested:false,summary:'Interpreted the retry',question:null,title:'Retry pagination',body:'',verificationCommands:[]};
    send({id:request.id,result:{turn:{id:'intent-turn'}}});
    send({method:'item/completed',params:{threadId:'intent-thread',item:{type:'agentMessage',text:JSON.stringify(result)}}});
    send({method:'turn/completed',params:{threadId:'intent-thread',turn:{id:'intent-turn',status:'completed'}}});
  }
});
`,
    );
    const result = await runConversation({
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: process.env,
      prompt: "Interpret the latest authenticated retry",
      readOnly: true,
      outputSchema: developmentSchema(retry()),
      timeoutMs: 5000,
    });
    expect(result.result.status).toBe("intent");
    expect(result.result.evidenceRevision).toBe(2);
    expect(result.result.evidence).toBe("Try again");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
