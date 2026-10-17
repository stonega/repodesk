import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationPage,
  type TaskConversation,
} from "../../src/coding/conversation.ts";
import type { DevelopmentResult } from "../../src/coding/development.ts";
import { runConversation } from "../../src/coding/local/conversation.ts";
import { JobTaskChannel } from "../../src/coding/local/job-channel.ts";
import {
  applyChannelEvent,
  closeMailbox,
  enqueueMessage,
} from "../../src/coding/local/mailbox.ts";

test("message receipts distinguish queue, acceptance, reading and answers; duplicates do not replay", () => {
  const mailbox: TaskConversation = { messages: [] },
    id = randomUUID(),
    sessionId = randomUUID();
  const message = { id, question: "Why is this implementation necessary?" };
  enqueueMessage(mailbox, message);
  enqueueMessage(mailbox, message);
  expect(mailbox.messages).toHaveLength(1);
  expect(() =>
    enqueueMessage(mailbox, { ...message, question: "Another goal" }),
  ).toThrow("coding_message_conflict");
  applyChannelEvent(mailbox, { action: "claim", id, sessionId });
  expect(mailbox.messages[0]?.state).toBe("dispatching");
  expect(() =>
    applyChannelEvent(mailbox, { action: "read", id, sessionId: randomUUID() }),
  ).toThrow("coding_message_session_changed");
  applyChannelEvent(mailbox, { action: "accepted", id, sessionId });
  expect(mailbox.messages[0]?.state).toBe("accepted");
  applyChannelEvent(mailbox, { action: "read", id, sessionId });
  expect(mailbox.messages[0]?.state).toBe("read");
  applyChannelEvent(mailbox, {
    action: "answer",
    id,
    sessionId,
    text: "The previous path dropped events.",
  });
  applyChannelEvent(mailbox, { action: "accepted", id, sessionId });
  applyChannelEvent(mailbox, {
    action: "answer",
    id,
    sessionId,
    text: "The previous path dropped events.",
  });
  expect(mailbox.messages[0]?.state).toBe("answered");
  expect(() =>
    applyChannelEvent(mailbox, {
      action: "answer",
      id,
      sessionId,
      text: "Different answer",
    }),
  ).toThrow("coding_message_conflict");
});

test("only definitely unsteered claims can be released; uncertain delivery is not replayed", () => {
  const mailbox: TaskConversation = { messages: [] },
    sessionId = randomUUID();
  const unsent = { id: randomUUID(), question: "Pending?" },
    uncertain = { id: randomUUID(), question: "Read?" };
  enqueueMessage(mailbox, unsent);
  enqueueMessage(mailbox, uncertain);
  applyChannelEvent(mailbox, { action: "claim", id: unsent.id, sessionId });
  applyChannelEvent(mailbox, { action: "release", id: unsent.id, sessionId });
  applyChannelEvent(mailbox, { action: "claim", id: uncertain.id, sessionId });
  closeMailbox(mailbox);
  expect(mailbox.messages.map((m) => m.state)).toEqual(["queued", "unknown"]);
  expect(() =>
    applyChannelEvent(mailbox, {
      action: "claim",
      id: uncertain.id,
      sessionId,
    }),
  ).toThrow("coding_message_closed");
  closeMailbox(mailbox, true);
  expect(mailbox.messages[0]?.state).toBe("cancelled");
});

const dirs: string[] = [];
test("lost mailbox acknowledgements retry one claim and answer without delivering the question twice", async () => {
  const mailbox: TaskConversation = { messages: [] },
    message = { id: randomUUID(), question: "What changed?" };
  enqueueMessage(mailbox, message);
  let claimAttempts = 0,
    answerAttempts = 0;
  const channel = new JobTaskChannel(
    "http://channel.test",
    "private-attempt",
    (async (url, init) => {
      if (String(url).endsWith("/inbox"))
        return Response.json(
          mailbox.messages
            .filter((m) => m.state === "queued")
            .map(({ id, question }) => ({ id, question })),
        );
      const event = JSON.parse(String(init?.body));
      applyChannelEvent(mailbox, event);
      if (event.action === "claim" && ++claimAttempts === 1)
        throw new TypeError("Connection reset after commit");
      if (event.action === "answer" && ++answerAttempts === 1)
        throw new TypeError("Connection reset after commit");
      return Response.json({ ok: true });
    }) as typeof fetch,
  );
  expect(await channel.pull()).toEqual([message]);
  expect(await channel.pull()).toEqual([]);
  await channel.accepted([message]);
  const result = await channel.handle("answer", "repodesk_task_reply", {
    messageId: message.id,
    text: "The cursor ordering.",
  });
  expect(result).toMatchObject({ success: true });
  expect(mailbox.messages).toHaveLength(1);
  expect(mailbox.messages[0]?.state).toBe("answered");
  expect(claimAttempts).toBe(2);
  expect(answerAttempts).toBe(2);
});
test("conversation history pages are bounded even when tool arguments bypass their advertised schema", () => {
  expect(conversationPage.parse({})).toEqual({ offset: 0, limit: 20 });
  for (const value of [
    { limit: 1000 },
    { limit: -1 },
    { offset: -1 },
    { offset: 101 },
    { limit: "20" },
  ])
    expect(conversationPage.safeParse(value).success).toBe(false);
});
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const finalResult: DevelopmentResult = {
  status: "completed",
  intent: "implement",
  evidenceRevision: 1,
  evidence: "Fix the card",
  publishRequested: false,
  summary: "Card fixed",
  question: null,
  title: "Fix card",
  body: "Checked",
  verificationCommands: ["bun test"],
};

