import {
  type Deployment,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import type { Message, Update } from "../telegram/router.ts";
import { runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { browserReadAllowed } from "./privacy.ts";

const active = (run: Run) =>
  ["queued", "running", "awaiting_approval"].includes(run.status);
const expired = (run: Run) =>
  run.status === "partial" &&
  ["browser_request_expired", "browser_input_expired"].includes(
    run.error ?? "",
  );

/** Only current, private, same-audience Browser work participates in coordination. */
export function browserTaskRuns(
  w: Workspace,
  actor: string,
  topicId: number,
  botId: string,
) {
  return w.runs.filter(
    (run) =>
      run.actor === actor &&
      run.chatId === actor &&
      run.topicId === topicId &&
      run.browserRead?.botId === botId &&
      (run.browserTask ||
        run.browserWait ||
        run.browserResumed?.length ||
        Object.values(run.tools).some((tool) =>
          ["browser_session", "browser_action"].includes(tool.name),
        )) &&
      !run.cancelled &&
      !run.workflowId &&
      !run.codingTaskId &&
      !run.browserObserverOf &&
      runAllowed(w, run) &&
      browserReadAllowed(w, run, botId),
  );
}

export function activeBrowserTask(
  w: Workspace,
  actor: string,
  topicId: number,
  botId: string,
) {
  return browserTaskRuns(w, actor, topicId, botId).find(active);
}

function safeOrigin(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return;
  }
}

export function browserWaitText(wait: NonNullable<Run["browserWait"]>) {
  const origin = safeOrigin(wait.origin);
  const destination = origin ? ` on ${origin}` : "";
  if (wait.kind === "site")
    return `Browser needs your permission to access${origin ? ` ${origin}` : " this website"}. Open Browser and choose Allow website.`;
  if (wait.kind === "input")
    return `Browser needs private input${destination}. Open Browser to enter it securely; do not send passwords or codes in chat.`;
  if (wait.kind === "control")
    return "This task is waiting for browser control. Open Browser to review the current controller and the requested handoff.";
  const operation =
    {
      click: "click a control",
      pointer: "click the reviewed position",
      fill: "fill a field",
      press: "press a key",
    }[wait.operation ?? ""] ?? "perform the reviewed action";
  return `Browser needs your approval to ${operation}${destination}. Open Browser to review and approve this action.`;
}

export function browserTaskSnapshot(run: Run) {
  return {
    runId: run.id,
    status: run.status,
    ...(run.browserWait
      ? {
          waiting: {
            id: run.browserWait.id,
            kind: run.browserWait.kind,
            origin: safeOrigin(run.browserWait.origin),
            operation: run.browserWait.operation,
            expiresAt: run.browserWait.expiresAt,
          },
        }
      : {}),
  };
}

export function browserTaskStatus(run: Run, now = Date.now()) {
  if (run.browserWait) {
    if (run.browserWait.expiresAt <= now)
      return "The Browser request has expired. This task cannot continue with that approval; ask me to try again to review a fresh request.";
    return `${browserWaitText(run.browserWait)} Work continues in the same task after the required decision or input; sending “continue” does not approve it.`;
  }
  if (expired(run))
    return "The Browser request expired, so this attempt stopped. Say “continue” or “try again” to resume the original task from its saved context with fresh approval where needed.";
  if (run.status === "awaiting_approval")
    return "Your task is waiting for another approval. Review its current request before it can continue.";
  if (run.status === "succeeded")
    return "The browser task has finished. See its final response in this conversation for the confirmed result.";
  if (["partial", "failed"].includes(run.status))
    return "The browser task stopped before completion. Its saved outcome needs review before another attempt.";
  return run.status === "queued"
    ? "Your browser task is queued to continue from its saved context. You do not need to start it again."
    : "Your browser task is working. I’ll continue the same task and report its result or the next decision it needs.";
}

function shortControl(text: string) {
  const value = text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
  if (
    /^(?:status|progress|any (?:progress|updates?)|what(?:'s| is) (?:the )?(?:current )?(?:status|progress)|how(?:'s| is) it going|进度(?:如何|怎么样|呢)?|進度(?:如何|怎麼樣|呢)?|有(?:进展|進展|更新)(?:吗|嗎)?)$/u.test(
      value,
    )
  )
    return "status";
  if (
    /^(?:continue|go on|carry on|resume(?: (?:the |this )?task)?|retry|try again|继续|繼續|重试(?:下|一下)?|重試(?:下|一下)?|再试一次|再試一次)$/u.test(
      value,
    )
  )
    return "continue";
}

function references(w: Workspace, run: Run, messageId: number) {
  return (
    run.replyTo === messageId ||
    w.deliveries.some(
      (d) =>
        d.runId === run.id &&
        d.actor === run.actor &&
        d.chatId === run.chatId &&
        d.topicId === run.topicId &&
        d.remoteId === messageId,
    ) ||
    w.messages.some(
      (source) =>
        source.runId === run.id &&
        source.author === run.actor &&
        source.id.endsWith(`:${messageId}`),
    )
  );
}

/** A short control is an authenticated task input, never website authorization. */
export function browserTaskControl(
  w: Workspace,
  update: Update,
  deployment: Deployment,
  msg: Message,
  cmd?: { name: string; args: string },
) {
  if (
    msg.chat.type !== "private" ||
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_chat ||
    msg.forward_origin ||
    msg.photo ||
    msg.document ||
    msg.voice ||
    msg.audio ||
    !deployment.bot ||
    String(msg.chat.id) !== String(msg.from.id) ||
    !msg.text ||
    !cmd ||
    !["ask", "status"].includes(cmd.name) ||
    (cmd.name === "status" && !!cmd.args)
  )
    return false;
  const intent = cmd.name === "status" ? "status" : shortControl(cmd.args);
  if (!intent) return false;
  const actor = String(msg.from.id);
  const candidates = browserTaskRuns(
    w,
    actor,
    msg.message_thread_id ?? 0,
    deployment.bot.id,
  ).filter(
    (run) =>
      (active(run) || expired(run) || intent === "status") &&
      (!msg.reply_to_message ||
        references(w, run, msg.reply_to_message.message_id)),
  );
  const run = candidates.find(active) ?? candidates.at(-1);
  if (!run) return false;
  const latest = w.runs.findLast(
    (r) =>
      r.actor === actor &&
      r.chatId === actor &&
      r.topicId === run.topicId &&
      !r.workflowId &&
      !r.codingTaskId &&
      !r.browserObserverOf &&
      (r.browserRead?.botId === deployment.bot?.id ||
        w.threads?.some(
          (t) => t.id === r.threadId && t.botId === deployment.bot?.id,
        )),
  );
  if (
    !msg.reply_to_message &&
    latest?.id !== run.id &&
    (!active(run) || intent === "continue")
  )
    return false;
  if (
    intent === "continue" &&
    expired(run) &&
    deployment.active &&
    !deployment.paused &&
    !w.settings.paused
  ) {
    requireThat((run.pendingInputs?.length ?? 0) < 20, "queue_full", 429);
    requireThat(
      w.runs.filter((r) => ["queued", "running"].includes(r.status)).length <
        20,
      "queue_full",
      429,
    );
    const sourceId = `${deployment.bot.id}:${actor}:${msg.message_id}`;
    if (!w.messages.some((source) => source.id === sourceId))
      w.messages.push({
        id: sourceId,
        author: actor,
        chatId: actor,
        topicId: run.topicId,
        text: cmd.args,
        role: "user",
        runId: run.id,
        threadId: run.threadId,
        directed: true,
        browserRead: run.browserRead,
        at: new Date(msg.date * 1000).toISOString(),
        expiresAt: new Date(
          Date.now() + w.settings.retentionDays * 86400000,
        ).toISOString(),
      });
    run.pendingInputs ??= [];
    if (!run.pendingInputs.some((input) => input.sourceId === sourceId))
      run.pendingInputs.push({
        sourceId,
        task: cmd.args,
        messageId: msg.message_id,
      });
    run.status = "queued";
    delete run.error;
    delete run.finishedAt;
    delete run.result;
  }
  const id = deliver(w, actor, actor, browserTaskStatus(run), {
    id: `event:${update.update_id}:browser-status`,
    runId: run.id,
    topicId: run.topicId,
    buttons:
      deployment.bot.username && run.browserWait
        ? [
            [
              {
                text: "Open Browser",
                url: `https://t.me/${deployment.bot.username}?startapp=browser_${w.id.replaceAll("-", "")}`,
              },
            ],
          ]
        : undefined,
  });
  const delivery = w.deliveries.find((d) => d.id === id);
  if (delivery)
    delivery.browserTaskState = {
      refresh: true,
      status: run.status,
      fence: run.fence,
      requestId: run.browserWait?.id,
      error: run.error,
    };
  return true;
}
