import { randomUUID } from "node:crypto";
import { enqueueRepoTask, type RepoQueueItem } from "../coding/queue.ts";
import type { Sql } from "../db/pool.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { verifiedRepositoryAccess } from "../github/user-access.ts";
import { missionGet, missionSave, waitCreate } from "./store.ts";

export interface CrossRepoTarget {
  repositoryId: number;
  title: string;
  codingTaskId?: string;
}

export interface CrossRepoDispatchResult {
  missionId: string;
  mode: "parallel" | "dependent";
  joinGroup: string;
  enqueued: RepoQueueItem[];
  pendingChainCount: number;
}

/**
 * Coordinates cross-repository work under a single parent Mission:
 * - "parallel": enqueues independent tasks onto each repository's queue with a shared join_mode="all" barrier.
 * - "dependent": enqueues the first repository immediately and records the remaining ordered chain
 *   in mission artifacts/state so the Mission's wakeup continuation pins Stage 1's commit/PR as a
 *   read-only reference for Stage 2.
 */
export async function dispatchCrossRepoMission(
  sql: Sql,
  w: Workspace,
  input: {
    missionId: string;
    actor: string;
    chatId: string;
    topicId: number;
    mode: "parallel" | "dependent";
    targets: CrossRepoTarget[];
    now?: Date;
  },
): Promise<CrossRepoDispatchResult> {
  requireThat(
    input.targets.length >= 2 && input.targets.length <= 6,
    "invalid_cross_repo_targets",
  );
  const uniqueRepos = new Set(input.targets.map((t) => t.repositoryId));
  requireThat(
    uniqueRepos.size === input.targets.length,
    "duplicate_cross_repo_target",
  );

  // Validate every target repository is connected and accessible to actor before mutating anything.
  for (const target of input.targets) {
    const repo = w.github?.repositories.find(
      (r) => r.id === target.repositoryId,
    );
    requireThat(repo, "github_repository_not_connected", 404);
    if (w.members.find((m) => m.id === input.actor)?.github) {
      requireThat(
        verifiedRepositoryAccess(w, input.actor, target.repositoryId, true),
        "github_user_access_denied",
        403,
      );
    }
  }

  const mission = await missionGet(sql, w.id, input.missionId);
  const now = input.now ?? new Date();
  const joinGroup = randomUUID();
  const enqueued: RepoQueueItem[] = [];

  if (input.mode === "parallel") {
    for (const target of input.targets) {
      const { item } = await enqueueRepoTask(sql, w, {
        repositoryId: target.repositoryId,
        actor: input.actor,
        chatId: input.chatId,
        topicId: input.topicId,
        title: target.title,
        missionId: mission.id,
        codingTaskId: target.codingTaskId,
        now,
      });
      enqueued.push(item);
      await waitCreate(sql, {
        workspaceId: w.id,
        missionId: mission.id,
        joinGroup,
        joinMode: "all",
        kind: "coding_task",
        targetId: target.codingTaskId ?? item.id,
        reason: `Cross-repo parallel work on ${item.repository}`,
        now,
      });
    }
    mission.status = "waiting";
    await missionSave(sql, mission);
    return {
      missionId: mission.id,
      mode: "parallel",
      joinGroup,
      enqueued,
      pendingChainCount: 0,
    };
  }

  // Dependent chain: dispatch first stage now, record remaining stages cleanly for continuation wakeup.
  const [first, ...rest] = input.targets;
  requireThat(first, "invalid_cross_repo_targets");
  const { item } = await enqueueRepoTask(sql, w, {
    repositoryId: first.repositoryId,
    actor: input.actor,
    chatId: input.chatId,
    topicId: input.topicId,
    title: first.title,
    missionId: mission.id,
    codingTaskId: first.codingTaskId,
    now,
  });
  enqueued.push(item);
  await waitCreate(sql, {
    workspaceId: w.id,
    missionId: mission.id,
    joinGroup,
    joinMode: "all",
    kind: "coding_task",
    targetId: first.codingTaskId ?? item.id,
    reason: `Cross-repo stage 1 on ${item.repository}`,
    now,
  });
  mission.artifacts.push({
    id: randomUUID(),
    kind: "reference",
    label: "Pending dependent repositories",
    value: JSON.stringify(rest),
    at: now.toISOString(),
  });
  mission.status = "waiting";
  await missionSave(sql, mission);
  return {
    missionId: mission.id,
    mode: "dependent",
    joinGroup,
    enqueued,
    pendingChainCount: rest.length,
  };
}
