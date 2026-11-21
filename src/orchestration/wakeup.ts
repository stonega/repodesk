import { randomUUID } from "node:crypto";
import {
  effectiveAutonomyMode,
  workspaceAutonomy,
} from "../autonomy/policy.ts";
import { taskFind } from "../coding/task-store.ts";
import type { Sql } from "../db/pool.ts";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audience, audit, eligible } from "../workspaces/policy.ts";
import { createRun, deliver } from "../workspaces/service.ts";
import {
  missionCancelRecord,
  missionFind,
  missionList,
  missionSave,
  waitFindDueTimers,
  waitFindPendingByKind,
  waitFindPendingByTarget,
  waitListForMission,
  waitSave,
} from "./store.ts";
import {
  type Mission,
  type MissionArtifact,
  type MissionWait,
  type MissionWaitKind,
  missionTerminal,
} from "./types.ts";

export interface WakeupOutcome {
  status: "satisfied" | "failed";
  summary?: string;
  artifact?: Omit<MissionArtifact, "id" | "at">;
  data?: Record<string, unknown>;
}

function missionAuthorizationError(
  w: Workspace,
  mission: Mission,
  botId?: string,
): string | undefined {
  if (w.deletion) return "workspace_deleted";
  if (w.settings.paused) return "workspace_paused";
  if (!eligible(w, mission.actor)) return "actor_revoked";
  try {
    audience(w, mission.actor, mission.chatId);
  } catch {
    return "audience_revoked";
  }
  if (botId && mission.botId && mission.botId !== botId) {
    return "bot_changed";
  }
  if (mission.groupRepositoryVersion !== undefined) {
    const chat = w.chats.find((c) => c.id === mission.chatId && c.active);
    if (
      !chat?.repository ||
      chat.repository.revision !== mission.groupRepositoryVersion
    ) {
      return "group_repository_changed";
    }
  }
  return undefined;
}

/**
 * Resolves any pending mission waits matching (kind, targetId).
 * If the wait's join group is satisfied, atomically creates a Continuation Run
 * in `w.runs` (which `Store.change` enqueues into `outbox -> pg-boss`).
 */
