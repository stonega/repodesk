import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAuthError,
  codexAuthFailure,
} from "../../src/coding/local/auth-failure.ts";
import { runConversation } from "../../src/coding/local/conversation.ts";

test("Codex authentication classification excludes quota, network and generic script errors", () => {
  expect(codexAuthFailure({ codexErrorInfo: "unauthorized" })).toBe(true);
  expect(
    codexAuthFailure({
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
    }),
  ).toBe(true);
  expect(codexAuthFailure({ message: "refresh_token_reused" })).toBe(true);
  expect(
    codexAuthFailure({
      codexErrorInfo: "other",
      message: "unexpected status 401 Unauthorized: fixture credential denied",
    }),
  ).toBe(true);
  expect(
    codexAuthFailure({
      message:
        "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    }),
  ).toBe(true);
  for (const error of [
    { message: "script failed with HTTP 401 Unauthorized" },
    { codexErrorInfo: "usageLimitExceeded" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
  ])
    expect(codexAuthFailure(error)).toBe(false);
});

test("failed auth turns retain safe usage; transient auth events allow Codex refresh to finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepx-auth-protocol-"));
  try {
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      `
const rl = require('node:readline').createInterface({ input: process.stdin });
let batch;
const send = (v) => {
  const line = JSON.stringify(v)+'\\n';
  if (batch) batch.push(line);
  else process.stdout.write(line);
};
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'auth-thread'}}});
  if (m.method === 'turn/start') {
    // One stdout write deterministically exercises replies and notifications in the same chunk.
    batch = [];
    send({id:m.id,result:{turn:{id:'auth-turn'}}});
    if (process.env.NO_USAGE !== 'yes') send({method:'thread/tokenUsage/updated',params:{threadId:'auth-thread',turnId:'auth-turn',tokenUsage:{last:{totalTokens:7},total:{totalTokens:7}}}});
    if (process.env.PARTIAL === 'yes') send({method:'item/started',params:{threadId:'auth-thread',item:{type:'commandExecution'}}});
    send({method:'error',params:{threadId:'auth-thread',turnId:'auth-turn',willRetry:process.env.RETRY==='yes',error:{codexErrorInfo:'unauthorized'}}});
    if (process.env.RETRY==='yes') {
      send({method:'item/completed',params:{threadId:'auth-thread',item:{type:'agentMessage',text:JSON.stringify({status:'analysis',intent:'analyze',evidenceRevision:1,evidence:'Explain',publishRequested:false,summary:'Explained',question:null,title:'Explain',body:''})}}});
      send({method:'turn/completed',params:{threadId:'auth-thread',turn:{id:'auth-turn',status:'completed'}}});
    } else send({method:'turn/completed',params:{threadId:'auth-thread',turn:{id:'auth-turn',status:'failed',error:{codexErrorInfo:'unauthorized'}}}});
    process.stdout.write(batch.join(''));
    batch = undefined;
  }
});
`,
    );
    const options = {
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...process.env, RETRY: "no" },
      prompt: "Explain",
      timeoutMs: 5000,
    };
    try {
      await runConversation(options);
      throw Error("Expected auth error");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexAuthError);
      const auth = error as CodexAuthError;
      expect(auth.code).toBe("coding_device_auth_required");
      expect(auth.threadId).toBe("auth-thread");
      expect(auth.tokens).toBe(7);
    }
    for (const partial of ["no", "yes"]) {
      try {
        await runConversation({
          ...options,
          env: {
            ...process.env,
            RETRY: "no",
            NO_USAGE: "yes",
            PARTIAL: partial,
          },
        });
        throw Error("Expected auth failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexAuthError);
        expect((error as CodexAuthError).tokens).toBe(
          partial === "yes" ? undefined : 0,
        );
      }
    }
    const result = await runConversation({
      ...options,
      env: { ...process.env, RETRY: "yes" },
    });
    expect(result.result.summary).toBe("Explained");
    expect(result.tokens).toBe(7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
