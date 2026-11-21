import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import { requireThat } from "../domain.ts";
import {
  DEFAULT_MAX_AUTO_TIMERS,
  DEFAULT_MAX_MISSION_WAKEUPS,
  type Mission,
  type MissionDetail,
  type MissionJoinMode,
  type MissionStatus,
  type MissionWait,
  type MissionWaitKind,
  type MissionWaitStatus,
  missionTerminal,
} from "./types.ts";

function rowToMission(row: { data: Mission }): Mission {
  return structuredClone(row.data);
}

function rowToWait(row: { data: MissionWait }): MissionWait {
  return structuredClone(row.data);
}

export async function missionCreate(
  sql: Sql,
  input: Omit<
    Mission,
    | "id"
    | "wakeupCount"
    | "maxWakeups"
    | "autoTimerCount"
    | "maxAutoTimers"
    | "fence"
    | "spentUsd"
    | "artifacts"
    | "childTaskIds"
    | "createdAt"
    | "updatedAt"
  > & {
    id?: string;
    maxWakeups?: number;
    maxAutoTimers?: number;
    now?: Date;
  },
): Promise<Mission> {
  const at = (input.now ?? new Date()).toISOString();
  const mission: Mission = {
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    actor: input.actor,
    chatId: input.chatId,
    topicId: input.topicId,
    threadId: input.threadId,
    botId: input.botId,
    status: input.status,
    goal: input.goal.slice(0, 2000),
    originSourceIds: [...input.originSourceIds].slice(0, 20),
    autonomyMode: input.autonomyMode,
    autonomyRevision: input.autonomyRevision,
    wakeupCount: 0,
    maxWakeups: input.maxWakeups ?? DEFAULT_MAX_MISSION_WAKEUPS,
    autoTimerCount: 0,
    maxAutoTimers: input.maxAutoTimers ?? DEFAULT_MAX_AUTO_TIMERS,
    fence: 1,
    repositoryId: input.repositoryId,
    groupRepositoryVersion: input.groupRepositoryVersion,
    lastRunId: input.lastRunId,
    spentUsd: 0,
    summary: input.summary,
    error: input.error,
    artifacts: [],
    childTaskIds: [],
    createdAt: at,
    updatedAt: at,
  };
  await sql.query(
    `INSERT INTO workspace_missions (
       workspace_id, id, actor, chat_id, topic_id, thread_id, bot_id, status,
       wakeup_count, max_wakeups, auto_timer_count, max_auto_timers, fence,
       last_run_id, created_at, updated_at, finished_at, data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      mission.workspaceId,
      mission.id,
      mission.actor,
      mission.chatId,
      mission.topicId,
      mission.threadId ?? null,
      mission.botId ?? null,
      mission.status,
      mission.wakeupCount,
      mission.maxWakeups,
      mission.autoTimerCount,
      mission.maxAutoTimers,
      mission.fence,
      mission.lastRunId ?? null,
      mission.createdAt,
      mission.updatedAt,
      mission.finishedAt ?? null,
      JSON.stringify(mission),
    ],
  );
  return mission;
}

export async function missionSave(sql: Sql, mission: Mission): Promise<void> {
  mission.updatedAt = new Date().toISOString();
  await sql.query(
    `UPDATE workspace_missions
     SET status=$3,
         wakeup_count=$4,
         auto_timer_count=$5,
         fence=$6,
         last_run_id=$7,
         updated_at=$8,
         finished_at=$9,
         data=$10
     WHERE workspace_id=$1 AND id=$2`,
    [
      mission.workspaceId,
      mission.id,
      mission.status,
      mission.wakeupCount,
      mission.autoTimerCount,
      mission.fence,
      mission.lastRunId ?? null,
      mission.updatedAt,
      mission.finishedAt ?? null,
      JSON.stringify(mission),
    ],
  );
}

export async function missionGet(
  sql: Sql,
  workspaceId: string,
  missionId: string,
): Promise<Mission> {
  const res = await sql.query<{ data: Mission }>(
    "SELECT data FROM workspace_missions WHERE workspace_id=$1 AND id=$2",
    [workspaceId, missionId],
  );
  requireThat(res.rows[0], "mission_not_found", 404);
  return rowToMission(res.rows[0]);
}

export async function missionFind(
  sql: Sql,
  workspaceId: string,
  missionId: string,
): Promise<Mission | undefined> {
  const res = await sql.query<{ data: Mission }>(
    "SELECT data FROM workspace_missions WHERE workspace_id=$1 AND id=$2",
    [workspaceId, missionId],
  );
  return res.rows[0] ? rowToMission(res.rows[0]) : undefined;
}

export async function missionList(
  sql: Sql,
  workspaceId: string,
  options: {
    actor?: string;
    chatId?: string;
    topicId?: number;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: Mission[]; total: number }> {
  const conditions = ["workspace_id=$1"];
  const params: unknown[] = [workspaceId];
  if (options.actor !== undefined) {
    params.push(options.actor);
    conditions.push(`actor=$${params.length}`);
  }
  if (options.chatId !== undefined) {
    params.push(options.chatId);
    conditions.push(`chat_id=$${params.length}`);
  }
  if (options.topicId !== undefined) {
    params.push(options.topicId);
    conditions.push(`topic_id=$${params.length}`);
  }
  if (options.activeOnly) {
    conditions.push("status IN ('active', 'waiting', 'awaiting_approval')");
  }
  const where = conditions.join(" AND ");
  const countRes = await sql.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workspace_missions WHERE ${where}`,
    params,
  );
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
  const offset = Math.max(0, options.offset ?? 0);
  const rows = await sql.query<{ data: Mission }>(
    `SELECT data FROM workspace_missions WHERE ${where}
     ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    items: rows.rows.map(rowToMission),
    total: Number(countRes.rows[0]?.count ?? 0),
  };
}

export async function missionDetail(
  sql: Sql,
  workspaceId: string,
  missionId: string,
): Promise<MissionDetail> {
  const mission = await missionGet(sql, workspaceId, missionId);
  const waits = await waitListForMission(sql, workspaceId, missionId);
  return { mission, waits };
}

export async function waitCreate(
  sql: Sql,
  input: {
    workspaceId: string;
    missionId: string;
    joinGroup?: string;
    joinMode?: MissionJoinMode;
    kind: MissionWaitKind;
    targetId: string;
    reason?: string;
    dueAt?: string;
    now?: Date;
  },
): Promise<MissionWait> {
  const at = (input.now ?? new Date()).toISOString();
  const wait: MissionWait = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    joinGroup: input.joinGroup ?? randomUUID(),
    joinMode: input.joinMode ?? "all",
    kind: input.kind,
    targetId: input.targetId,
    status: "pending",
    reason: input.reason?.slice(0, 500),
    dueAt: input.dueAt,
    createdAt: at,
  };
  await sql.query(
    `INSERT INTO workspace_mission_waits (
       workspace_id, mission_id, id, join_group, join_mode, kind, target_id,
       status, due_at, created_at, resolved_at, data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      wait.workspaceId,
      wait.missionId,
      wait.id,
      wait.joinGroup,
      wait.joinMode,
      wait.kind,
      wait.targetId,
      wait.status,
      wait.dueAt ?? null,
      wait.createdAt,
      null,
      JSON.stringify(wait),
    ],
  );
  return wait;
}