export async function resolveMissionWait(
  sql: Sql,
  w: Workspace,
  kind: MissionWaitKind,
  targetId: string,
  outcome: WakeupOutcome,
  model: string,
  options: { botId?: string; now?: Date } = {},
): Promise<{ wokeRunIds: string[]; resolvedWaitIds: string[] }> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const pending = await waitFindPendingByTarget(sql, w.id, kind, targetId);
  if (!pending.length) return { wokeRunIds: [], resolvedWaitIds: [] };

  const wokeRunIds: string[] = [];
  const resolvedWaitIds: string[] = [];
  const touchedGroups = new Map<
    string,
    { missionId: string; joinGroup: string }
  >();

  for (const wait of pending) {
    wait.status = outcome.status;
    wait.resolvedAt = at;
    wait.result = {
      ...(outcome.summary ? { summary: outcome.summary.slice(0, 2000) } : {}),
      ...(outcome.data ?? {}),
    };
    await waitSave(sql, wait);
    resolvedWaitIds.push(wait.id);
    touchedGroups.set(`${wait.missionId}:${wait.joinGroup}`, {
      missionId: wait.missionId,
      joinGroup: wait.joinGroup,
    });
  }

  for (const { missionId, joinGroup } of touchedGroups.values()) {
    const mission = await missionFind(sql, w.id, missionId);
    if (!mission || missionTerminal(mission.status)) continue;

    if (outcome.artifact) {
      mission.artifacts.push({
        id: randomUUID(),
        at,
        ...outcome.artifact,
      });
      if (mission.artifacts.length > 40) {
        mission.artifacts = mission.artifacts.slice(-40);
      }
    }

    const waits = await waitListForMission(sql, w.id, missionId);
    const groupWaits = waits.filter((item) => item.joinGroup === joinGroup);
    if (!groupWaits.length) continue;

    const joinMode = groupWaits[0]?.joinMode ?? "all";
    const satisfied =
      joinMode === "any"
        ? groupWaits.some((item) => item.status !== "pending")
        : groupWaits.every((item) => item.status !== "pending");
    if (!satisfied) {
      await missionSave(sql, mission);
      continue;
    }

    if (joinMode === "any") {
      for (const item of groupWaits) {
        if (item.status === "pending") {
          item.status = "cancelled";
          item.resolvedAt = at;
          await waitSave(sql, item);
        }
      }
    }

    const authError = missionAuthorizationError(w, mission, options.botId);
    if (authError) {
      mission.status = "halted";
      mission.error = authError;
      mission.finishedAt = at;
      await missionSave(sql, mission);
      audit(w, mission.actor, "mission.halted", mission.id, mission.fence, now);
      continue;
    }

    if (mission.wakeupCount >= mission.maxWakeups) {
      mission.status = "halted";
      mission.error = "mission_wakeup_limit";
      mission.finishedAt = at;
      await missionSave(sql, mission);
      audit(
        w,
        mission.actor,
        "mission.wakeup_limit",
        mission.id,
        mission.fence,
        now,
      );
      deliver(
        w,
        mission.actor,
        mission.chatId,
        `Paused background follow-up for "${mission.goal.slice(0, 120)}" after reaching the automatic continuation limit (${mission.maxWakeups}). Ask me to continue if you want another check.`,
        {
          topicId: mission.topicId,
          id: `mission:${mission.id}:wakeup_limit`,
        },
      );
      continue;
    }

    // Circuit breaker for consecutive autonomous timer wakeups with no observable state change.
    if (kind === "timer") {
      const stateHash = fingerprint({
        artifacts: mission.artifacts.map((a) => ({
          kind: a.kind,
          value: a.value,
        })),
        summary: mission.summary,
      });
      if (mission.lastTimerStateHash === stateHash) {
        mission.consecutiveUnchangedTimers =
          (mission.consecutiveUnchangedTimers ?? 0) + 1;
      } else {
        mission.lastTimerStateHash = stateHash;
        mission.consecutiveUnchangedTimers = 0;
      }
      if ((mission.consecutiveUnchangedTimers ?? 0) >= 2) {
        mission.status = "halted";
        mission.error = "mission_timer_no_progress";
        mission.finishedAt = at;
        await missionSave(sql, mission);
        audit(
          w,
          mission.actor,
          "mission.timer_circuit_breaker",
          mission.id,
          mission.fence,
          now,
        );
        deliver(
          w,
          mission.actor,
          mission.chatId,
          `Stopped automatic checks for "${mission.goal.slice(0, 120)}" because nothing changed across consecutive checks.`,
          {
            topicId: mission.topicId,
            id: `mission:${mission.id}:no_progress`,
          },
        );
        continue;
      }
    }

    // Re-evaluate autonomy posture at wakeup time (policy tightening takes effect immediately).
    const currentAutonomy = workspaceAutonomy(w);
    mission.autonomyMode = effectiveAutonomyMode(w);
    mission.autonomyRevision = currentAutonomy.revision;
    mission.wakeupCount++;
    mission.status = "active";

    const resolvedSummaries = groupWaits.map((item) => ({
      id: item.id,
      kind: item.kind,
      targetId: item.targetId,
      status: item.status,
      reason: item.reason,
      result: item.result,
    }));

    const taskPrompt = [
      `Continue background Mission ${mission.id}.`,
      `Goal: ${mission.goal}`,
      `Resolved wait events: ${JSON.stringify(resolvedSummaries)}`,
      "Review the verified outcomes silently, advance remaining steps if needed, or complete the mission and report the concise result to the user.",
    ].join("\n");

    try {
      const run = createRun(
        w,
        mission.actor,
        taskPrompt,
        mission.chatId,
        mission.topicId,
        model,
        {
          now,
          botId: mission.botId,
        },
      );
      if (mission.threadId) run.threadId = mission.threadId;
      run.missionId = mission.id;
      run.triggerKind = "mission_wakeup";
      mission.lastRunId = run.id;
      await missionSave(sql, mission);
      audit(
        w,
        mission.actor,
        "mission.wakeup",
        mission.id,
        mission.wakeupCount,
        now,
      );
      wokeRunIds.push(run.id);
    } catch {
      mission.status = "halted";
      mission.error = "mission_wakeup_dispatch_failed";
      mission.finishedAt = at;
      await missionSave(sql, mission);
      audit(
        w,
        mission.actor,
        "mission.wakeup_failed",
        mission.id,
        mission.fence,
        now,
      );
    }
  }

  return { wokeRunIds, resolvedWaitIds };
}

/**
 * Worker maintenance sweep for due autonomous mission timers, decided approvals,
 * and finished coding tasks awaiting continuation.
 */
