import { Hono } from "hono";
import {
  autonomyView,
  updateRepositoryAutonomy,
  updateWorkspaceAutonomy,
} from "../../autonomy/policy.ts";
import {
  cancelRepoQueueItem,
  listRepoQueues,
  pinRepoQueueItem,
  setRepoQueuePaused,
} from "../../coding/queue.ts";
import { requireThat } from "../../domain.ts";
import { missionDetail, missionList } from "../../orchestration/store.ts";
import { cancelMission } from "../../orchestration/wakeup.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  validId,
  workspaceActor,
  workspaceChange,
} from "./shared.ts";

export function orchestrationRoutes(deps: AdminRouteDeps) {
  const { store } = deps;
  const app = new Hono<AdminEnv>();
  const change = workspaceChange(store);

  app.get("/api/admin/workspaces/:id/autonomy", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const admin = c.get("session").admin;
    workspaceActor(w, admin);
    return c.json(autonomyView(w, admin));
  });

  app.patch("/api/admin/workspaces/:id/autonomy", async (c) => {
    const body = await c.req.json();
    const view = await change(c, (w, actor) => {
      updateWorkspaceAutonomy(w, actor, body);
      return autonomyView(w);
    });
    return c.json(view);
  });

  app.patch(
    "/api/admin/workspaces/:id/github/repositories/:repoId/autonomy",
    async (c) => {
      const repoId = Number(c.req.param("repoId"));
      requireThat(
        Number.isSafeInteger(repoId) && repoId > 0,
        "invalid_repository_id",
        400,
      );
      const body = await c.req.json();
      const view = await change(c, (w, actor) => {
        updateRepositoryAutonomy(w, actor, repoId, body);
        return autonomyView(w);
      });
      return c.json(view);
    },
  );

  app.get("/api/admin/workspaces/:id/missions", async (c) => {
    const id = validId(c.req.param("id"));
    const w = await store.read(id);
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    const operatorOnly = actor === admin.id;
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const limit = Math.min(
      Math.max(1, Number(c.req.query("limit")) || 50),
      100,
    );
    const activeOnly = c.req.query("active") === "true";
    const list = await missionList(store.pool, id, {
      activeOnly,
      limit,
      offset,
    });
    const items = list.items.map((mission) => ({
      id: mission.id,
      actor: mission.actor,
      chatId: mission.chatId,
      topicId: mission.topicId,
      status: mission.status,
      // Keep private conversation goals hidden from unlinked operators
      goal:
        operatorOnly && mission.chatId === mission.actor
          ? "Private mission"
          : mission.goal,
      autonomyMode: mission.autonomyMode,
      wakeupCount: mission.wakeupCount,
      maxWakeups: mission.maxWakeups,
      autoTimerCount: mission.autoTimerCount,
      maxAutoTimers: mission.maxAutoTimers,
      spentUsd: mission.spentUsd,
      artifactCount: mission.artifacts.length,
      error: mission.error,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      finishedAt: mission.finishedAt,
    }));
    return c.json({ items, total: list.total, offset });
  });

  app.get("/api/admin/workspaces/:id/missions/:missionId", async (c) => {
    const id = validId(c.req.param("id"));
    const missionId = c.req.param("missionId");
    const w = await store.read(id);
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    const operatorOnly = actor === admin.id;
    const detail = await missionDetail(store.pool, id, missionId);
    if (operatorOnly && detail.mission.chatId === detail.mission.actor) {
      return c.json({
        mission: {
          ...detail.mission,
          goal: "Private mission",
          summary: undefined,
          artifacts: [],
        },
        waits: detail.waits.map((wait) => ({
          ...wait,
          reason: undefined,
          result: undefined,
        })),
      });
    }
    return c.json(detail);
  });

  app.post(
    "/api/admin/workspaces/:id/missions/:missionId/cancel",
    async (c) => {
      const missionId = c.req.param("missionId");
      const cancelled = await change(c, async (w, actor, sql) =>
        cancelMission(sql, w, actor, missionId, "cancelled_by_admin"),
      );
      return c.json({ mission: cancelled });
    },
  );

  app.get("/api/admin/workspaces/:id/queues", async (c) => {
    const id = validId(c.req.param("id"));
    const w = await store.read(id);
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    const operatorOnly = actor === admin.id;
    const items = await listRepoQueues(store.pool, w, operatorOnly);
    return c.json({ items });
  });

  app.post("/api/admin/workspaces/:id/queues/:repoId/pause", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    requireThat(
      Number.isSafeInteger(repoId) && repoId > 0,
      "invalid_repository_id",
      400,
    );
    const res = await change(c, async (w, actor, sql) =>
      setRepoQueuePaused(sql, w, actor, repoId, true),
    );
    return c.json(res);
  });

  app.post("/api/admin/workspaces/:id/queues/:repoId/resume", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    requireThat(
      Number.isSafeInteger(repoId) && repoId > 0,
      "invalid_repository_id",
      400,
    );
    const res = await change(c, async (w, actor, sql) =>
      setRepoQueuePaused(sql, w, actor, repoId, false),
    );
    return c.json(res);
  });

  app.post(
    "/api/admin/workspaces/:id/queues/:repoId/items/:itemId/pin",
    async (c) => {
      const repoId = Number(c.req.param("repoId"));
      const itemId = c.req.param("itemId");
      requireThat(
        Number.isSafeInteger(repoId) && repoId > 0,
        "invalid_repository_id",
        400,
      );
      const item = await change(c, async (w, actor, sql) =>
        pinRepoQueueItem(sql, w, actor, repoId, itemId),
      );
      return c.json({ item });
    },
  );

  app.post(
    "/api/admin/workspaces/:id/queues/:repoId/items/:itemId/cancel",
    async (c) => {
      const repoId = Number(c.req.param("repoId"));
      const itemId = c.req.param("itemId");
      requireThat(
        Number.isSafeInteger(repoId) && repoId > 0,
        "invalid_repository_id",
        400,
      );
      const res = await change(c, async (w, actor, sql) =>
        cancelRepoQueueItem(sql, w, actor, repoId, itemId),
      );
      return c.json(res);
    },
  );

  return app;
}