export async function waitSave(sql: Sql, wait: MissionWait): Promise<void> {
  await sql.query(
    `UPDATE workspace_mission_waits
     SET status=$3, resolved_at=$4, data=$5
     WHERE workspace_id=$1 AND id=$2`,
    [
      wait.workspaceId,
      wait.id,
      wait.status,
      wait.resolvedAt ?? null,
      JSON.stringify(wait),
    ],
  );
}

export async function waitListForMission(
  sql: Sql,
  workspaceId: string,
  missionId: string,
): Promise<MissionWait[]> {
  const res = await sql.query<{ data: MissionWait }>(
    `SELECT data FROM workspace_mission_waits
     WHERE workspace_id=$1 AND mission_id=$2
     ORDER BY created_at ASC`,
    [workspaceId, missionId],
  );
  return res.rows.map(rowToWait);
}

export async function waitFindPendingByTarget(
  sql: Sql,
  workspaceId: string,
  kind: MissionWaitKind,
  targetId: string,
): Promise<MissionWait[]> {
  const res = await sql.query<{ data: MissionWait }>(
    `SELECT data FROM workspace_mission_waits
     WHERE workspace_id=$1 AND kind=$2 AND target_id=$3 AND status='pending'`,
    [workspaceId, kind, targetId],
  );
  return res.rows.map(rowToWait);
}

export async function waitFindPendingByKind(
  sql: Sql,
  workspaceId: string,
  kind: MissionWaitKind,
): Promise<MissionWait[]> {
  const res = await sql.query<{ data: MissionWait }>(
    `SELECT data FROM workspace_mission_waits
     WHERE workspace_id=$1 AND kind=$2 AND status='pending'
     ORDER BY created_at ASC
     LIMIT 100`,
    [workspaceId, kind],
  );
  return res.rows.map(rowToWait);
}

export async function waitFindDueTimers(
  sql: Sql,
  workspaceId: string,
  now = new Date(),
): Promise<MissionWait[]> {
  const res = await sql.query<{ data: MissionWait }>(
    `SELECT data FROM workspace_mission_waits
     WHERE workspace_id=$1 AND kind='timer' AND status='pending'
       AND due_at IS NOT NULL AND due_at <= $2
     ORDER BY due_at ASC
     LIMIT 50`,
    [workspaceId, now.toISOString()],
  );
  return res.rows.map(rowToWait);
}

export async function missionCancelRecord(
  sql: Sql,
  workspaceId: string,
  missionId: string,
  reason = "cancelled",
  now = new Date(),
): Promise<Mission> {
  const mission = await missionGet(sql, workspaceId, missionId);
  if (missionTerminal(mission.status)) return mission;
  const at = now.toISOString();
  mission.status = "cancelled" satisfies MissionStatus;
  mission.error = reason;
  mission.fence++;
  mission.finishedAt = at;
  await missionSave(sql, mission);
  const waits = await waitListForMission(sql, workspaceId, missionId);
  for (const wait of waits) {
    if (wait.status === "pending") {
      wait.status = "cancelled" satisfies MissionWaitStatus;
      wait.resolvedAt = at;
      await waitSave(sql, wait);
    }
  }
  return mission;
}

export async function purgeWorkspaceMissions(
  sql: Sql,
  workspaceId: string,
): Promise<void> {
  await sql.query("DELETE FROM workspace_mission_waits WHERE workspace_id=$1", [
    workspaceId,
  ]);
  await sql.query("DELETE FROM workspace_missions WHERE workspace_id=$1", [
    workspaceId,
  ]);
}