async function protocolFixture(scenario: "initial" | "live" | "lost_ack") {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-task-conversation-"));
  dirs.push(dir);
  const script = join(dir, "server.cjs"),
    requests = join(dir, "requests.json");
  const message = {
    id: randomUUID(),
    question: "Why did you change the card?",
  };
  const mailbox: TaskConversation = { messages: [] };
  const events: string[] = [];
  let polls = 0;
  const channel = new JobTaskChannel(
    "http://channel.test",
    "attempt-only-token",
    (async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer attempt-only-token",
      );
      expect(init?.redirect).toBe("error");
      if (String(url).endsWith("/inbox")) {
        polls++;
        if (
          (scenario === "initial" && polls === 1) ||
          (scenario !== "initial" && polls === 2)
        )
          enqueueMessage(mailbox, message);
        return Response.json(
          mailbox.messages
            .filter((m) => m.state === "queued")
            .map(({ id, question }) => ({ id, question })),
        );
      }
      const event = JSON.parse(String(init?.body));
      events.push(event.action);
      applyChannelEvent(mailbox, event);
      return Response.json({ ok: true });
    }) as typeof fetch,
  );
  await writeFile(
    script,
    `
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const calls=[];const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const message=${JSON.stringify(message)},scenario=${JSON.stringify(scenario)};
const params={threadId:'task-thread',turnId:'task-turn'};
function read(){send({id:101,method:'item/tool/call',params:{...params,callId:'read-call',tool:'repodesk_task_read',arguments:{messageId:message.id}}});}
function done(){send({method:'item/completed',params:{...params,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(${JSON.stringify(finalResult)})}}});send({method:'turn/completed',params:{threadId:'task-thread',turn:{id:'task-turn',status:'completed'}}});}
rl.on('line',line=>{const m=JSON.parse(line); calls.push(m);fs.writeFileSync(${JSON.stringify(requests)},JSON.stringify(calls));
 if(m.method==='initialize'){if(!m.params.capabilities.experimentalApi)throw Error('Tools must be negotiated');send({id:m.id,result:{}});}
 if(m.method==='thread/start'){if(m.params.dynamicTools.length!==3)throw Error('Missing conversation tools');send({id:m.id,result:{thread:{id:'task-thread'}}});}
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'task-turn'}}});if(scenario==='initial')read();}
 if(m.method==='turn/steer'){if(m.params.expectedTurnId!=='task-turn'||!m.params.input[0].text.includes(message.id))throw Error('Unbound steer');if(scenario==='lost_ack'){setTimeout(done,20);return;}send({id:m.id,result:{turnId:'task-turn'}});read();}
 if(m.id===101&&!m.method){if(!m.result.success)throw Error('Read failed');send({id:102,method:'item/tool/call',params:{...params,callId:'answer-call',tool:'repodesk_task_reply',arguments:{messageId:message.id,text:'It preserves the original event order.'}}});}
 if(m.id===102&&!m.method){if(!m.result.success)throw Error('Answer failed');send({id:103,method:'item/tool/call',params:{...params,callId:'answer-call',tool:'repodesk_task_reply',arguments:{messageId:message.id,text:'It preserves the original event order.'}}});}
 if(m.id===103&&!m.method){send({id:104,method:'item/tool/call',params:{...params,threadId:'other-thread',callId:'foreign-call',tool:'repodesk_task_reply',arguments:{messageId:message.id,text:'Foreign answer'}}});}
 if(m.id===104&&!m.method){if(!m.error)throw Error('Foreign thread must be rejected');done();}
});`,
  );
  return {
    mailbox,
    events,
    requests,
    options: {
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: { PATH: process.env.PATH },
      prompt: "Fix the card",
      channel,
      timeoutMs: 6000,
    },
  };
}

for (const scenario of ["initial", "live"] as const)
  test(`Codex ${scenario} task questions receive real acknowledgements and answers without ending work`, async () => {
    const f = await protocolFixture(scenario);
    const result = await runConversation(f.options);
    expect(result.result).toEqual(finalResult);
    expect(f.mailbox.messages[0]).toMatchObject({
      state: "answered",
      answer: "It preserves the original event order.",
    });
    expect(f.events.filter((e) => e === "claim")).toHaveLength(1);
    expect(f.events.filter((e) => e === "answer")).toHaveLength(1);
    const requests = JSON.parse(await readFile(f.requests, "utf8"));
    expect(
      requests.filter((r: { method?: string }) => r.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      requests.filter((r: { method?: string }) => r.method === "turn/steer"),
    ).toHaveLength(scenario === "live" ? 1 : 0);
  });

test("a lost native steering acknowledgement remains uncertain and is not sent twice", async () => {
  const f = await protocolFixture("lost_ack");
  await runConversation(f.options);
  closeMailbox(f.mailbox);
  expect(f.mailbox.messages[0]?.state).toBe("unknown");
  const requests = JSON.parse(await readFile(f.requests, "utf8"));
  expect(
    requests.filter((r: { method?: string }) => r.method === "turn/steer"),
  ).toHaveLength(1);
});
