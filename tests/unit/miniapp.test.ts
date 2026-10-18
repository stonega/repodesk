import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscript,
  readTranscript,
} from "../../src/coding/local/transcript-log.ts";
import {
  codexTranscript,
  transcriptText,
} from "../../src/coding/transcript.ts";
import {
  resolveTaskReference,
  taskReference,
  telegramIdentity,
} from "../../src/miniapp/auth.ts";
import { signedMiniAppData } from "../miniapp-fixture.ts";

const token = "123456:fixture-bot-token";
test("Telegram authentication rejects tampering, duplicates, expired/future launches and another bot", () => {
  const valid = signedMiniAppData(token);
  expect(telegramIdentity(valid, token).actor).toBe("101");
  for (const invalid of [
    valid.replace("101", "202"),
    `${valid}&user=%7B%22id%22%3A202%7D`,
    signedMiniAppData(token, 101, Math.floor(Date.now() / 1000) - 86401),
    signedMiniAppData(token, 101, Math.floor(Date.now() / 1000) + 120),
    "",
  ])
    expect(() => telegramIdentity(invalid, token)).toThrow();
  expect(() => telegramIdentity(valid, "another-bot-token")).toThrow();
});
test("task launch references round-trip without carrying credentials", () => {
  const workspace = "6bbd1001-b0e0-47cb-8552-ddc40a099b0d",
    task = "6bbd1002-b0e0-47cb-8552-ddc40a099b0d";
  expect(resolveTaskReference(taskReference(workspace, task))).toEqual({
    workspaceId: workspace,
    taskId: task,
  });
  expect(() => resolveTaskReference("../private")).toThrow();
});
test("native transcript captures assistant text and bounded activity while excluding reasoning and tool arguments", () => {
  const native = {
    id: "item",
    type: "agentMessage",
    phase: "commentary",
    text: "I’m checking the failing test.",
  };
  expect(codexTranscript("thread", "turn", native)?.text).toBe(native.text);
  expect(
    codexTranscript("thread", "turn", {
      id: "private",
      type: "reasoning",
      content: "hidden",
    }),
  ).toBeUndefined();
  expect(
    codexTranscript("thread", "turn", {
      id: "user",
      type: "userMessage",
      text: "internal prompt",
    }),
  ).toBeUndefined();
  const activity = codexTranscript("thread", "turn", {
    id: "tool",
    type: "mcpToolCall",
    server: "repo",
    tool: "read",
    arguments: { secret: "private" },
    result: { secret: "private" },
  });
  expect(activity?.text).not.toContain("private");
  expect(
    codexTranscript("thread", "turn", { ...native, text: "a".repeat(13000) })
      ?.truncated,
  ).toBe(true);
  expect(
    transcriptText(
      'access_token="secret-value" Bearer abcdefghij sk-abcdefghijklmnop known-sensitive-value',
      ["known-sensitive-value"],
    ),
  ).not.toMatch(/secret-value|abcdefghij|known-sensitive-value/);
});
test("runner history survives reopening and resumes from byte cursors without losing page boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-mini-history-"));
  try {
    const path = join(dir, "history");
    expect((await readTranscript(path)).entries).toHaveLength(0);
    for (let i = 0; i < 70; i++)
      await appendTranscript(path, {
        id: String(i),
        at: new Date().toISOString(),
        role: "codex",
        text: `中文 message ${i}`,
      });
    const first = await readTranscript(path);
    expect(first.entries).toHaveLength(64);
    expect(first.hasMore).toBe(true);
    const next = await readTranscript(path, first.offset);
    expect(next.entries.map((e) => e.id)).toEqual([
      "64",
      "65",
      "66",
      "67",
      "68",
      "69",
    ]);
    expect(next.hasMore).toBe(false);
    expect((await readTranscript(path, next.offset)).entries).toHaveLength(0);
    await appendFile(path, '{"interrupted":');
    await appendTranscript(path, {
      id: "recovered",
      at: new Date().toISOString(),
      role: "codex",
      text: "Recovered after a partial append",
    });
    expect(
      (await readTranscript(path, next.offset)).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual(["recovered"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-server messages are recorded faithfully through the channel and a channel outage preserves the private recovery file", async () => {
  const { runConversation } = await import(
    "../../src/coding/local/conversation.ts"
  );
  const { JobTaskChannel } = await import(
    "../../src/coding/local/job-channel.ts"
  );
  const { readFile, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "repodesk-mini-protocol-"));
  try {
    const result = {
      status: "analysis",
      intent: "analyze",
      evidenceRevision: 1,
      evidence: "inspect",
      publishRequested: false,
      summary: "Found the cause.",
      question: null,
      title: "Investigation",
      body: "Complete",
      verificationCommands: [],
    };
    const script = join(dir, "server.cjs");
    await writeFile(
      script,
      `const rl=require('node:readline').createInterface({input:process.stdin});const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});for(const item of [{id:'one',type:'agentMessage',phase:'commentary',text:'Checking the implementation.'},{id:'private',type:'reasoning',content:'Do not collect this'},{id:'tool',type:'commandExecution',command:'bun test',status:'completed',aggregatedOutput:'12 passed'},{id:'final',type:'agentMessage',phase:'final_answer',text:${JSON.stringify(JSON.stringify(result))}}])send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});}});`,
    );
    const recorded: unknown[] = [];
    const channel = new JobTaskChannel(
      "http://fixture",
      "fixture-channel-token",
      (async (_url, init) => {
        if (!init?.body) return Response.json([]);
        recorded.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }) as typeof fetch,
    );
    const completed = await runConversation({
      binary: process.execPath,
      args: [script],
      cwd: dir,
      env: { ...process.env },
      prompt: "inspect",
      channel,
      timeoutMs: 5000,
    });
    expect(completed.result.summary).toBe("Found the cause.");
    expect(recorded).toHaveLength(3);
    expect(JSON.stringify(recorded)).not.toContain("Do not collect this");
    expect(JSON.stringify(recorded)).toContain("Checking the implementation.");
    const path = join(dir, "recovery.jsonl");
    const offline = new JobTaskChannel(
      "http://offline",
      "fixture-channel-token",
      (async () => {
        throw Error("offline");
      }) as unknown as typeof fetch,
      path,
    );
    offline.record({
      id: "native",
      at: new Date().toISOString(),
      role: "codex",
      text: "Still captured while offline",
    });
    await offline.flushTranscript();
    expect(await readFile(path, "utf8")).toContain(
      "Still captured while offline",
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const pendingPath = join(dir, "pending.jsonl");
    const pending = new JobTaskChannel(
      "http://pending",
      "fixture-channel-token",
      (async () => {
        if (++sends === 1) await gate;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
      pendingPath,
    );
    for (const id of ["first", "second"])
      pending.record({
        id,
        at: new Date().toISOString(),
        role: "codex",
        text: id,
      });
    let saved = "";
    try {
      for (let i = 0; i < 100; i++) {
        saved = await readFile(pendingPath, "utf8").catch(() => "");
        if (saved.includes("second")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(saved).toContain("second");
    } finally {
      release();
      await pending.flushTranscript();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
