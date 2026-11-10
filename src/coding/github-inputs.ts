import type { Sql } from "../db/pool.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import type { DevelopmentInput } from "./development.ts";
import { developmentStopped } from "./development.ts";
import {
  boundDevelopmentPull,
  developmentInputPresent,
} from "./input-sources.ts";
import {
  taskEvent,
  taskGet,
  taskInputs,
  taskList,
  taskSave,
} from "./task-store.ts";
import { checkDevelopment } from "./tasks.ts";

/** Continue a uniquely bound PR for its original requester under the existing task grant. */
export async function appendGitHubDevelopment(
  sql: Sql,
  w: Workspace,
  request: {
    installationId: number;
    repositoryId: number;
    number: number;
    actor: string;
    githubId: number;
    kind: "issue" | "review";
    id: number;
    body: string;
    text: string;
  },
) {
  const candidates = (await taskList(sql, w.id)).filter(
    (task) =>
      task.actor === request.actor &&
      task.payload.installationId === request.installationId &&
      task.payload.repositoryId === request.repositoryId &&
      task.pr?.number === request.number &&
      boundDevelopmentPull(task),
  );
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate) return false;
  const task = await taskGet(sql, w.id, candidate.id);
  checkDevelopment(w, task, request.actor);
  requireThat(
    !task.contentRemoved && !developmentStopped(task.state),
    "coding_task_stopped",
    409,
  );
  requireThat(
    w.reviewBot?.settings.enabled &&
      w.reviewBot.settings.acceptRequests &&
      w.reviewBot.settings.allowFixes,
    "review_fixes_disabled",
    403,
  );
  const inputs = await taskInputs(sql, task);
  requireThat(
    inputs.length &&
      inputs.every((input) => developmentInputPresent(w, task, input)),
    "coding_source_expired",
    409,
  );
  const sourceId = `github:${request.kind}:${request.id}`;
  const prior = await sql.query(
    "SELECT task_id FROM coding_task_inputs WHERE workspace_id=$1 AND source_key=$2",
    [w.id, sourceId],
  );
  if (prior.rows[0]) {
    requireThat(
      prior.rows[0].task_id === task.id,
      "coding_input_conflict",
      409,
    );
    return true;
  }
  requireThat(task.revision < 100, "coding_input_capacity", 429);
  // A GitHub follow-up cannot extend the original task's retained chat context.
  const context =
    (
      await sql.query(
        "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
        [w.id, task.id],
      )
    ).rows[0]?.data?.sources ?? [];
  const expiries = [
    ...inputs.map(
      (input) =>
        input.github?.expiresAt ??
        w.messages.find((message) => message.id === input.sourceId)?.expiresAt,
    ),
    ...context.map(
      (source: { id: string }) =>
        w.messages.find((message) => message.id === source.id)?.expiresAt,
    ),
  ];
  requireThat(
    expiries.every((expiry) => expiry && Date.parse(expiry) > Date.now()),
    "coding_source_expired",
    409,
  );
  const expiresAt = new Date(
    Math.min(...expiries.map((expiry) => Date.parse(expiry ?? ""))),
  ).toISOString();
  task.revision++;
  const input: DevelopmentInput = {
    revision: task.revision,
    actor: request.actor,
    sourceId,
    text: request.text,
    kind: "followup",
    github: {
      kind: request.kind,
      id: request.id,
      githubId: request.githubId,
      hash: fingerprint(request.body),
      reviewRevision: w.reviewBot.revision,
      expiresAt,
    },
  };
  requireThat(
    developmentInputPresent(w, task, input),
    "review_actor_unverified",
    403,
  );
  await sql.query(
    "INSERT INTO coding_task_inputs(workspace_id,task_id,revision,source_key,data,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())",
    [w.id, task.id, task.revision, sourceId, JSON.stringify(input)],
  );
  await sql.query(
    "INSERT INTO coding_task_grants(workspace_id,task_id,revision,data) VALUES($1,$2,$3,$4)",
    [
      w.id,
      task.id,
      task.revision,
      JSON.stringify({
        actor: request.actor,
        sourceId,
        text: input.text,
        policy: task.policy,
        operations: ["read"],
        github: input.github,
      }),
    ],
  );
  await taskEvent(sql, task, `github-input:${request.kind}:${request.id}`, {
    revision: task.revision,
    sourceId,
  });
  if (["review", "waiting", "queued"].includes(task.state) && !task.attemptId) {
    task.state = "queued";
    task.phase = "intake";
    task.question = undefined;
    task.nextPollAt = undefined;
  }
  await taskSave(sql, task);
  audit(
    w,
    request.actor,
    "coding.github_input_recorded",
    task.id,
    task.revision,
  );
  return true;
}
