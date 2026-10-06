// Local fake Responses endpoint + the pinned real Codex app-server. No live model calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { developmentSchema } from "../src/coding/development.ts";
import { CodexAuthError } from "../src/coding/local/auth-failure.ts";
import { runConversation } from "../src/coding/local/conversation.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "repodesk-protocol-"));
let calls = 0;
let rejectAuth = false;
let intakeSchemaReceived = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (!new URL(request.url).pathname.endsWith("/responses"))
      return new Response("unsupported", { status: 404 });
    if (rejectAuth)
      return Response.json(
        {
          error: {
            message: "Invalid fixture account credential",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      );
    const body = await request.json();
    calls++;
    if (calls === 1) {
      const schema = body.text?.format?.schema;
      intakeSchemaReceived =
        JSON.stringify(schema?.properties.status.enum) ===
          JSON.stringify(["intent", "needs_input"]) &&
        JSON.stringify(schema?.properties.evidenceRevision.enum) === "[2]" &&
        JSON.stringify(schema?.properties.evidence.enum) === '["Try again"]';
    }
    const text = JSON.stringify({
      status:
        calls === 1 ? "intent" : calls === 2 ? "needs_input" : "completed",
      intent: "implement",
      evidenceRevision: calls === 1 ? 2 : 1,
      evidence:
        calls === 1 ? "Try again" : "Fix pagination and open a draft PR",
      publishRequested: true,
      summary: "Local protocol fixture completed.",
      question: calls === 2 ? "Should empty results keep page one?" : null,
      title: "Fix pagination",
      body: "Local fixture only.",
      verificationCommands: calls > 2 ? ["git diff --check"] : [],
    });
    const item = {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const response = {
      id: "resp_fixture",
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
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
try {
  const home = join(root, "codex");
  const repo = join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  await exec("git", ["init", repo]);
  await writeFile(
    join(home, "config.toml"),
    `model="gpt-5.4"\nmodel_provider="fixture"\napproval_policy="never"\n[model_providers.fixture]\nname="Local proof"\nbase_url="http://127.0.0.1:${server.port}/v1"\nwire_api="responses"\nsupports_websockets=false\n`,
  );
  const options = {
    binary: process.env.CODEX_PROTOCOL_BINARY ?? "bunx",
    args: process.env.CODEX_PROTOCOL_BINARY
      ? ["app-server"]
      : ["--package", "@openai/codex@0.155.1", "codex", "app-server"],
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
    prompt: "Return only the fixture JSON.",
    timeoutMs: 30000,
    readOnly: true,
  };
  const first = await runConversation({
    ...options,
    outputSchema: developmentSchema({
      taskId: randomUUID(),
      revision: 2,
      mode: "intake",
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "request",
          text: "Fix pagination and open a draft PR",
          kind: "request",
        },
        {
          revision: 2,
          actor: "101",
          sourceId: "retry",
          text: "Try again",
          kind: "followup",
        },
      ],
      context:
        "Earlier messages explain the retry but do not replace its evidence.",
    }),
  });
  const question = await runConversation({
    ...options,
    threadId: first.threadId,
  });
  const answer = await runConversation({
    ...options,
    threadId: question.threadId,
    prompt: "Yes, keep page one.",
  });
  if (
    first.result.status !== "intent" ||
    !intakeSchemaReceived ||
    first.result.evidenceRevision !== 2 ||
    first.result.evidence !== "Try again" ||
    question.result.status !== "needs_input" ||
    answer.result.status !== "completed" ||
    answer.threadId !== first.threadId ||
    calls !== 3
  )
    throw new Error("Protocol contract failed");
  const reconstructed = await runConversation({
    ...options,
    threadId: "00000000-0000-0000-0000-000000000000",
  });
  if (
    !reconstructed.reconstructed ||
    reconstructed.threadId === first.threadId ||
    first.tokens !== 20 ||
    question.tokens !== 20 ||
    answer.tokens !== 20
  )
    throw new Error(
      `Recovery or token accounting failed: ${JSON.stringify({ reconstructed: reconstructed.reconstructed, same: reconstructed.threadId === first.threadId, tokens: [first.tokens, question.tokens, answer.tokens] })}`,
    );
  rejectAuth = true;
  try {
    await runConversation(options);
    throw new Error("Authentication failure was not surfaced");
  } catch (error) {
    if (!(error instanceof CodexAuthError) || error.tokens !== 0)
      throw new Error("Authentication protocol contract failed");
  }
  rejectAuth = false;
  const abort = new AbortController();
  abort.abort();
  try {
    await runConversation({ ...options, signal: abort.signal });
    throw new Error("Abort was ignored");
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "coding_cancelled"
      )
    )
      throw error;
  }
  console.log(
    "Pinned Codex protocol: constrained intake evidence, start, structured question, resume, missing-session reconstruction, token accounting, authentication failure and cancellation passed (local fake provider).",
  );
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
