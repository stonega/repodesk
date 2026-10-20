import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConversation } from "../../src/coding/local/conversation.ts";

async function captureConversation(options: {
  readOnly?: boolean;
  protectCredentials?: boolean;
  threadId?: string;
  reviewSource?: {
    handle(value: unknown): Promise<{
      success: boolean;
      contentItems: { type: string; text: string }[];
    }>;
  };
}) {
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
else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'review-thread'}}});
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
      ...options,
    });
    expect(outcome.result.summary).toBe("No supported findings.");
    const requests = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    return requests;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ordinary read-only and work sessions select container-compatible isolation across new and resumed sessions", async () => {
  for (const readOnly of [true, false])
    for (const threadId of [undefined, "review-thread"]) {
      const requests = await captureConversation({ readOnly, threadId });
      const start = requests.find((r) =>
        ["thread/start", "thread/resume"].includes(r.method),
      );
      expect(start.params.sandbox).toBe(
        readOnly ? "read-only" : "danger-full-access",
      );
      expect(start.params.config.features.use_legacy_landlock).toBe(true);
    }
});

test("PR analysis pins credential-denying filesystem and clean shell policies without a legacy override", async () => {
  for (const threadId of [undefined, "review-thread"]) {
    const requests = await captureConversation({
      readOnly: true,
      protectCredentials: true,
      threadId,
    });
    const start = requests.find((r) =>
      ["thread/start", "thread/resume"].includes(r.method),
    );
    expect(start.params.sandbox).toBeUndefined();
    expect(start.params.config.features?.use_legacy_landlock).toBeUndefined();
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
  }
});

test("review source tools disable native shell access and preserve credential-denying policy on start and resume", async () => {
  for (const threadId of [undefined, "review-thread"]) {
    const requests = await captureConversation({
      readOnly: true,
      protectCredentials: true,
      threadId,
      reviewSource: {
        handle: async () => ({ success: true, contentItems: [] }),
      },
    });
    const start = requests.find((r) =>
      ["thread/start", "thread/resume"].includes(r.method),
    );
    expect(start.params.config.features.shell_tool).toBe(false);
    expect(start.params.config.features.view_image).toBe(false);
    expect(start.params.config.features.multi_agent).toBe(false);
    expect(start.params.config.filesystem["/auth"]).toBe("deny");
    expect(start.params.config.filesystem["/proc"]).toBe("deny");
    expect(Object.values(start.params.config.projects)).toEqual([
      { trust_level: "untrusted" },
    ]);
    if (!threadId)
      expect(
        start.params.dynamicTools.map((tool: { name: string }) => tool.name),
      ).toEqual(["repodesk_review_source"]);
    expect(
      requests.find((r) => r.method === "initialize").params.capabilities
        .experimentalApi,
    ).toBe(true);
  }
});
