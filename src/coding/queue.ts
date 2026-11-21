import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { verifiedRepositoryAccess } from "../github/user-access.ts";
import { audience, audit, eligible } from "../workspaces/policy.ts";

export type RepoQueueItemStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface RepoQueueCarryover {
  sourceItemId: string;
  sourceTaskId?: string;
  summary: string;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  completedAt: string;
}

export interface RepoQueueItem {
  id: string;
  workspaceId: string;
  repositoryId: number;
  repository: string;
  missionId?: string;
  codingTaskId?: string;
  actor: string;
  chatId: string;
  topicId: number;
  title: string;
  priority: number;
  position: number;
  status: RepoQueueItemStatus;
  carryoverEnabled: boolean;
  carryoverSourceTaskId?: string;
  carryover?: RepoQueueCarryover;
  outcomeArtifact?: RepoQueueCarryover;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RepoQueueState {
  workspaceId: string;
  repositoryId: number;
  repository: string;
  paused: boolean;
  concurrency: number;
  revision: number;
  updatedAt: string;
}

export interface RepoQueueView {
  queue: RepoQueueState;
  running: RepoQueueItem[];
  queued: RepoQueueItem[];
  recent: RepoQueueItem[];
}

async function ensureQueueRow(
  sql: Sql,
  workspaceId: string,
  repositoryId: number,
  repository: string,
): Promise<RepoQueueState> {
  await sql.query(
    `INSERT INTO workspace_repo_queues(workspace_id, repository_id, paused, concurrency, revision, data)
     VALUES($1, $2, false, 1, 0, $3)
     ON CONFLICT (workspace_id, repository_id) DO NOTHING`,
    [workspaceId, repositoryId, JSON.stringify({ repository })],
  );
  const res = await sql.query<{
    paused: boolean;
    concurrency: number;
    revision: number;
    updated_at: Date | string;
    data: { repository?: string };
  }>(
    `SELECT paused, concurrency, revision, updated_at, data
     FROM workspace_repo_queues
     WHERE workspace_id=$1 AND repository_id=$2
     FOR UPDATE`,
    [workspaceId, repositoryId],
  );
  const row = res.rows[0];
  requireThat(row, "queue_not_found", 404);
  return {
    workspaceId,
    repositoryId,
    repository: row.data.repository ?? repository,
    paused: row.paused,
    concurrency: row.concurrency,
    revision: row.revision,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

function sameCarryoverScope(a: RepoQueueItem, b: RepoQueueItem): boolean {
  // Never leak private carryover into groups or across different private actors.
  const aPrivate = a.chatId === a.actor;
  const bPrivate = b.chatId === b.actor;
  if (aPrivate !== bPrivate) return false;
  if (aPrivate) return a.actor === b.actor;
  return a.chatId === b.chatId && a.topicId === b.topicId;
}

async function latestCarryoverFor(
  sql: Sql,
  workspaceId: string,
  repositoryId: number,
  target: RepoQueueItem,
): Promise<RepoQueueCarryover | undefined> {
  if (!target.carryoverEnabled) return undefined;
  const rows = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND status='completed'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 10`,
    [workspaceId, repositoryId],
  );
  for (const row of rows.rows) {
    const prev = row.data;
    if (prev.outcomeArtifact && sameCarryoverScope(prev, target)) {
      return prev.outcomeArtifact;
    }
  }
  return undefined;
}

async function saveQueueItem(sql: Sql, item: RepoQueueItem): Promise<void> {
  await sql.query(
    `UPDATE workspace_repo_queue_items
     SET priority=$3,
         position=$4,
         status=$5,
         coding_task_id=$6,
         carryover_source_task_id=$7,
         started_at=$8,
         finished_at=$9,
         data=$10
     WHERE workspace_id=$1 AND id=$2`,
    [
      item.workspaceId,
      item.id,
      item.priority,
      item.position,
      item.status,
      item.codingTaskId ?? null,
      item.carryoverSourceTaskId ?? null,
      item.startedAt ?? null,
      item.finishedAt ?? null,
      JSON.stringify(item),
    ],
  );
}

/**
 * Enqueues a task on a repository's sequential queue. Immediately starts it
 * when the queue is active and below concurrency; otherwise leaves it queued.
 */
export async function enqueueRepoTask(
  sql: Sql,
  w: Workspace,
  input: {
    repositoryId: number;
    actor: string;
    chatId: string;
    topicId: number;
    title: string;
    missionId?: string;
    codingTaskId?: string;
    priority?: number;
    carryoverEnabled?: boolean;
    now?: Date;
  },
): Promise<{ item: RepoQueueItem; queue: RepoQueueState }> {
  const repo = w.github?.repositories.find((r) => r.id === input.repositoryId);
  requireThat(repo, "github_repository_not_connected", 404);
  requireThat(eligible(w, input.actor), "access_denied", 403);
  audience(w, input.actor, input.chatId);

  const now = input.now ?? new Date();
  const at = now.toISOString();
  const queue = await ensureQueueRow(sql, w.id, repo.id, repo.full_name);

  const posRes = await sql.query<{ max_pos: number | null }>(
    `SELECT MAX(position) AS max_pos FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2`,
    [w.id, repo.id],
  );
  const nextPosition = Number(posRes.rows[0]?.max_pos ?? 0) + 1;

  const item: RepoQueueItem = {
    id: randomUUID(),
    workspaceId: w.id,
    repositoryId: repo.id,
    repository: repo.full_name,
    missionId: input.missionId,
    codingTaskId: input.codingTaskId,
    actor: input.actor,
    chatId: input.chatId,
    topicId: input.topicId,
    title: input.title.slice(0, 200),
    priority: input.priority ?? 0,
    position: nextPosition,
    status: "queued",
    carryoverEnabled: input.carryoverEnabled ?? true,
    createdAt: at,
  };

  await sql.query(
    `INSERT INTO workspace_repo_queue_items (
       workspace_id, id, repository_id, mission_id, coding_task_id, actor,
       chat_id, topic_id, priority, position, status, carryover_enabled,
       carryover_source_task_id, created_at, started_at, finished_at, data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      item.workspaceId,
      item.id,
      item.repositoryId,
      item.missionId ?? null,
      item.codingTaskId ?? null,
      item.actor,
      item.chatId,
      item.topicId,
      item.priority,
      item.position,
      item.status,
      item.carryoverEnabled,
      null,
      item.createdAt,
      null,
      null,
      JSON.stringify(item),
    ],
  );
  audit(w, input.actor, "repo_queue.enqueued", item.id, repo.id, now);

  const promoted = await promoteNextRepoTask(sql, w, repo.id, now);
  if (promoted?.id === item.id) {
    return { item: promoted, queue };
  }
  return { item, queue };
}

/**
 * Atomically promotes the highest-priority queued item for a repository when
 * the queue is not paused and has free concurrency slots. Rechecks current
 * actor membership, audience, and GitHub write permission before promoting.
 */
export async function promoteNextRepoTask(
  sql: Sql,
  w: Workspace,
  repositoryId: number,
  now = new Date(),
): Promise<RepoQueueItem | undefined> {
  if (w.deletion || w.settings.paused) return undefined;
  const repo = w.github?.repositories.find((r) => r.id === repositoryId);
  if (!repo) return undefined;
  const queue = await ensureQueueRow(sql, w.id, repo.id, repo.full_name);
  if (queue.paused) return undefined;

  const runningRes = await sql.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND status='running'`,
    [w.id, repo.id],
  );
  if (Number(runningRes.rows[0]?.count ?? 0) >= queue.concurrency) {
    return undefined;
  }

  const candidates = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND status='queued'
     ORDER BY priority DESC, position ASC
     LIMIT 20`,
    [w.id, repo.id],
  );

  const at = now.toISOString();
  for (const row of candidates.rows) {
    const item = structuredClone(row.data);
    let authorized = eligible(w, item.actor);
    if (authorized) {
      try {
        audience(w, item.actor, item.chatId);
      } catch {
        authorized = false;
      }
    }
    if (authorized && w.members.find((m) => m.id === item.actor)?.github) {
      authorized = verifiedRepositoryAccess(w, item.actor, repositoryId, true);
    }
    if (!authorized) {
      item.status = "cancelled";
      item.error = "queue_item_revoked";
      item.finishedAt = at;
      await saveQueueItem(sql, item);
      audit(w, item.actor, "repo_queue.revoked", item.id, repositoryId, now);
      continue;
    }

    const carryover = await latestCarryoverFor(sql, w.id, repositoryId, item);
    if (carryover) {
      item.carryover = carryover;
      item.carryoverSourceTaskId = carryover.sourceTaskId;
    }
    item.status = "running";
    item.startedAt = at;
    await saveQueueItem(sql, item);
    audit(w, item.actor, "repo_queue.promoted", item.id, repositoryId, now);
    return item;
  }

  return undefined;
}

export async function completeRepoQueueItem(
  sql: Sql,
  w: Workspace,
  repositoryId: number,
  itemId: string,
  outcome: {
    status: "completed" | "failed";
    summary?: string;
    branch?: string;
    commitSha?: string;
    prNumber?: number;
    prUrl?: string;
    error?: string;
  },
  now = new Date(),
): Promise<{ completed: RepoQueueItem; promoted?: RepoQueueItem }> {
  const res = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND id=$3 FOR UPDATE`,
    [w.id, repositoryId, itemId],
  );
  requireThat(res.rows[0], "queue_item_not_found", 404);
  const item = structuredClone(res.rows[0].data);
  const at = now.toISOString();
  item.status = outcome.status;
  item.finishedAt = at;
  item.error = outcome.error;
  if (outcome.status === "completed") {
    item.outcomeArtifact = {
      sourceItemId: item.id,
      sourceTaskId: item.codingTaskId,
      summary: (outcome.summary ?? item.title).slice(0, 1500),
      branch: outcome.branch,
      commitSha: outcome.commitSha,
      prNumber: outcome.prNumber,
      prUrl: outcome.prUrl,
      completedAt: at,
    };
  }
  await saveQueueItem(sql, item);
  audit(
    w,
    item.actor,
    `repo_queue.${outcome.status}`,
    item.id,
    repositoryId,
    now,
  );
  const promoted = await promoteNextRepoTask(sql, w, repositoryId, now);
  return { completed: item, promoted };
}

export async function pinRepoQueueItem(
  sql: Sql,
  w: Workspace,
  actor: string,
  repositoryId: number,
  itemId: string,
  now = new Date(),
): Promise<RepoQueueItem> {
  const res = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND id=$3 FOR UPDATE`,
    [w.id, repositoryId, itemId],
  );
  requireThat(res.rows[0], "queue_item_not_found", 404);
  const item = structuredClone(res.rows[0].data);
  requireThat(item.status === "queued", "queue_item_not_queued", 409);
  const maxRes = await sql.query<{ max_prio: number | null }>(
    `SELECT MAX(priority) AS max_prio FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND status='queued'`,
    [w.id, repositoryId],
  );
  item.priority = Number(maxRes.rows[0]?.max_prio ?? 0) + 1;
  await saveQueueItem(sql, item);
  audit(w, actor, "repo_queue.pinned", item.id, repositoryId, now);
  return item;
}

