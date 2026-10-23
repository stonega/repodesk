import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import {
  type Run,
  requireThat,
  type Source,
  type Workspace,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { clearProgress, deliverTaskProgress } from "../telegram/feedback.ts";
import { pullRequestButtons, taskButtons } from "../telegram/task-buttons.ts";
import {
  audience,
  audit,
  authorize,
  runAllowed,
} from "../workspaces/policy.ts";
import { cancellableRun, cancelRun, deliver } from "../workspaces/service.ts";
import {
  type DevelopmentInput,
  type DevelopmentTask,
  developmentPolicy,
  developmentStopped,
} from "./development.ts";
import { checkCodingPayload, codingDestination } from "./policy.ts";
import { checkReferenceSources } from "./reference-sources.ts";
import { requireRepositoryTarget } from "./repository-target.ts";
import {
  taskEvent,
  taskGet,
  taskInputs,
  taskList,
  taskSave,
} from "./task-store.ts";

export function checkDevelopment(
  w: Workspace,
  task: DevelopmentTask,
  actor = task.actor,
  stopping = false,
  viewing = false,
) {
  authorize(w, actor);
  requireThat(task.workspaceId === w.id, "access_denied", 403);
  audience(w, actor, task.chatId);
  if (stopping && actor === task.actor) return;
  checkCodingPayload(w, task.actor, task.payload);
  if (actor !== task.actor) checkCodingPayload(w, actor, task.payload);
  checkReferenceSources(
    w,
    task,
    actor === task.actor ? [actor] : [task.actor, actor],
  );
  requireThat(
    fingerprint(
      developmentPolicy.parse(w.coding?.settings.development ?? {}),
    ) === fingerprint(task.policy),
    "coding_configuration_changed",
    409,
  );
  requireThat(viewing || !task.cancelRequested, "coding_cancelled", 409);
}

export function currentRequirement(
  w: Workspace,
  actor: string,
  run: Run,
  ids: string[],
): Source[] {
  requireThat(
    run.actor === actor && runAllowed(w, run) && run.status === "running",
    "run_revoked",
    409,
  );
  const sources = ids.map((id) => w.messages.find((s) => s.id === id));
  requireThat(
    sources.every(
      (s): s is Source =>
        !!s &&
        (run.sources.some((reference) => reference.id === s.id) ||
          s.runId === run.id) &&
        s.chatId === run.chatId &&
        s.topicId === run.topicId &&
        Date.parse(s.expiresAt) > Date.now(),
    ),
    "coding_source_required",
    409,
  );
  requireThat(
    sources.some(
      (s) =>
        s.author === actor &&
        s.role !== "assistant" &&
        s.directed &&
        (s.runId === run.id ||
          (run.replyTo && s.id.endsWith(`:${run.replyTo}`))),
    ),
    "coding_current_request_required",
    409,
  );
  return sources;
}

export function notifyDevelopment(
  w: Workspace,
  task: DevelopmentTask,
  text: string,
  eventId: string,
  actor = task.actor,
) {
  audience(w, actor, task.chatId);
  if (w.settings.paused) return;
  const prButtons = pullRequestButtons(task.pr?.url);
  if (eventId === "started")
    return deliverTaskProgress(w, task, "development", text, {
      id: `development:${task.id}:${eventId}`,
      buttons: prButtons ?? taskButtons("development", task.id),
    });
  const outcome: Partial<Record<DevelopmentTask["state"], string>> = {
    waiting: "I need your input before we can continue.",
    auth_required: "Your task is paused until Codex is reconnected.",
    review: "Ready for you to take a look.",
    failed: "I couldn’t finish this task.",
    cancelled: "Your task has stopped.",
    unknown: "The task outcome needs an administrator’s check.",
  };
  const summary = outcome[task.state];
  if (summary)
    deliverTaskProgress(w, task, "development", summary, {
      id: `development:${task.id}:progress:${eventId}`,
      editOnly: true,
      buttons: prButtons,
    });
  return deliver(w, actor, task.chatId, text, {
    topicId: task.topicId,
    format: "markdown",
    id: `development:${task.id}:${eventId}`,
    buttons:
      prButtons ??
      (!developmentStopped(task.state) &&
      task.state !== "review" &&
      !task.cancelRequested
        ? taskButtons("development", task.id)
        : undefined),
  });
}

export async function startDevelopment(
  sql: Sql,
  w: Workspace,
  runId: string,
  actor: string,
  repositoryId: number,
  sourceIds: string[],
  botId: string,
  targetRepository = "",
) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run, "not_found", 404);
  const sources = currentRequirement(w, actor, run, sourceIds);
  const policy = developmentPolicy.parse(w.coding?.settings.development ?? {});
  const source = sources.find(
    (s) =>
      s.author === actor &&
      s.role !== "assistant" &&
      s.directed &&
      (s.runId === run.id || s.id.endsWith(`:${run.replyTo}`)),
  );
  requireThat(source, "coding_current_request_required", 409);
  requireRepositoryTarget(
    w,
    repositoryId,
    sources
      .filter((s) => s.author === actor && s.role !== "assistant")
      .map((s) => s.text),
    targetRepository,
  );
  const prior = await sql.query(
    "SELECT task_id FROM coding_task_inputs WHERE workspace_id=$1 AND source_key=$2",
    [w.id, `${source.id}:initial`],
  );
  if (prior.rows[0]) {
    const task = await taskGet(sql, w.id, prior.rows[0].task_id);
    requireThat(
      task.actor === actor && task.payload.repositoryId === repositoryId,
      "coding_task_conflict",
      409,
    );
    checkDevelopment(w, task);
    run.codingTaskId = task.id;
    return task;
  }
  const tasks = await taskList(sql, w.id);
  requireThat(
    tasks.length < 200 &&
      tasks.filter((t) =>
        [
          "queued",
          "working",
          "waiting",
          "publishing",
          "auth_required",
        ].includes(t.state),
      ).length < 10,
    "coding_capacity_reached",
    429,
  );
  const payload = codingDestination(w, actor, {
    repositoryId,
    title: source.text.slice(0, 200),
    body: source.text.slice(0, 2500),
  });
  const at = new Date().toISOString();
  const task: DevelopmentTask = {
    id: randomUUID(),
    workspaceId: w.id,
    actor,
    botId,
    chatId: run.chatId,
    topicId: run.topicId,
    sourceId: source.id,
    payload,
    policy,
    state: "queued",
    phase: "intake",
    revision: 1,
    consumedRevision: 0,
    verifiedRevision: 0,
    fence: 0,
    attempts: 0,
    tokens: 0,
    activeMs: 0,
    canImplement: false,
    canPublish: false,
    cancelRequested: false,
    createdAt: at,
    updatedAt: at,
  };
  await sql.query(
    "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
    [w.id, task.id, JSON.stringify(task)],
  );
  const input: DevelopmentInput = {
    revision: 1,
    actor,
    sourceId: source.id,
    text: source.text,
    kind: "request",
    hasAttachments: source.attachments?.length ? true : undefined,
  };
  await sql.query(
    "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data,created_at) VALUES($1,$2,1,$3,$4,clock_timestamp())",
    [w.id, task.id, `${source.id}:initial`, JSON.stringify(input)],
  );
  await sql.query(
    "INSERT INTO coding_task_grants(workspace_id,task_id,revision,data) VALUES($1,$2,1,$3)",
    [
      w.id,
      task.id,
      JSON.stringify({
        actor,
        sourceId: source.id,
        text: source.text,
        policy,
        payload,
        operations: ["read"],
      }),
    ],
  );
  await taskEvent(sql, task, "context", {
    sources: sources
      .filter((s) => s.id !== source.id)
      .map((s) => ({
        id: s.id,
        author: s.author,
        text: s.text,
        expiresAt: s.expiresAt,
      })),
  });
  run.codingTaskId = task.id;
  audit(w, actor, "coding.development_started", task.id);
  notifyDevelopment(
    w,
    task,
    `Got it — your request for ${payload.repository} is queued. I’ll keep you posted.`,
    "started",
  );
  const acknowledgement = w.deliveries.find(
    (d) => d.id === `development:${task.id}:started`,
  );
  if (acknowledgement) {
    acknowledgement.feedback = {
      owner: "development",
      id: task.id,
      key: "queued",
    };
  }
  return task;
}

