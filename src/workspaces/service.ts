import { randomUUID } from "node:crypto";
import {
  type Run,
  requireThat,
  type Settings,
  settingsSchema,
  type Workspace,
} from "../domain.ts";
import { starterSkills } from "../skills/catalog.ts";
import { audience, audit, authorize } from "./policy.ts";
import { groupThread, privateThread, refreshThreadContext } from "./threads.ts";
export function newWorkspace(
  operatorId: string,
  settings: Settings,
): Workspace {
  return {
    id: randomUUID(),
    operatorId,
    version: 1,
    settings: settingsSchema.parse(settings),
    policy: { mode: "whitelist", version: 1, allowed: [] },
    members: [],
    chats: [],
    messages: [],
    instructions: [],
    skills: starterSkills(),
    workflows: [],
    approvals: [],
    runs: [],
    deliveries: [],
    audit: [],
    occurrences: [],
    tokens: [],
  };
}
export function enrollOwner(w: Workspace, actor: string) {
  requireThat(
    !w.members.some((m) => m.role === "owner" && m.id !== actor),
    "owner_already_linked",
    409,
  );
  const member = w.members.find((m) => m.id === actor);
  if (member) Object.assign(member, { role: "owner", active: true });
  else w.members.push({ id: actor, role: "owner", active: true });
  if (!w.policy.allowed.includes(actor)) w.policy.allowed.push(actor);
  w.policy.version++;
  audit(w, actor, "owner.verified", w.id);
}
export function deliver(
  w: Workspace,
  actor: string,
  chatId: string,
  text: string,
  options: {
    topicId?: number;
    replyTo?: number;
    runId?: string;
    buttons?: Workspace["deliveries"][number]["buttons"];
    id?: string;
    format?: "markdown" | "rich";
  } = {},
) {
  const id = options.id ?? randomUUID();
  if (w.deliveries.some((d) => d.id === id)) return id;
  w.deliveries.push({
    id,
    actor,
    chatId,
    text: text.slice(0, 4000),
    format: options.format,
    topicId: options.topicId ?? 0,
    replyTo: options.replyTo,
    runId: options.runId,
    buttons: options.buttons,
    state: "pending",
    attempts: 0,
    at: new Date().toISOString(),
  });
  return id;
}
export function createRun(
  w: Workspace,
  actor: string,
  task: string,
  chatId: string,
  topicId: number,
  model: string,
  options: {
    replyTo?: number;
    workflowId?: string;
    botId?: string;
    continueFrom?: number;
    groupRecap?: boolean;
    followup?: Run["followup"];
    now?: Date;
    id?: string;
  } = {},
) {
  audience(w, actor, chatId);
  requireThat(w.runs.length < 1000, "retained_run_capacity_reached", 429);
  requireThat(!w.settings.paused, "workspace_paused", 409);
  requireThat(task.trim() && task.length <= 4000, "invalid_task");
  requireThat(
    w.runs.filter((r) => ["queued", "running"].includes(r.status)).length < 20,
    "queue_full",
    429,
  );
  const workflow = options.workflowId
    ? w.workflows.find((f) => f.id === options.workflowId)
    : undefined;
  if (options.workflowId)
    requireThat(workflow?.status === "active", "workflow_inactive", 409);
  const pins = workflow
    ? [{ id: workflow.spec.skillId, version: workflow.skillVersion }]
    : w.skills
        .filter((s) => s.enabled && !s.archived && s.published.length)
        .map((s) => ({ id: s.id, version: s.published.length }));
  requireThat(
    pins.length &&
      pins.every((p) =>
        w.skills.some(
          (s) =>
            s.id === p.id &&
            s.enabled &&
            !s.archived &&
            s.published[p.version - 1],
        ),
      ),
    "skill_unavailable",
    409,
  );
  const now = options.now ?? new Date();
  const privateChat = chatId === actor && !options.workflowId;
  const selected = privateChat
    ? privateThread(w, actor, options.botId, topicId, options.continueFrom, now)
    : options.botId && !options.workflowId && !options.groupRecap
      ? groupThread(
          w,
          actor,
          chatId,
          topicId,
          options.botId,
          options.continueFrom,
          now,
        )
      : undefined;
  const since = now.getTime() - (workflow?.spec.windowDays ?? 7) * 86400000;
  const candidates = w.messages
    .filter(
      (m) =>
        !selected &&
        (!m.runId ||
          !w.runs.find((r) => r.id === m.runId)?.followup ||
          w.runs.find((r) => r.id === m.runId)?.followup?.decision ===
            "reply") &&
        m.chatId === chatId &&
        m.topicId === topicId &&
        Date.parse(m.expiresAt) > now.getTime() &&
        Date.parse(m.at) >= since,
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const sources = candidates.map((message) => structuredClone(message));
  const instructions = w.instructions
    .filter(
      (i) =>
        i.active &&
        (i.scope === "workspace" ||
          (i.scope === "personal" && i.author === actor && chatId === actor) ||
          (i.scope === "workflow" && i.workflowId === workflow?.id)),
    )
    .map((i) => structuredClone(i));
  const run: Run = {
    id: options.id ?? randomUUID(),
    actor,
    chatId,
    topicId,
    replyTo: options.replyTo,
    conversation: selected
      ? `${privateChat ? "private" : "group"}:${selected.thread.id}`
      : `${chatId}:${topicId}:${options.replyTo ?? "root"}`,
    threadId: selected?.thread.id,
    threadNotice: selected?.notice,
    replyAnchor: options.continueFrom,
    followup: options.followup,
    status: "queued",
    task,
    at: now.toISOString(),
    workflowId: workflow?.id,
    workflowVersion: workflow?.version,
    settings: structuredClone(w.settings),
    settingsVersion: w.version,
    model,
    skillPins: pins,
    instructions,
    sources,
    coverage: `${sources.length} received messages, ${sources[0]?.at ?? "no history"} to ${sources.at(-1)?.at ?? "no history"}. ${w.chats.find((c) => c.id === chatId)?.collection ? "Consented received group messages" : "Directed messages only"}. Telegram old history is unavailable.${sources.length < candidates.length ? " Input truncated to budget." : ""}`,
    cancelled: false,
    fence: 0,
    transcript: [],
    transcriptVersion: 1,
    tools: {},
    attempts: [],
  };
  if (workflow) {
    run.task = `${task}\nRequired format: ${workflow.spec.format}`;
    run.settings.runBudgetUsd = Math.min(
      run.settings.runBudgetUsd,
      workflow.spec.budgetUsd,
    );
  }
  w.runs.push(run);
  if (selected) {
    const sourceId = options.replyTo
      ? `${privateChat && options.botId ? `${options.botId}:` : ""}${chatId}:${options.replyTo}`
      : `request:${run.id}`;
    let source = w.messages.find(
      (m) => m.id === sourceId && m.author === actor,
    );
    if (!source) {
      source = {
        id: sourceId,
        chatId,
        topicId,
        author: actor,
        text: task,
        at: now.toISOString(),
        directed: true,
        expiresAt: new Date(
          now.getTime() + w.settings.retentionDays * 86400000,
        ).toISOString(),
      };
      w.messages.push(source);
    }
    source.threadId = selected.thread.id;
    source.runId = run.id;
    source.role = "user";
    w.messages = w.messages.slice(-2000);
    refreshThreadContext(w, run);
  }
  audit(w, actor, "run.queued", run.id);
  return run;
}
export function cancelRun(w: Workspace, actor: string, id: string) {
  authorize(w, actor);
  const run = w.runs.find((r) => r.id === id);
  requireThat(
    run &&
      (run.actor === actor ||
        (run.chatId !== run.actor &&
          w.members.some((m) => m.id === actor && m.role !== "member"))),
    "not_found",
    404,
  );
  if (["queued", "running", "awaiting_approval"].includes(run.status)) {
    run.cancelled = true;
    run.status = "cancelled";
    run.finishedAt = new Date().toISOString();
  }
  for (const d of w.deliveries)
    if (d.runId === id && d.state === "pending") d.state = "cancelled";
  audit(w, actor, "run.cancelled", id);
  return run;
}
export function visibleRuns(w: Workspace, actor: string) {
  authorize(w, actor);
  return w.runs.filter(
    (r) =>
      r.actor === actor || w.chats.some((c) => c.id === r.chatId && c.active),
  );
}
