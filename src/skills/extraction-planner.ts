import { randomUUID } from "node:crypto";
import { browserRunPrivate } from "../browser/privacy.ts";
import type { DevelopmentTask } from "../coding/development.ts";
import type { Workspace } from "../domain.ts";
import type { Mission } from "../orchestration/types.ts";
import { fingerprint } from "../setup/credentials.ts";
import { eligible } from "../workspaces/policy.ts";
import {
  shouldExtractFromCodingTask,
  shouldExtractFromConversation,
  shouldExtractFromMission,
} from "./extractor.ts";
import {
  resolveRunRepositoryIds,
  skillExtractionEnabled,
  skillExtractionState,
} from "./scope.ts";
import type { SkillExtractionJob } from "./types.ts";

export const SKILL_EXTRACT_IDLE_MS = 10 * 60 * 1000;
export const SKILL_EXTRACT_LEASE_MS = 120_000;

export function claimSkillExtractionJob(
  w: Workspace,
  options: {
    codingTasks?: readonly DevelopmentTask[];
    missions?: readonly Mission[];
    now?: number;
    idleMs?: number;
  } = {},
): SkillExtractionJob | undefined {
  const now = options.now ?? Date.now();
  const idleMs = options.idleMs ?? SKILL_EXTRACT_IDLE_MS;
  if (w.deletion || w.settings.paused || !skillExtractionEnabled(w)) {
    return undefined;
  }

  const state = skillExtractionState(w);
  // Single active job per workspace to bound concurrency and cost.
  if (
    state.jobs.some(
      (j) => j.status === "running" && Date.parse(j.leaseUntil) > now,
    )
  ) {
    return undefined;
  }

  // Retry any retryable or expired-lease job first.
  for (const job of state.jobs) {
    if (
      !["running", "retry"].includes(job.status) ||
      Date.parse(job.retryAt ?? "1970-01-01") > now
    ) {
      continue;
    }
    if (job.tries >= 3 || !eligible(w, job.actor)) {
      job.status = "failed";
      job.error =
        job.tries >= 3 ? "skill_extract_max_retries" : "actor_ineligible";
      state.checkpoints = [
        ...state.checkpoints.filter((c) => c.key !== job.checkpointKey),
        {
          key: job.checkpointKey,
          hash: job.inputHash,
          at: new Date(now).toISOString(),
        },
      ].slice(-256);
      continue;
    }
    job.status = "running";
    job.token = randomUUID();
    job.tries++;
    job.leaseUntil = new Date(now + SKILL_EXTRACT_LEASE_MS).toISOString();
    return structuredClone(job);
  }

  const alreadyProcessed = (key: string, hash: string) =>
    state.checkpoints.some((c) => c.key === key && c.hash === hash) ||
    state.jobs.some(
      (j) =>
        j.checkpointKey === key &&
        j.inputHash === hash &&
        ["done", "failed", "running", "retry"].includes(j.status),
    );

  // Priority 1: Completed or review-ready Codex tasks (rich project engineering lessons).
  for (const task of options.codingTasks ?? []) {
    if (!shouldExtractFromCodingTask(task) || !eligible(w, task.actor)) {
      continue;
    }
    const checkpointKey = `coding:${task.id}`;
    const inputHash = fingerprint({
      revision: task.revision,
      state: task.state,
      summary: task.result?.summary,
      evidence: task.result?.evidence?.slice(0, 4000),
      verificationCommands: task.result?.verificationCommands,
    });
    if (alreadyProcessed(checkpointKey, inputHash)) continue;
    const job: SkillExtractionJob = {
      id: randomUUID(),
      sourceKind: "coding_task",
      sourceId: task.id,
      checkpointKey,
      inputHash,
      actor: task.actor,
      repositoryId: task.payload.repositoryId,
      repository: task.payload.repository,
      status: "running",
      token: randomUUID(),
      leaseUntil: new Date(now + SKILL_EXTRACT_LEASE_MS).toISOString(),
      tries: 1,
      attemptIds: [],
      at: new Date(now).toISOString(),
    };
    state.jobs = [...state.jobs, job].slice(-32);
    return structuredClone(job);
  }

  // Priority 2: Completed multi-step Missions.
  for (const mission of options.missions ?? []) {
    if (!shouldExtractFromMission(mission) || !eligible(w, mission.actor)) {
      continue;
    }
    const checkpointKey = `mission:${mission.id}`;
    const inputHash = fingerprint({
      status: mission.status,
      updatedAt: mission.updatedAt,
      summary: mission.summary,
      artifacts: mission.artifacts.map((a) => ({
        kind: a.kind,
        label: a.label,
      })),
      childTaskIds: mission.childTaskIds,
    });
    if (alreadyProcessed(checkpointKey, inputHash)) continue;
    const parentRun = w.runs.findLast(
      (r) =>
        r.missionId === mission.id && r.status === "succeeded" && !r.cancelled,
    );
    const job: SkillExtractionJob = {
      id: randomUUID(),
      sourceKind: "mission",
      sourceId: mission.id,
      checkpointKey,
      inputHash,
      runId: parentRun?.id,
      actor: mission.actor,
      repositoryId: mission.repositoryId,
      repository: mission.repositoryId
        ? w.github?.repositories.find((r) => r.id === mission.repositoryId)
            ?.full_name
        : undefined,
      status: "running",
      token: randomUUID(),
      leaseUntil: new Date(now + SKILL_EXTRACT_LEASE_MS).toISOString(),
      tries: 1,
      attemptIds: [],
      at: new Date(now).toISOString(),
    };
    state.jobs = [...state.jobs, job].slice(-32);
    return structuredClone(job);
  }

  // Priority 3: Idle high-signal conversation threads.
  const threads = [...(w.threads ?? [])].reverse();
  for (const thread of threads) {
    const runs = w.runs.filter((r) => r.threadId === thread.id);
    if (
      runs.some((r) =>
        ["queued", "running", "awaiting_approval"].includes(r.status),
      )
    ) {
      continue;
    }
    if (runs.some((r) => browserRunPrivate(w, r))) continue;
    const parent = runs.findLast(
      (r) =>
        r.status === "succeeded" &&
        !r.cancelled &&
        !r.memoryMutation &&
        !r.codingTaskId &&
        !!r.result &&
        eligible(w, r.actor),
    );
    if (!parent) continue;
    const own = w.messages.filter(
      (s) =>
        s.threadId === thread.id &&
        Date.parse(s.expiresAt) > now &&
        !w.runs.find((r) => r.id === s.runId)?.memoryMutation,
    );
    if (!shouldExtractFromConversation(runs, own)) continue;
    const lastAt = Math.max(...own.map((s) => Date.parse(s.at)));
    if (lastAt > now - idleMs) continue;

    const checkpointKey = `thread:${thread.id}`;
    const inputHash = fingerprint(
      own
        .slice(-24)
        .map((s) => ({ id: s.id, role: s.role, text: s.text.slice(0, 500) })),
    );
    if (alreadyProcessed(checkpointKey, inputHash)) continue;

    const repoIds = resolveRunRepositoryIds(w, parent);
    const repoId = repoIds.size === 1 ? [...repoIds][0] : undefined;
    const repoName = repoId
      ? w.github?.repositories.find((r) => r.id === repoId)?.full_name
      : undefined;

    const job: SkillExtractionJob = {
      id: randomUUID(),
      sourceKind: "conversation",
      sourceId: thread.id,
      checkpointKey,
      inputHash,
      runId: parent.id,
      actor: parent.actor,
      repositoryId: repoId,
      repository: repoName,
      status: "running",
      token: randomUUID(),
      leaseUntil: new Date(now + SKILL_EXTRACT_LEASE_MS).toISOString(),
      tries: 1,
      attemptIds: [],
      at: new Date(now).toISOString(),
    };
    state.jobs = [...state.jobs, job].slice(-32);
    return structuredClone(job);
  }

  return undefined;
}