/** Replace an idle, unchanged task; new authority comes only from the current correction. */
export async function correctDevelopmentRepository(
  sql: Sql,
  w: Workspace,
  task: DevelopmentTask,
  runId: string,
  actor: string,
  repositoryId: number,
  sourceId: string,
  botId: string,
  targetRepository: string,
) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run, "run_revoked", 409);
  const [source] = currentRequirement(w, actor, run, [sourceId]);
  requireThat(
    source &&
      source.author === actor &&
      source.role !== "assistant" &&
      source.runId === run.id &&
      task.actor === actor &&
      task.botId === botId &&
      (!run.threadId ||
        w.threads?.some((t) => t.id === run.threadId && t.botId === botId)) &&
      task.chatId === run.chatId &&
      task.topicId === run.topicId,
    "access_denied",
    403,
  );
  requireThat(
    targetRepository.trim(),
    "coding_repository_target_unverified",
    409,
  );
  requireRepositoryTarget(w, repositoryId, [source.text], targetRepository);
  if (task.replacementTaskId) {
    const replacement = await taskGet(sql, w.id, task.replacementTaskId);
    requireThat(
      replacement.replacesTaskId === task.id &&
        replacement.sourceId === source.id &&
        replacement.payload.repositoryId === repositoryId,
      "coding_task_conflict",
      409,
    );
    checkDevelopment(w, replacement, actor);
    run.codingTaskId = replacement.id;
    return replacement;
  }
  checkDevelopment(w, task, actor);
  requireThat(
    repositoryId !== task.payload.repositoryId &&
      ["queued", "waiting"].includes(task.state) &&
      !task.cancelRequested &&
      !task.attemptId &&
      !task.cleanupAttemptId &&
      !task.conversationAttemptId &&
      !task.conversationPending &&
      !task.pr &&
      task.verifiedRevision === 0 &&
      (task.attempts === 0 || task.hasChanges === false) &&
      !(Date.parse(task.leaseUntil ?? "1970-01-01") > Date.now()),
    "coding_repository_replacement_unsafe",
    409,
  );
  const inputs = await taskInputs(sql, task);
  const context =
    (
      await sql.query(
        "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
        [w.id, task.id],
      )
    ).rows[0]?.data?.sources ?? [];
  const ids = new Set<string>([
    ...inputs.map((i) => i.sourceId),
    ...context.map((s: { id: string }) => s.id),
  ]);
  const references = [...ids].map((id) => w.messages.find((s) => s.id === id));
  requireThat(
    references.every(
      (s): s is Source =>
        !!s &&
        s.chatId === task.chatId &&
        s.topicId === task.topicId &&
        Date.parse(s.expiresAt) > Date.now(),
    ),
    "coding_source_expired",
    409,
  );
  requireThat(
    inputs.every((input) =>
      references.some(
        (s) =>
          s.id === input.sourceId &&
          s.text === input.text &&
          s.author === input.actor,
      ),
    ) &&
      context.every((input: { id: string; text: string }) =>
        references.some((s) => s.id === input.id && s.text === input.text),
      ),
    "coding_source_expired",
    409,
  );
  // Leave room for the intake result in the runner's bounded reference context.
  requireThat(
    JSON.stringify(references).length <= 20000,
    "coding_repository_replacement_unsafe",
    409,
  );
  task.cancelRequested = true;
  task.state = "cancelled";
  task.fence++;
  task.lease = undefined;
  task.leaseUntil = undefined;
  clearProgress(w, "development", task.id);
  for (const delivery of w.deliveries)
    if (
      delivery.id.startsWith(`development:${task.id}:`) &&
      delivery.state === "pending"
    )
      delivery.state = "cancelled";
  await taskSave(sql, task);
  // Both writes share the workspace transaction: a failed start rolls back the stop.
  const replacement = await startDevelopment(
    sql,
    w,
    runId,
    actor,
    repositoryId,
    [source.id],
    botId,
    targetRepository,
  );
  requireThat(
    replacement.id !== task.id && !replacement.replacesTaskId,
    "coding_task_conflict",
    409,
  );
  await sql.query(
    "UPDATE coding_task_events SET data=$3 WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
    [
      w.id,
      replacement.id,
      JSON.stringify({
        sources: references.map((s) => ({
          id: s.id,
          author: s.author,
          text: s.text,
          expiresAt: s.expiresAt,
        })),
      }),
    ],
  );
  replacement.replacesTaskId = task.id;
  task.replacementTaskId = replacement.id;
  await taskSave(sql, task);
  await taskSave(sql, replacement);
  await taskEvent(sql, task, "repository-replaced", {
    taskId: replacement.id,
    sourceId,
  });
  await taskEvent(sql, replacement, "repository-corrected", {
    taskId: task.id,
    sourceId,
  });
  const notice = w.deliveries.find(
    (d) => d.id === `development:${replacement.id}:started`,
  );
  if (notice)
    notice.text = `I’ve corrected the task repository from ${task.payload.repository} to ${replacement.payload.repository}. Your original requirements are preserved, and the corrected task is queued.`;
  audit(w, actor, "coding.repository_corrected", replacement.id);
  return replacement;
}