export async function tickMissions(
  sql: Sql,
  w: Workspace,
  model: string,
  options: { botId?: string; now?: Date } = {},
): Promise<number> {
  if (w.deletion || w.settings.paused) return 0;
  const now = options.now ?? new Date();
  let woke = 0;

  // 1. Due autonomous timer waits
  const due = await waitFindDueTimers(sql, w.id, now);
  for (const wait of due) {
    const res = await resolveMissionWait(
      sql,
      w,
      "timer",
      wait.targetId,
      {
        status: "satisfied",
        summary: wait.reason ?? "Scheduled delayed follow-up check is due.",
        data: { firedAt: now.toISOString(), dueAt: wait.dueAt },
      },
      model,
      options,
    );
    woke += res.wokeRunIds.length;
  }

  // 2. Pending approval waits whose approval has been decided (and any async send settled)
  const pendingApprovals = await waitFindPendingByKind(sql, w.id, "approval");
  for (const wait of pendingApprovals) {
    const approval = w.approvals.find((a) => a.id === wait.targetId);
    if (!approval) {
      const res = await resolveMissionWait(
        sql,
        w,
        "approval",
        wait.targetId,
        { status: "failed", summary: "Approval record is no longer present." },
        model,
        options,
      );
      woke += res.wokeRunIds.length;
      continue;
    }
    if (!approval.decision) {
      if (Date.parse(approval.expiresAt) <= now.getTime()) {
        const res = await resolveMissionWait(
          sql,
          w,
          "approval",
          wait.targetId,
          { status: "failed", summary: `Approval (${approval.kind}) expired.` },
          model,
          options,
        );
        woke += res.wokeRunIds.length;
      }
      continue;
    }
    if (approval.decision === "approved") {
      // Wait for async external send effects to settle before waking the mission.
      if (
        (approval.kind === "github_issue" &&
          (!approval.issue || approval.issue.state === "sending")) ||
        (approval.kind === "github_pull_request" &&
          (!approval.pullRequest ||
            approval.pullRequest.state === "sending")) ||
        (approval.kind === "cloudflare_action" &&
          (!approval.cloudflare || approval.cloudflare.state === "sending"))
      ) {
        continue;
      }
      const failedSend =
        approval.issue?.state === "failed" ||
        approval.issue?.state === "unknown" ||
        approval.pullRequest?.state === "failed" ||
        approval.pullRequest?.state === "unknown" ||
        approval.cloudflare?.state === "failed" ||
        approval.cloudflare?.state === "unknown";
      const res = await resolveMissionWait(
        sql,
        w,
        "approval",
        wait.targetId,
        {
          status: failedSend ? "failed" : "satisfied",
          summary: failedSend
            ? `Approval (${approval.kind}) was approved but execution ended in error/unknown state.`
            : `Approval (${approval.kind}) succeeded.`,
          artifact: approval.issue?.url
            ? {
                kind: "issue",
                label: `Issue #${approval.issue.number ?? ""}`.trim(),
                value: approval.issue.url,
              }
            : approval.pullRequest?.url
              ? {
                  kind: "pr",
                  label: "Pull request action",
                  value: approval.pullRequest.url,
                }
              : undefined,
          data: {
            decision: approval.decision,
            kind: approval.kind,
            issue: approval.issue,
            pullRequest: approval.pullRequest,
            cloudflare: approval.cloudflare,
          },
        },
        model,
        options,
      );
      woke += res.wokeRunIds.length;
    } else {
      const res = await resolveMissionWait(
        sql,
        w,
        "approval",
        wait.targetId,
        {
          status: "failed",
          summary: `Approval (${approval.kind}) was ${approval.decision}.`,
          data: { decision: approval.decision, kind: approval.kind },
        },
        model,
        options,
      );
      woke += res.wokeRunIds.length;
    }
  }

  // 3. Pending coding_task waits whose task has reached review or terminal state
  const pendingCoding = await waitFindPendingByKind(sql, w.id, "coding_task");
  for (const wait of pendingCoding) {
    const task = await taskFind(sql, w.id, wait.targetId);
    if (!task) {
      const res = await resolveMissionWait(
        sql,
        w,
        "coding_task",
        wait.targetId,
        { status: "failed", summary: "Coding task record not found." },
        model,
        options,
      );
      woke += res.wokeRunIds.length;
      continue;
    }
    if (!["review", "failed", "cancelled", "unknown"].includes(task.state)) {
      continue;
    }
    const succeeded = task.state === "review";
    const res = await resolveMissionWait(
      sql,
      w,
      "coding_task",
      wait.targetId,
      {
        status: succeeded ? "satisfied" : "failed",
        summary:
          task.result?.summary ??
          (succeeded
            ? `Coding task completed for ${task.payload.repository}.`
            : `Coding task ended with state ${task.state}${task.error ? ` (${task.error})` : ""}.`),
        artifact: task.pr?.url
          ? {
              kind: "pr",
              label: `PR #${task.pr.number} (${task.payload.repository})`,
              value: task.pr.url,
              repositoryId: task.payload.repositoryId,
              repository: task.payload.repository,
              provenance: task.pr.branch,
            }
          : task.result?.summary
            ? {
                kind: "summary",
                label: `Task outcome (${task.payload.repository})`,
                value: task.result.summary.slice(0, 1500),
                repositoryId: task.payload.repositoryId,
                repository: task.payload.repository,
              }
            : undefined,
        data: {
          taskId: task.id,
          state: task.state,
          repositoryId: task.payload.repositoryId,
          repository: task.payload.repository,
          pr: task.pr,
          error: task.error,
        },
      },
      model,
      options,
    );
    woke += res.wokeRunIds.length;
  }

  return woke;
}

