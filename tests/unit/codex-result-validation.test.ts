import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type DevelopmentResult,
  developmentOutputSchema,
  developmentResult,
} from "../../src/coding/development.ts";
import { CodexAuthError } from "../../src/coding/local/auth-failure.ts";
import { runConversation } from "../../src/coding/local/conversation.ts";
import { CodexConversationError } from "../../src/coding/local/conversation-failure.ts";
import { localStatus } from "../../src/coding/local/protocol.ts";
import { safeResultIssues } from "../../src/coding/result-validation.ts";

const valid = {
  status: "completed",
  intent: "implement",
  evidenceRevision: 1,
  evidence: "Fix the card",
  publishRequested: false,
  summary: "Updated the card",
  question: null,
  title: "Improve card UI",
  body: "Updated hierarchy and spacing",
  verificationCommands: ["bun test"],
} satisfies DevelopmentResult;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("generated output constraints reject field bounds that the runtime rejects", () => {
  const output = z.fromJSONSchema(developmentOutputSchema);
  expect(output.safeParse(valid).success).toBe(true);
  for (const value of [
    { ...valid, evidenceRevision: -1 },
    { ...valid, summary: "" },
    { ...valid, summary: "x".repeat(12001) },
    { ...valid, evidence: "x".repeat(20001) },
    { ...valid, title: "x".repeat(201) },
    { ...valid, question: "x".repeat(3001) },
    { ...valid, body: "x".repeat(12001) },
    { ...valid, verificationCommands: [" "] },
    { ...valid, verificationCommands: ["x".repeat(2001)] },
    { ...valid, verificationCommands: Array(9).fill("bun test") },
  ]) {
    expect(output.safeParse(value).success).toBe(false);
    expect(developmentResult.safeParse(value).success).toBe(false);
  }
});

test("diagnostics keep bounded field paths and codes without private names or values", () => {
  const parsed = developmentResult.safeParse({
    ...valid,
    title: "private-value".repeat(100),
    "private-field-name": "private-secret",
  });
  if (parsed.success) throw Error("Expected invalid fixture");
  const issues = safeResultIssues(parsed.error.issues);
  expect(issues).toContainEqual({ path: ["title"], code: "too_big" });
  expect(issues).toContainEqual({ path: [], code: "unrecognized_keys" });
  expect(JSON.stringify(issues)).not.toContain("private");
  expect(
    safeResultIssues([{ path: ["private-field"], code: "invalid_type" }]),
  ).toEqual([{ path: [], code: "invalid_type" }]);
  expect(safeResultIssues(Array(20).fill(parsed.error.issues[0]))).toHaveLength(
    8,
  );
  expect(
    localStatus.safeParse({
      state: "failed",
      resultIssues: [{ path: ["private-field"], code: "too_big" }],
    }).success,
  ).toBe(false);
});

async function fixture(scenario: string) {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-result-correction-"));
  dirs.push(dir);
  const script = join(dir, "server.cjs"),
    requests = join(dir, "requests.json");
  await writeFile(
    script,
    `
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
const requests=[];
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const valid=${JSON.stringify(valid)};
rl.on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'correction-thread'}}});
 if(m.method==='turn/start'){
  requests.push(m.params);fs.writeFileSync(process.env.REQUESTS,JSON.stringify(requests));
  const count=requests.length,turnId='turn-'+count,scenario=process.env.SCENARIO;
  // Keep the reply and all notifications in one write to exercise event ordering.
  const batch=[];const push=v=>batch.push(JSON.stringify(v)+'\\n');
  push({id:m.id,result:{turn:{id:turnId}}});
  if(!(scenario==='unknown_first'&&count===1)&&!(scenario==='auth_unknown'&&count===2))
   push({method:'thread/tokenUsage/updated',params:{threadId:'correction-thread',turnId,tokenUsage:{last:{totalTokens:count===1?25:7},total:{totalTokens:count===1?25:32}}}});
  // Old/duplicate notifications must neither complete the correction nor count again.
  if(count===2){
   push({method:'thread/tokenUsage/updated',params:{threadId:'correction-thread',turnId:'turn-1',tokenUsage:{last:{totalTokens:999},total:{totalTokens:999}}}});
   push({method:'item/completed',params:{threadId:'correction-thread',turnId:'turn-1',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(valid)}}});
   push({method:'turn/completed',params:{threadId:'correction-thread',turn:{id:'turn-1',status:'completed'}}});
  }
  if(count===2&&scenario==='cancel'){
   process.stdout.write(batch.join(''));return;
  }
  if(count===2&&(scenario==='auth'||scenario==='auth_unknown')){
   if(scenario==='auth_unknown')push({method:'item/started',params:{threadId:'correction-thread',turnId,item:{type:'reasoning'}}});
   push({method:'turn/completed',params:{threadId:'correction-thread',turn:{id:turnId,status:'failed',error:{codexErrorInfo:'unauthorized',message:'bearer private-secret'}}}});
  }else{
   let result=valid;
   if(count===1||scenario==='always_invalid')result={...valid,verificationCommands:[]};
   if(count===1&&scenario==='unknown_key')result={...result,'private-field':'private-secret'};
   if(scenario==='large_valid')result={...valid,summary:'界'.repeat(12000),body:'界'.repeat(12000)};
   let text=JSON.stringify(result);
   if(count===1&&scenario==='json')text='private malformed result';
   if(!(count===1&&scenario==='missing'))push({method:'item/completed',params:{threadId:'correction-thread',turnId,item:{type:'agentMessage',phase:'final_answer',text}}});
   push({method:'turn/completed',params:{threadId:'correction-thread',turn:{id:turnId,status:'completed'}}});
  }
  process.stdout.write(batch.join(''));
 }
});
`,
  );
  return {
    requests,
    options: {
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...process.env, SCENARIO: scenario, REQUESTS: requests },
      prompt: "Fix the card. Fixed verification plan: bun test.",
      timeoutMs: 5000,
      outputSchema: developmentOutputSchema,
    },
  };
}

