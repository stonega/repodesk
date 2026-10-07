import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DevelopmentRun,
  developmentMedia,
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
    expect(schema.properties.evidenceRevision).toMatchObject({
      type: "integer",
      enum: [2],
    });
    expect(schema.properties.evidence).toMatchObject({
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

test("captionless media answers pin preceding text evidence; empty follow-ups do not inherit authority", () => {
  const run = retry();
  const current = run.inputs[1];
  const original = run.inputs[0];
  if (!current || !original) throw new Error("Missing fixture input");
  current.text = "";
  current.hasAttachments = true;
  current.kind = "answer";
  expect(developmentSchema(run).properties.evidenceRevision).toMatchObject({
    type: "integer",
    enum: [1],
  });
  expect(developmentSchema(run).properties.evidence).toMatchObject({
    type: "string",
    enum: [original.text],
  });
  current.kind = "followup";
  expect(developmentSchema(run).properties.evidenceRevision).toMatchObject({
    type: "integer",
    enum: [2],
  });
  expect(developmentSchema(run).properties.evidence).toMatchObject({
    type: "string",
    enum: [""],
  });
});

test("Codex receives image data URLs and handles echoed media larger than the former protocol buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-image-protocol-"));
  try {
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      `
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
rl.on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'image-thread'}}});
 if(m.method==='turn/start'){
  fs.writeFileSync(process.env.PAYLOAD_PATH,JSON.stringify(m.params.input));
  send({id:m.id,result:{turn:{id:'image-turn'}}});
  send({method:'item/started',params:{threadId:'image-thread',item:{type:'userMessage',content:m.params.input}}});
  const result={status:'intent',intent:'implement',evidenceRevision:2,evidence:'Try again',publishRequested:false,summary:'Image received',question:null,title:'Style update',body:'',verificationCommands:[]};
  send({method:'item/completed',params:{threadId:'image-thread',item:{type:'agentMessage',text:JSON.stringify(result)}}});
  send({method:'turn/completed',params:{threadId:'image-thread',turn:{id:'image-turn',status:'completed'}}});
 }
});
`,
    );
    const media = developmentMedia.parse({
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.alloc(4 * 1024 * 1024, 1).toString("base64"),
        },
      ],
      prompt: "Image 1 comes from the original request.",
    });
    const payload = join(dir, "payload.json");
    const result = await runConversation({
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...process.env, PAYLOAD_PATH: payload },
      prompt: media.prompt,
      images: media.images,
      timeoutMs: 10000,
    });
    expect(result.result.summary).toBe("Image received");
    const input = JSON.parse(await readFile(payload, "utf8"));
    expect(input[0].text).toBe(media.prompt);
    expect(input[1]).toEqual({
      type: "image",
      url: `data:image/png;base64,${media.images[0]?.data}`,
    });
    expect(
      developmentMedia.safeParse({
        ...media,
        images: [{ ...media.images[0], mimeType: "image/svg+xml" }],
      }).success,
    ).toBe(false);
    expect(
      developmentMedia.safeParse({
        ...media,
        images: Array(5).fill(media.images[0]),
      }).success,
    ).toBe(false);
    expect(
      developmentMedia.safeParse({
        ...media,
        images: Array(3).fill(media.images[0]),
      }).success,
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
