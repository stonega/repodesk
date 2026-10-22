// Run the bundled script inside the codex-job image with --network=none.
// The pinned app-server uses a local fake provider; no account/model/GitHub calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  developmentPrompt,
  developmentSchema,
} from "../src/coding/development.ts";
import { runConversation } from "../src/coding/local/conversation.ts";
import { ReviewSource } from "../src/coding/local/review-source.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "repodesk-review-proof-"));
const repo = join(root, "repo"),
  home = "/task/codex";
const env = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = async (...args: string[]) =>
  (await exec("git", args, { cwd: repo, env })).stdout.trim();
let calls = 0;
const outputs: string[] = [];
const actions = [
  { action: "plan" },
  { action: "commits" },
  { action: "read", path: "example.ts" },
  { action: "diff", path: "example.ts" },
  { action: "list" },
  { action: "read", path: "/task/codex/auth.json" },
  { action: "read", path: "/proc/self/environ" },
  { action: "done" },
  { action: "read", path: "example.ts" },
  { action: "done" },
];
const server = createServer(async (request, responseStream) => {
  try {
    assert.ok(request.url?.endsWith("/responses"));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const names = (body.tools ?? [])
      .flatMap((tool: { name?: string; tools?: { name: string }[] }) => [
        tool.name,
        ...(tool.tools ?? []).map((t) => t.name),
      ])
      .filter(Boolean);
    assert.ok(names.includes("repodesk_review_source"), JSON.stringify(names));
    assert.ok(
      !names.some((name: string) =>
        [
          "exec_command",
          "shell",
          "shell_command",
          "local_shell",
          "write_stdin",
          "view_image",
          "spawn_agent",
        ].includes(name),
      ),
      JSON.stringify(names),
    );
    outputs.push(JSON.stringify(body.input));
    const action = actions[calls++];
    assert.ok(action, "Unexpected additional model request");
    const text = JSON.stringify({
      status: "analysis",
      intent: "analyze",
      evidenceRevision: 1,
      evidence: "Review this pull request.",
      publishRequested: false,
      summary: "Reviewed example.ts and its OCR rules. One concrete finding.",
      question: null,
      title: "Review fixture",
      body: "",
      verificationCommands: [],
      reviewFindings: [
        {
          axis: "standards",
          path: "example.ts",
          line: 1,
          side: "RIGHT",
          severity: "medium",
          body: "Fixture finding.",
        },
      ],
    });
    const item =
      action.action === "done"
        ? {
            type: "message",
            id: `msg_${calls}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          }
        : {
            type: "function_call",
            id: `fc_${calls}`,
            call_id: `call_${calls}`,
            name: "repodesk_review_source",
            arguments: JSON.stringify(action),
            status: "completed",
          };
    const response = {
      id: `resp_${calls}`,
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.4",
      output: [item],
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    responseStream.writeHead(200, { "content-type": "text/event-stream" });
    responseStream.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  } catch (error) {
    responseStream.writeHead(500);
    responseStream.end();
    console.error(error);
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  await mkdir(repo);
  await mkdir(home, { recursive: true });
  await git("init", "-q");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "example.ts"), "export const total = 1;\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const baseSha = await git("rev-parse", "HEAD");
  await writeFile(join(repo, "example.ts"), "export const total = 2;\n");
  await git("add", ".");
  await git("commit", "-qm", "head");
  const headSha = await git("rev-parse", "HEAD");
  // Real pinned OCR preparation, no fake review engine.
  const { prepareOpenCodeReview } = await import(
    "../src/coding/local/open-code-review.ts"
  );
  const plan = await prepareOpenCodeReview(
    { baseSha, headSha },
    async (args) =>
      (await exec("ocr", args, { cwd: repo, env, maxBuffer: 6 * 1024 * 1024 }))
        .stdout,
  );
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const review = { number: 1, baseSha, headSha, action: "review" as const };
  const source = await ReviewSource.create(repo, review, planPath);
  await writeFile(join(home, "auth.json"), "proof-credential-never-read");
  await writeFile(
    join(home, "config.toml"),
    `model="gpt-5.4"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\n`,
  );
  const run = {
    taskId: "00000000-0000-4000-8000-000000000002",
    revision: 1,
    mode: "analysis" as const,
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "fixture",
        text: "Review this pull request.",
        kind: "request" as const,
      },
    ],
    context: "",
    review,
  };
  const options = {
    cwd: repo,
    env: { PATH: env.PATH, HOME: root, CODEX_HOME: home },
    prompt: developmentPrompt(run),
    outputSchema: developmentSchema(run),
    readOnly: true,
    protectCredentials: true,
    reviewSource: source,
    timeoutMs: 30000,
  };
  const result = await runConversation(options);
  assert.equal(result.result.status, "analysis");
  assert.equal(result.result.reviewFindings?.length, 1);
  assert.equal(result.result.reviewFindings?.[0]?.axis, "standards");
  assert.ok(outputs.some((output) => output.includes("ruleGroups")));
  assert.ok(
    outputs.some((output) => output.includes(`commit ${review.headSha}`)),
  );
  assert.ok(
    outputs.some((output) => output.includes("Review source unavailable")),
  );
  assert.ok(
    outputs.some((output) => output.includes("export const total = 2")),
  );
  assert.ok(
    outputs.some((output) =>
      output.includes("diff --git a/example.ts b/example.ts"),
    ),
  );
  assert.ok(
    outputs.every((output) => !output.includes("proof-credential-never-read")),
  );
  assert.equal(
    await readFile(join(repo, "example.ts"), "utf8"),
    "export const total = 2;\n",
  );
  const resumed = await runConversation({
    ...options,
    threadId: result.threadId,
  });
  assert.equal(resumed.threadId, result.threadId);
  assert.equal(resumed.reconstructed, false);
  assert.equal(resumed.result.status, "analysis");
  assert.equal(calls, actions.length);
  console.log(
    "Review source proof passed: real OCR, pinned app-server start/resume, source/diff/plan tools, native shell disabled, no credential reads or repository writes.",
  );
} finally {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
}