test("one read-only correction preserves the thread, schema, work and cumulative usage", async () => {
  for (const scenario of [
    "schema",
    "unknown_key",
    "json",
    "missing",
    "unknown_first",
  ]) {
    const f = await fixture(scenario);
    const result = await runConversation(f.options);
    expect(result.result).toEqual(valid);
    expect(result.threadId).toBe("correction-thread");
    expect(result.turnId).toBe("turn-2");
    expect(result.tokens).toBe(scenario === "unknown_first" ? 7 : 32);
    expect(result.usageUnknown).toBe(scenario === "unknown_first");
    const requests = JSON.parse(await readFile(f.requests, "utf8"));
    expect(requests).toHaveLength(2);
    expect(requests[1].threadId).toBe(requests[0].threadId);
    expect(requests[1].outputSchema).toEqual(requests[0].outputSchema);
    expect(requests[1].sandboxPolicy).toEqual({ type: "readOnly" });
    expect(requests[1].input).toHaveLength(1);
    expect(requests[1].input[0].text).toContain("Do not redo implementation");
    expect(requests[1].input[0].text).toContain("fixed verification plan");
    expect(requests[1].input[0].text).not.toContain("private");
    expect(JSON.stringify(result.resultIssues)).not.toContain("private");
  }
});

test("valid Unicode results fit the same bounded capture budget in the adapter and supervisor", async () => {
  const f = await fixture("large_valid");
  const result = await runConversation(f.options);
  expect(result.result.summary.length).toBe(12000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(64000);
  expect(result.tokens).toBe(25);
  expect(result.resultIssues).toBeUndefined();
  expect(JSON.parse(await readFile(f.requests, "utf8"))).toHaveLength(1);
});

test("a second invalid result fails with actionable safe issues and no further turns", async () => {
  const f = await fixture("always_invalid");
  try {
    await runConversation(f.options);
    throw Error("Expected invalid result");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexConversationError);
    const failure = error as CodexConversationError;
    expect(failure.code).toBe("coding_result_invalid");
    expect(failure.tokens).toBe(32);
    expect(failure.usageUnknown).toBe(false);
    expect(failure.resultIssues).toContainEqual({
      path: ["verificationCommands"],
      code: "custom",
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  }
  expect(JSON.parse(await readFile(f.requests, "utf8"))).toHaveLength(2);
});

test("authentication failure during correction preserves usage and sign-in handling", async () => {
  for (const scenario of ["auth", "auth_unknown"]) {
    const f = await fixture(scenario);
    try {
      await runConversation(f.options);
      throw Error("Expected auth failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexAuthError);
      const failure = error as CodexAuthError;
      expect(failure.tokens).toBe(scenario === "auth" ? 32 : 25);
      expect(failure.usageUnknown).toBe(scenario === "auth_unknown");
      expect(JSON.stringify(failure)).not.toContain("private");
    }
    expect(JSON.parse(await readFile(f.requests, "utf8"))).toHaveLength(2);
  }
});

test("cancellation interrupts an in-flight correction", async () => {
  const f = await fixture("cancel"),
    abort = new AbortController();
  const pending = runConversation({ ...f.options, signal: abort.signal });
  const failure = pending.catch((error) => error);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const requests = JSON.parse(
      await readFile(f.requests, "utf8").catch(() => "[]"),
    );
    if (requests.length === 2) break;
    await Bun.sleep(5);
  }
  expect(JSON.parse(await readFile(f.requests, "utf8"))).toHaveLength(2);
  abort.abort();
  expect((await failure).code).toBe("coding_cancelled");
});
