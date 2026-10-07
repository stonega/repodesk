import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConversation } from "../../src/coding/local/conversation.ts";
import {
  CodexConversationError,
  conversationFailureCode,
} from "../../src/coding/local/conversation-failure.ts";

test("safe failure classification distinguishes provider limits, network, schema and sandbox errors", () => {
  expect(
    conversationFailureCode({
      codexErrorInfo: "usageLimitExceeded",
      message: "bearer private-value",
    }),
  ).toBe("coding_provider_usage_limit");
  expect(
    conversationFailureCode({
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
    }),
  ).toBe("coding_provider_rate_limited");
  expect(
    conversationFailureCode({
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } },
    }),
  ).toBe("coding_provider_request_invalid");
  expect(
    conversationFailureCode({ codexErrorInfo: "responseStreamDisconnected" }),
  ).toBe("coding_provider_unavailable");
  expect(conversationFailureCode({ codexErrorInfo: "sandboxError" })).toBe(
    "coding_sandbox_failed",
  );
  expect(
    conversationFailureCode({ codexErrorInfo: "contextWindowExceeded" }),
  ).toBe("coding_context_exceeded");
  expect(
    conversationFailureCode({
      codexErrorInfo: "private-provider-detail",
      message: "token=private-value",
    }),
  ).toBe("coding_conversation_failed");
});

test("failed turns retain safe identities and reported usage; invalid completed output is distinguished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-failure-protocol-"));
  try {
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
rl.on('line',line=>{
 const m=JSON.parse(line); if(m.id==null)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'safe-thread'}}});
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'safe-turn'}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'safe-thread',turnId:'safe-turn',tokenUsage:{last:{totalTokens:234567},total:{totalTokens:234567}}}});
  const scenario=process.env.SCENARIO;
  if(scenario==='provider') {
   const error={codexErrorInfo:'usageLimitExceeded',message:'bearer private-value',additionalDetails:'private prompt'};
   send({method:'error',params:{threadId:'safe-thread',willRetry:false,error}});
   send({method:'turn/completed',params:{threadId:'safe-thread',turn:{id:'safe-turn',status:'failed',error}}});
  } else {
   if(scenario!=='missing')send({method:'item/completed',params:{threadId:'safe-thread',item:{type:'agentMessage',text:scenario==='json'?'private non-JSON output':JSON.stringify({status:'completed'})}}});
   send({method:'turn/completed',params:{threadId:'safe-thread',turn:{id:'safe-turn',status:'completed'}}});
  }
 }
});
`,
    );
    for (const [scenario, code] of [
      ["provider", "coding_provider_usage_limit"],
      ["missing", "coding_result_missing"],
      ["json", "coding_result_json_invalid"],
      ["schema", "coding_result_invalid"],
    ] as const) {
      try {
        await runConversation({
          binary: process.execPath,
          args: [script],
          cwd: dir,
          env: { ...process.env, SCENARIO: scenario },
          prompt: "Fixture",
          timeoutMs: 5000,
        });
        throw new Error("Expected a typed failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexConversationError);
        const failure = error as CodexConversationError;
        expect(failure.code).toBe(code);
        expect(failure.threadId).toBe("safe-thread");
        expect(failure.tokens).toBe(scenario === "provider" ? 234567 : 469134);
        expect(JSON.stringify(failure)).not.toContain("private-value");
        expect(JSON.stringify(failure)).not.toContain("private prompt");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