/**
 * Cancels a mission, cancels pending waits, and cancels any queued/running mission runs.
 */
export async function cancelMission(
  sql: Sql,
  w: Workspace,
  actor: string,
  missionId: string,
  reason = "cancelled_by_user",
  now = new Date(),
): Promise<Mission> {
  const mission = await missionCancelRecord(sql, w.id, missionId, reason, now);
  for (const run of w.runs) {
    if (
      run.missionId === missionId &&
      ["queued", "running", "awaiting_approval"].includes(run.status)
    ) {
      run.cancelled = true;
      run.status = "cancelled";
      run.error = reason;
      run.finishedAt = now.toISOString();
      run.leaseUntil = undefined;
    }
  }
  audit(w, actor, "mission.cancelled", missionId, mission.fence, now);
  return mission;
}

/**
 * Builds a bounded, read-only mission context snapshot for buildContext().
 */
export async function missionContextSnapshot(
  sql: Sql,
  w: Workspace,
  run: Run,
): Promise<{
  activeMission?: {
    id: string;
    status: Mission["status"];
    goal: string;
    wakeupCount: number;
    maxWakeups: number;
    autoTimerCount: number;
    maxAutoTimers: number;
    artifacts: MissionArtifact[];
    waits: Array<{
      id: string;
      kind: MissionWait["kind"];
      targetId: string;
      status: MissionWait["status"];
      dueAt?: string;
      reason?: string;
      result?: Record<string, unknown>;
    }>;
  };
  otherActiveMissions?: Array<{
    id: string;
    status: Mission["status"];
    goal: string;
    pendingWaits: number;
  }>;
}> {
  if (run.workflowId) return {};
  const list = await missionList(sql, w.id, {
    chatId: run.chatId,
    topicId: run.topicId,
    actor: run.chatId === run.actor ? run.actor : undefined,
    activeOnly: true,
    limit: 10,
  });
  const current = run.missionId
    ? (list.items.find((m) => m.id === run.missionId) ??
      (await missionFind(sql, w.id, run.missionId)))
    : undefined;
  const activeWaits = current
    ? await waitListForMission(sql, w.id, current.id)
    : [];
  const others = list.items.filter((m) => m.id !== current?.id);

  return {
    ...(current
      ? {
          activeMission: {
            id: current.id,
            status: current.status,
            goal: current.goal,
            wakeupCount: current.wakeupCount,
            maxWakeups: current.maxWakeups,
            autoTimerCount: current.autoTimerCount,
            maxAutoTimers: current.maxAutoTimers,
            artifacts: current.artifacts.slice(-20),
            waits: activeWaits.slice(-20).map((wait) => ({
              id: wait.id,
              kind: wait.kind,
              targetId: wait.targetId,
              status: wait.status,
              dueAt: wait.dueAt,
              reason: wait.reason,
              result: wait.result,
            })),
          },
        }
      : {}),
    ...(others.length
      ? {
          otherActiveMissions: await Promise.all(
            others.slice(0, 5).map(async (m) => ({
              id: m.id,
              status: m.status,
              goal: m.goal,
              pendingWaits: (await waitListForMission(sql, w.id, m.id)).filter(
                (item) => item.status === "pending",
              ).length,
            })),
          ),
        }
      : {}),
  };
}

export function requireMissionAccess(
  w: Workspace,
  run: Run,
  mission: Mission,
): void {
  requireThat(mission.workspaceId === w.id, "access_denied", 403);
  requireThat(
    mission.chatId === run.chatId && mission.topicId === run.topicId,
    "mission_scope_mismatch",
    403,
  );
  if (run.chatId === run.actor) {
    requireThat(mission.actor === run.actor, "access_denied", 403);
  }
}
