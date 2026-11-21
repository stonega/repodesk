import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  effectiveAutonomyMode,
  workspaceAutonomy,
} from "../autonomy/policy.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Run, requireThat, type Workspace } from "../domain.ts";
import { audit, runAllowed } from "../workspaces/policy.ts";
import {
  missionCreate,
  missionGet,
  missionList,
  missionSave,
  waitCreate,
  waitListForMission,
} from "./store.ts";
import {
  MAX_AUTO_TIMER_MINUTES,
  MIN_AUTO_TIMER_MINUTES,
  type MissionArtifact,
  type MissionJoinMode,
  type MissionWaitKind,
  missionTerminal,
} from "./types.ts";
import { cancelMission, requireMissionAccess } from "./wakeup.ts";

export const ORCHESTRATION_TOOLS = [
  "manage_mission",
  "schedule_mission_followup",
  "inspect_missions",
] as const;

export function orchestrationTools(
  store: Store,
  workspaceId: string,
  runId: string,
  fence: number,
  mode: "interactive" | "workflow" = "interactive",
): AgentTool[] {
  if (mode === "workflow") return [];

  const bind = (
    name: (typeof ORCHESTRATION_TOOLS)[number],
    label: string,
    description: string,
    parameters: AgentTool["parameters"],
    executionMode: "parallel" | "sequential",
    action: (
      w: Workspace,
      r: Run,
      args: Record<string, unknown>,
      sql: Sql,
      callId: string,
    ) => Promise<unknown>,
  ): AgentTool => ({
    name,
    label,
    description,
    parameters,
    executionMode,
    execute: async (callId, args, signal) => {
      signal?.throwIfAborted();
      if (executionMode === "parallel") {
        const claimed = await store.mutateRunRow(workspaceId, runId, (w, r) => {
          requireThat(
            r.fence === fence && runAllowed(w, r) && r.status === "running",
            "tool_policy_denied",
            403,
          );
          requireThat(!r.workflowId, "workflow_tool_denied", 403);
          const prior = r.tools[callId];
          if (prior?.state === "done") {
            return {
              cached: prior.result as {
                content: { type: "text"; text: string }[];
                details: unknown;
              },
            };
          }
          r.tools[callId] = { name, state: "started" };
          return { w, r: structuredClone(r) };
        });
        if ("cached" in claimed && claimed.cached) return claimed.cached;
        const value = await action(
          claimed.w,
          claimed.r,
          args as Record<string, unknown>,
          store.pool,
          callId,
        );
        signal?.throwIfAborted();
        const result = {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          details: {},
        };
        await store.mutateRunRow(workspaceId, runId, (w, r) => {
          requireThat(
            r.fence === fence && runAllowed(w, r) && r.status === "running",
            "tool_policy_denied",
            403,
          );
          r.tools[callId] = { name, state: "done", result };
        });
        return result;
      }
      return store.change(workspaceId, async (w, sql) => {
        const r = w.runs.find((item) => item.id === runId);
        requireThat(
          r && r.fence === fence && runAllowed(w, r) && r.status === "running",
          "tool_policy_denied",
          403,
        );
        requireThat(!r.workflowId, "workflow_tool_denied", 403);
        const prior = r.tools[callId];
        if (prior?.state === "done") {
          return prior.result as {
            content: { type: "text"; text: string }[];
            details: unknown;
          };
        }
        r.tools[callId] = { name, state: "started" };
        const value = await action(
          w,
          r,
          args as Record<string, unknown>,
          sql,
          callId,
        );
        const result = {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          details: {},
        };
        r.tools[callId] = { name, state: "done", result };
        return result;
      });
    },
  });

  return [
    bind(
      "inspect_missions",
      "Inspect background missions",
      "Read active or recent background missions, pending waits, and verified artifacts in the current conversation scope. Read-only; never exposes another member's private missions or cross-chat data.",
      Type.Object(
        {
          missionId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 100 }),
          ),
          activeOnly: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      "parallel",
      async (w, r, a, sql) => {
        if (a.missionId) {
          const mission = await missionGet(sql, w.id, String(a.missionId));
          requireMissionAccess(w, r, mission);
          const waits = await waitListForMission(sql, w.id, mission.id);
          return { mission, waits };
        }
        const list = await missionList(sql, w.id, {
          chatId: r.chatId,
          topicId: r.topicId,
          actor: r.chatId === r.actor ? r.actor : undefined,
          activeOnly: a.activeOnly === true,
          limit: 10,
        });
        const items = await Promise.all(
          list.items.map(async (mission) => ({
            id: mission.id,
            status: mission.status,
            goal: mission.goal,
            wakeupCount: mission.wakeupCount,
            maxWakeups: mission.maxWakeups,
            autoTimerCount: mission.autoTimerCount,
            maxAutoTimers: mission.maxAutoTimers,
            artifacts: mission.artifacts.slice(-10),
            pendingWaits: (await waitListForMission(sql, w.id, mission.id))
              .filter((wait) => wait.status === "pending")
              .map((wait) => ({
                id: wait.id,
                kind: wait.kind,
                targetId: wait.targetId,
                dueAt: wait.dueAt,
                reason: wait.reason,
              })),
            updatedAt: mission.updatedAt,
          })),
        );
        return { items, total: list.total };
      },
    ),
    bind(
      "manage_mission",
      "Manage multi-step background mission",
      "Create, update, attach waits/artifacts to, silently continue, complete, or cancel a durable background Mission for multi-step goals (for example: gather evidence -> dispatch coding/cross-repo work -> wait for completion or approval -> synthesize and follow up). During background wakeups, call action='continue_silently' when work continues in the background and no user interruption is needed. Avoid narrating internal mission IDs or bookkeeping to the user.",
      Type.Object(
        {
          action: Type.Union([
            Type.Literal("start"),
            Type.Literal("attach_wait"),
            Type.Literal("record_artifact"),
            Type.Literal("continue_silently"),
            Type.Literal("complete"),
            Type.Literal("cancel"),
          ]),
          missionId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 100 }),
          ),
          goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
          summary: Type.Optional(Type.String({ maxLength: 2000 })),
          wait: Type.Optional(
            Type.Object(
              {
                kind: Type.Union([
                  Type.Literal("coding_task"),
                  Type.Literal("approval"),
                  Type.Literal("browser"),
                  Type.Literal("github_event"),
                ]),
                targetId: Type.String({ minLength: 1, maxLength: 200 }),
                joinGroup: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 100 }),
                ),
                joinMode: Type.Optional(
                  Type.Union([Type.Literal("all"), Type.Literal("any")]),
                ),
                reason: Type.Optional(Type.String({ maxLength: 500 })),
              },
              { additionalProperties: false },
            ),
          ),
          artifact: Type.Optional(
            Type.Object(
              {
                kind: Type.Union([
                  Type.Literal("summary"),
                  Type.Literal("pr"),
                  Type.Literal("commit"),
                  Type.Literal("issue"),
                  Type.Literal("obsidian_note"),
                  Type.Literal("research"),
                  Type.Literal("reference"),
                  Type.Literal("other"),
                ]),
                label: Type.String({ minLength: 1, maxLength: 200 }),
                value: Type.String({ minLength: 1, maxLength: 2000 }),
                repositoryId: Type.Optional(Type.Integer({ minimum: 1 })),
                repository: Type.Optional(Type.String({ maxLength: 200 })),
                provenance: Type.Optional(Type.String({ maxLength: 500 })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      "sequential",
      async (w, r, a, sql) => {
        const action = String(a.action);
        const now = new Date();
        if (action === "start") {
          const active = await missionList(sql, w.id, {
            actor: r.actor,
            activeOnly: true,
            limit: 10,
          });
          requireThat(active.total < 10, "mission_capacity_reached", 429);
          const deployment = await store.deployment(sql);
          const goal = String(a.goal ?? r.task).trim();
          requireThat(goal.length > 0, "mission_goal_required");
          const cfg = workspaceAutonomy(w);
          const repositoryId =
            r.repository?.id ?? r.groupRepository?.repositoryId;
          const mission = await missionCreate(sql, {
            workspaceId: w.id,
            actor: r.actor,
            chatId: r.chatId,
            topicId: r.topicId,
            threadId: r.threadId,
            botId: deployment.bot?.id,
            status: "active",
            goal,
            originSourceIds: r.sources.slice(-10).map((s) => s.id),
            autonomyMode: effectiveAutonomyMode(w, repositoryId),
            autonomyRevision: cfg.revision,
            repositoryId,
            groupRepositoryVersion: r.groupRepositoryVersion,
            lastRunId: r.id,
            summary: typeof a.summary === "string" ? a.summary : undefined,
            now,
          });
          r.missionId = mission.id;
          audit(w, r.actor, "mission.started", mission.id, mission.fence, now);
          return { missionId: mission.id, status: mission.status };
        }

        const id = String(a.missionId ?? r.missionId ?? "");
        requireThat(id.length > 0, "mission_id_required");
        const mission = await missionGet(sql, w.id, id);
        requireMissionAccess(w, r, mission);
        r.missionId = mission.id;

        if (action === "cancel") {
          const cancelled = await cancelMission(
            sql,
            w,
            r.actor,
            mission.id,
            "cancelled_by_user",
            now,
          );
          return { missionId: cancelled.id, status: cancelled.status };
        }

        requireThat(
          !missionTerminal(mission.status),
          "mission_already_finished",
          409,
        );

        if (action === "continue_silently") {
          requireThat(
            r.triggerKind === "mission_wakeup" ||
              mission.status === "waiting" ||
              mission.status === "awaiting_approval",
            "mission_silent_not_allowed",
            409,
          );
          const summary =
            typeof a.summary === "string" && a.summary.trim()
              ? a.summary.trim().slice(0, 2000)
              : undefined;
          if (summary) {
            mission.summary = summary;
            await missionSave(sql, mission);
          }
          r.missionSilent = { reason: "explicit", summary };
          return {
            missionId: mission.id,
            status: mission.status,
            silent: true,
          };
        }

        if (action === "complete") {
          mission.status = "completed";
          if (typeof a.summary === "string")
            mission.summary = a.summary.slice(0, 2000);
          mission.finishedAt = now.toISOString();
          await missionSave(sql, mission);
          audit(
            w,
            r.actor,
            "mission.completed",
            mission.id,
            mission.fence,
            now,
          );
          return { missionId: mission.id, status: mission.status };
        }

        if (action === "record_artifact") {
          const raw = a.artifact as
            | Omit<MissionArtifact, "id" | "at">
            | undefined;
          requireThat(raw, "mission_artifact_required");
          const artifact: MissionArtifact = {
            id: randomUUID(),
            at: now.toISOString(),
            ...raw,
          };
          mission.artifacts.push(artifact);
          if (mission.artifacts.length > 40) {
            mission.artifacts = mission.artifacts.slice(-40);
          }
          await missionSave(sql, mission);
          return { missionId: mission.id, artifactId: artifact.id };
        }

        if (action === "attach_wait") {
          const raw = a.wait as
            | {
                kind: MissionWaitKind;
                targetId: string;
                joinGroup?: string;
                joinMode?: MissionJoinMode;
                reason?: string;
              }
            | undefined;
          requireThat(raw, "mission_wait_required");
          const wait = await waitCreate(sql, {
            workspaceId: w.id,
            missionId: mission.id,
            kind: raw.kind,
            targetId: raw.targetId,
            joinGroup: raw.joinGroup,
            joinMode: raw.joinMode,
            reason: raw.reason,
            now,
          });
          if (
            raw.kind === "coding_task" &&
            !mission.childTaskIds.includes(raw.targetId)
          ) {
            mission.childTaskIds.push(raw.targetId);
          }
          mission.status =
            raw.kind === "approval" ? "awaiting_approval" : "waiting";
          await missionSave(sql, mission);
          return {
            missionId: mission.id,
            waitId: wait.id,
            joinGroup: wait.joinGroup,
            status: mission.status,
          };
        }

        requireThat(false, "invalid_mission_action");
      },
    ),
    bind(
      "schedule_mission_followup",
      "Schedule autonomous delayed check",
      "Schedule a bounded one-shot delayed follow-up check (1 minute to 72 hours) for the current task/mission without asking for extra user confirmation (for example, checking CI status or deployment health after waiting). Automatically creates or reuses the current background Mission. Capped at 3 autonomous checks per Mission.",
      Type.Object(
        {
          delayMinutes: Type.Integer({
            minimum: MIN_AUTO_TIMER_MINUTES,
            maximum: MAX_AUTO_TIMER_MINUTES,
          }),
          reason: Type.String({ minLength: 1, maxLength: 500 }),
          goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
          missionId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 100 }),
          ),
        },
        { additionalProperties: false },
      ),
      "sequential",
      async (w, r, a, sql) => {
        const now = new Date();
        const delayMinutes = Number(a.delayMinutes);
        requireThat(
          Number.isInteger(delayMinutes) &&
            delayMinutes >= MIN_AUTO_TIMER_MINUTES &&
            delayMinutes <= MAX_AUTO_TIMER_MINUTES,
          "invalid_followup_delay",
        );
        const existingId = String(a.missionId ?? r.missionId ?? "");
        let mission = existingId
          ? await missionGet(sql, w.id, existingId)
          : undefined;
        if (mission) {
          requireMissionAccess(w, r, mission);
          requireThat(
            !missionTerminal(mission.status),
            "mission_already_finished",
            409,
          );
        } else {
          const deployment = await store.deployment(sql);
          const cfg = workspaceAutonomy(w);
          const repositoryId =
            r.repository?.id ?? r.groupRepository?.repositoryId;
          mission = await missionCreate(sql, {
            workspaceId: w.id,
            actor: r.actor,
            chatId: r.chatId,
            topicId: r.topicId,
            threadId: r.threadId,
            botId: deployment.bot?.id,
            status: "waiting",
            goal: String(a.goal ?? r.task).trim() || r.task,
            originSourceIds: r.sources.slice(-10).map((s) => s.id),
            autonomyMode: effectiveAutonomyMode(w, repositoryId),
            autonomyRevision: cfg.revision,
            repositoryId,
            groupRepositoryVersion: r.groupRepositoryVersion,
            lastRunId: r.id,
            now,
          });
        }
        requireThat(
          mission.autoTimerCount < mission.maxAutoTimers,
          "mission_auto_timer_limit",
          409,
        );
        const dueAt = new Date(
          now.getTime() + delayMinutes * 60_000,
        ).toISOString();
        const timerToken = `timer:${randomUUID()}`;
        const wait = await waitCreate(sql, {
          workspaceId: w.id,
          missionId: mission.id,
          kind: "timer",
          targetId: timerToken,
          reason: String(a.reason),
          dueAt,
          now,
        });
        mission.autoTimerCount++;
        mission.status = "waiting";
        mission.lastRunId = r.id;
        r.missionId = mission.id;
        await missionSave(sql, mission);
        audit(
          w,
          r.actor,
          "mission.followup_scheduled",
          mission.id,
          mission.autoTimerCount,
          now,
        );
        return {
          missionId: mission.id,
          waitId: wait.id,
          dueAt,
          remainingAutoTimers: mission.maxAutoTimers - mission.autoTimerCount,
        };
      },
    ),
  ];
}