export async function appendDevelopment(
  sql: Sql,
  w: Workspace,
  task: DevelopmentTask,
  actor: string,
  source: Source,
  sourceKey: string,
) {
  checkDevelopment(w, task, actor);
  requireThat(!developmentStopped(task.state), "coding_task_stopped", 409);
  requireThat(
    source.author === actor &&
      !!(source.text || source.attachments?.length) &&
      source.chatId === task.chatId &&
      source.topicId === task.topicId &&
      source.role !== "assistant" &&
      Date.parse(source.expiresAt) > Date.now(),
    "coding_source_required",
    409,
  );
  // The same Telegram input can arrive through Pi or the direct media route.
  // Transport-specific source keys must not create a second requirement revision.
  if (
    (await taskInputs(sql, task)).some(
      (input) => input.sourceId === source.id && input.actor === actor,
    )
  )
    return task;
  const prior = await sql.query(
    "SELECT task_id FROM coding_task_inputs WHERE workspace_id=$1 AND source_key=$2",
    [w.id, sourceKey],
  );
  if (prior.rows[0]) {
    requireThat(
      prior.rows[0].task_id === task.id,
      "coding_input_conflict",
      409,
    );
    return task;
  }
  requireThat(task.revision < 100, "coding_input_capacity", 429);
  const answering = task.state === "waiting" && !!task.question;
  task.revision++;
  const input: DevelopmentInput = {
    revision: task.revision,
    actor,
    sourceId: source.id,
    text: source.text,
    kind: answering ? "answer" : "followup",
    hasAttachments: source.attachments?.length ? true : undefined,
  };
  await sql.query(
    "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())",
    [w.id, task.id, task.revision, sourceKey, JSON.stringify(input)],
  );
  await sql.query(
    "INSERT INTO coding_task_grants(workspace_id,task_id,revision,data) VALUES($1,$2,$3,$4)",
    [
      w.id,
      task.id,
      task.revision,
      JSON.stringify({
        actor,
        sourceId: source.id,
        text: source.text,
        policy: task.policy,
        operations: ["read"],
        answersQuestion: answering ? task.question?.id : undefined,
      }),
    ],
  );
  if (answering)
    await taskEvent(sql, task, `answer:${task.question?.id}`, {
      input,
      question: task.question,
    });
  if (["review", "waiting"].includes(task.state)) {
    task.state = "queued";
    task.phase = answering && task.canImplement ? "work" : "intake";
    task.question = undefined;
  }
  await taskSave(sql, task);
  audit(w, actor, "coding.input_recorded", task.id, task.revision);
  return task;
}