export async function cancelRepoQueueItem(
  sql: Sql,
  w: Workspace,
  actor: string,
  repositoryId: number,
  itemId: string,
  now = new Date(),
): Promise<{ cancelled: RepoQueueItem; promoted?: RepoQueueItem }> {
  const res = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1 AND repository_id=$2 AND id=$3 FOR UPDATE`,
    [w.id, repositoryId, itemId],
  );
  requireThat(res.rows[0], "queue_item_not_found", 404);
  const item = structuredClone(res.rows[0].data);
  if (["completed", "failed", "cancelled"].includes(item.status)) {
    return { cancelled: item };
  }
  const wasRunning = item.status === "running";
  item.status = "cancelled";
  item.error = "cancelled_by_user";
  item.finishedAt = now.toISOString();
  await saveQueueItem(sql, item);
  audit(w, actor, "repo_queue.cancelled", item.id, repositoryId, now);
  const promoted = wasRunning
    ? await promoteNextRepoTask(sql, w, repositoryId, now)
    : undefined;
  return { cancelled: item, promoted };
}

export async function setRepoQueuePaused(
  sql: Sql,
  w: Workspace,
  actor: string,
  repositoryId: number,
  paused: boolean,
  now = new Date(),
): Promise<{ queue: RepoQueueState; promoted?: RepoQueueItem }> {
  const repo = w.github?.repositories.find((r) => r.id === repositoryId);
  requireThat(repo, "github_repository_not_connected", 404);
  const current = await ensureQueueRow(sql, w.id, repo.id, repo.full_name);
  const nextRevision = current.revision + 1;
  await sql.query(
    `UPDATE workspace_repo_queues
     SET paused=$3, revision=$4, updated_at=$5
     WHERE workspace_id=$1 AND repository_id=$2`,
    [w.id, repo.id, paused, nextRevision, now.toISOString()],
  );
  audit(
    w,
    actor,
    paused ? "repo_queue.paused" : "repo_queue.resumed",
    String(repo.id),
    nextRevision,
    now,
  );
  const queue: RepoQueueState = {
    ...current,
    paused,
    revision: nextRevision,
    updatedAt: now.toISOString(),
  };
  const promoted = !paused
    ? await promoteNextRepoTask(sql, w, repo.id, now)
    : undefined;
  return { queue, promoted };
}

export async function listRepoQueues(
  sql: Sql,
  w: Workspace,
  redactPrivate = false,
): Promise<RepoQueueView[]> {
  const repos = w.github?.installationId ? w.github.repositories : [];
  const queueRows = await sql.query<{
    repository_id: string;
    paused: boolean;
    concurrency: number;
    revision: number;
    updated_at: Date | string;
    data: { repository?: string };
  }>(
    "SELECT repository_id, paused, concurrency, revision, updated_at, data FROM workspace_repo_queues WHERE workspace_id=$1",
    [w.id],
  );
  const queueMap = new Map<number, RepoQueueState>();
  for (const row of queueRows.rows) {
    const repoId = Number(row.repository_id);
    queueMap.set(repoId, {
      workspaceId: w.id,
      repositoryId: repoId,
      repository:
        row.data.repository ??
        repos.find((r) => r.id === repoId)?.full_name ??
        String(repoId),
      paused: row.paused,
      concurrency: row.concurrency,
      revision: row.revision,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    });
  }

  const itemRows = await sql.query<{ data: RepoQueueItem }>(
    `SELECT data FROM workspace_repo_queue_items
     WHERE workspace_id=$1
     ORDER BY priority DESC, position ASC`,
    [w.id],
  );

  const itemsByRepo = new Map<number, RepoQueueItem[]>();
  for (const row of itemRows.rows) {
    const item = structuredClone(row.data);
    if (redactPrivate && item.chatId === item.actor) {
      item.title = "Private queued task";
      item.carryover = undefined;
      item.outcomeArtifact = undefined;
    }
    const list = itemsByRepo.get(item.repositoryId) ?? [];
    list.push(item);
    itemsByRepo.set(item.repositoryId, list);
  }

  const repoIds = new Set<number>([
    ...repos.map((r) => r.id),
    ...queueMap.keys(),
    ...itemsByRepo.keys(),
  ]);

  return [...repoIds].map((repoId) => {
    const repo = repos.find((r) => r.id === repoId);
    const queue = queueMap.get(repoId) ?? {
      workspaceId: w.id,
      repositoryId: repoId,
      repository: repo?.full_name ?? String(repoId),
      paused: false,
      concurrency: 1,
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    };
    const items = itemsByRepo.get(repoId) ?? [];
    return {
      queue,
      running: items.filter((i) => i.status === "running"),
      queued: items.filter((i) => i.status === "queued"),
      recent: items
        .filter((i) => ["completed", "failed", "cancelled"].includes(i.status))
        .slice(-10)
        .reverse(),
    };
  });
}

export async function purgeRepoQueues(
  sql: Sql,
  workspaceId: string,
): Promise<void> {
  await sql.query(
    "DELETE FROM workspace_repo_queue_items WHERE workspace_id=$1",
    [workspaceId],
  );
  await sql.query("DELETE FROM workspace_repo_queues WHERE workspace_id=$1", [
    workspaceId,
  ]);
}
