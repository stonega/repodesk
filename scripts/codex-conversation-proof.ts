// Pinned real app-server, local fake provider and channel. No account or model calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  channelEvent,
  type TaskConversation,
} from "../src/coding/conversation.ts";
import { runConversation } from "../src/coding/local/conversation.ts";
import { JobTaskChannel } from "../src/coding/local/job-channel.ts";
import {
  applyChannelEvent,
  enqueueMessage,
} from "../src/coding/local/mailbox.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "repodesk-channel-proof-"));
const first = {
  id: randomUUID(),
  question: "Why was the page cursor changed?",
};
const late = {
  id: randomUUID(),
  question: "Which check verifies the ordering?",
};
const mailbox: TaskConversation = { messages: [] };
enqueueMessage(mailbox, first);
let calls = 0,
  toolsSeen = false,
  liveInputSeen = false;
const toolNames: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/conversation/")) {
      if (request.headers.get("authorization") !== "Bearer proof-task-channel")
        return new Response(null, { status: 401 });
      if (path.endsWith("/inbox"))
        return Response.json(
          mailbox.messages
            .filter((m) => m.state === "queued")
            .map(({ id, question }) => ({ id, question })),
        );
      applyChannelEvent(mailbox, channelEvent.parse(await request.json()));
      return Response.json({ ok: true });
    }
    if (!path.endsWith("/responses"))
      return new Response(null, { status: 404 });
    const body = await request.json();
    calls++;
    if (calls > 12) return new Response(null, { status: 400 });
    const names = (body.tools ?? [])
      .flatMap((t: { name?: string; tools?: { name: string }[] }) => [
        t.name,
        ...(t.tools ?? []).map((n) => n.name),
      ])
      .filter(Boolean);
    toolsSeen ||= names.some((name: string) =>
      name.includes("repodesk_task_reply"),
    );
    if (calls === 4) {
      enqueueMessage(mailbox, late);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (calls >= 5)
      liveInputSeen ||= JSON.stringify(body.input).includes(late.id);
    const selected =
      calls === 1
        ? { name: "repodesk_task_read", arguments: { messageId: first.id } }
        : calls === 2
          ? {
              name: "repodesk_task_reply",
              arguments: {
                messageId: first.id,
                text: "It preserves the next-page cursor.",
              },
            }
          : calls === 3 || calls === 4 || calls === 8
            ? {
                name: "repodesk_task_progress",
                arguments: { text: "Verifying pagination ordering." },
              }
            : calls === 5
              ? {
                  name: "repodesk_task_read",
                  arguments: { messageId: late.id },
                }
              : calls === 6
                ? {
                    name: "repodesk_task_reply",
                    arguments: {
                      messageId: late.id,
                      text: "The pagination ordering regression test.",
                    },
                  }
                : undefined;
    const text = JSON.stringify({
      status: "analysis",
      intent: "analyze",
      evidenceRevision: 1,
      evidence: "Explain the task",
      publishRequested: false,
      summary: "Task questions answered; no repository changes.",
      question: null,
      title: "Task conversation proof",
      body: "Local fake provider only",
      verificationCommands: [],
    });
    const item = selected
      ? {
          type: "function_call",
          id: `fc_${calls}`,
          call_id: `call_${calls}`,
          name: selected.name,
          arguments: JSON.stringify(selected.arguments),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${calls}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
    if (selected) toolNames.push(selected.name);
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
        item: {
          ...item,
          status: "in_progress",
          ...(selected ? { arguments: "" } : { content: [] }),
        },
      },
      ...(selected
        ? [
            {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
          ]
        : [
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
              part: { type: "output_text", text, annotations: [] },
            },
          ]),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
try {
  const home = join(root, "codex"),
    repo = join(root, "repo");
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
    prompt:
      "Explain the task. No code changes. Answer task conversation questions with the supplied tools.",
    readOnly: true,
    timeoutMs: 30000,
    channel: new JobTaskChannel(
      `http://127.0.0.1:${server.port}`,
      "proof-task-channel",
    ),
  };
  const result = await runConversation(options);
  if (
    !toolsSeen ||
    !liveInputSeen ||
    mailbox.messages.length !== 2 ||
    mailbox.messages.some((m) => m.state !== "answered") ||
    !mailbox.progress ||
    result.result.status !== "analysis"
  )
    throw Error(
      `Task conversation protocol proof failed: ${JSON.stringify({ toolsSeen, liveInputSeen, calls, toolNames, states: mailbox.messages.map((m) => m.state) })}`,
    );
  const progressId = mailbox.progress.id;
  const resumed = await runConversation({
    ...options,
    threadId: result.threadId,
    channel: new JobTaskChannel(
      `http://127.0.0.1:${server.port}`,
      "proof-task-channel",
    ),
  });
  if (
    resumed.threadId !== result.threadId ||
    resumed.reconstructed ||
    mailbox.progress.id === progressId ||
    calls !== 9
  )
    throw Error(
      "Conversation tools were not restored by the pinned app-server on resume",
    );
  console.log(
    JSON.stringify({
      codexProtocol: "0.155.1",
      tools: true,
      initialQuestion: true,
      liveSteering: true,
      readReceipts: true,
      replies: true,
      progress: true,
      resume: true,
      calls,
      tokens: result.tokens,
      usageUnknown: result.usageUnknown,
    }),
  );
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