export async function cancelDevelopment(
  sql: Sql,
  w: Workspace,
  actor: string,
  id: string,
) {
  const task = await taskGet(sql, w.id, id);
  checkDevelopment(w, task, actor, true);
  if (developmentStopped(task.state)) return task;
  if (task.cancelRequested) return task;
  task.cancelRequested = true;
  clearProgress(w, "development", task.id);
  if (
    ["queued", "waiting", "review"].includes(task.state) ||
    (task.state === "auth_required" && !task.attemptId)
  )
    task.state = "cancelled";
  await taskSave(sql, task);
  deliver(
    w,
    task.actor,
    task.chatId,
    task.state === "cancelled"
      ? "Your task has stopped. Messages already sent cannot be undone."
      : "Stopping your task… Any GitHub operation already underway may finish.",
    {
      topicId: task.topicId,
      id: `development:${task.id}:cancel:${task.state === "cancelled" ? "stopped" : "requested"}`,
      buttons: pullRequestButtons(task.pr?.url),
    },
  );
  audit(w, actor, "coding.cancel_requested", id);
  return task;
}

export async function cancelRequest(
  sql: Sql,
  w: Workspace,
  actor: string,
  id: string,
) {
  const run = cancellableRun(w, actor, id);
  if (run.codingTaskId) {
    const task = await taskGet(sql, w.id, run.codingTaskId);
    requireThat(
      task.actor === run.actor &&
        task.chatId === run.chatId &&
        task.topicId === run.topicId,
      "access_denied",
      403,
    );
    checkDevelopment(w, task, actor, true);
    await cancelDevelopment(sql, w, actor, task.id);
  }
  return cancelRun(w, actor, id);
}

export async function pruneDevelopment(sql: Sql, w: Workspace) {
  const cutoff = Date.now() - w.settings.retentionDays * 86400000;
  for (const task of await taskList(sql, w.id)) {
    const inputs = await taskInputs(sql, task);
    const references =
      (
        await sql.query(
          "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
          [w.id, task.id],
        )
      ).rows[0]?.data?.sources ?? [];
    const invalid =
      !!w.deletion ||
      (
        await sql.query(
          "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:message:%'",
          [w.id, task.id],
        )
      ).rows.some((row) =>
        (row.data.sourceIds ?? []).some(
          (id: string) =>
            !w.messages.some(
              (s) => s.id === id && Date.parse(s.expiresAt) > Date.now(),
            ),
        ),
      ) ||
      references.some(
        (reference: { id: string }) =>
          !w.messages.some(
            (s) =>
              s.id === reference.id && Date.parse(s.expiresAt) > Date.now(),
          ),
      ) ||
      Date.parse(task.createdAt) <= cutoff ||
      inputs.some(
        (i) =>
          !w.messages.some(
            (s) => s.id === i.sourceId && Date.parse(s.expiresAt) > Date.now(),
          ),
      );
    if (!invalid || task.contentRemoved) continue;
    task.cancelRequested = true;
    task.contentRemoved = true;
    task.payload.title = "[removed]";
    task.payload.body = "[removed]";
    task.result = undefined;
    task.referenceSources = undefined;
    task.question = undefined;
    task.sourceId = "[removed]";
    task.state = "queued";
    task.lease = undefined;
    task.leaseUntil = undefined;
    task.nextPollAt = undefined;
    await taskSave(sql, task);
    for (const table of [
      "coding_task_inputs",
      "coding_task_grants",
      "coding_task_events",
    ])
      await sql.query(
        `DELETE FROM ${table} WHERE workspace_id=$1 AND task_id=$2`,
        [w.id, task.id],
      );
    await sql.query(
      "UPDATE coding_task_attempts SET data='{}' WHERE workspace_id=$1 AND task_id=$2",
      [w.id, task.id],
    );
  }
}
