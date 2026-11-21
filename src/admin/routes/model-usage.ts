import { Hono } from "hono";
import { z } from "zod";
import {
  queryModelUsageAnalytics,
  USAGE_SOURCE_KINDS,
} from "../../usage/model-usage.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  validId,
  workspaceActor,
} from "./shared.ts";

const modelUsageQuerySchema = z.object({
  range: z.enum(["24h", "7d", "30d", "90d", "all"]).default("30d"),
  source: z.enum(USAGE_SOURCE_KINDS).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["settled", "reserved", "unknown", "failed"]).optional(),
  actor: z.string().trim().min(1).max(120).optional(),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function modelUsageRoutes(deps: AdminRouteDeps) {
  const { store } = deps;
  const app = new Hono<AdminEnv>();

  app.get("/api/admin/workspaces/:id/model-usage", async (c) => {
    const id = validId(c.req.param("id"));
    const w = await store.read(id);
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    const operatorOnly = actor === admin.id;
    const raw = c.req.query();
    const parsed = modelUsageQuerySchema.parse({
      range: raw.range || undefined,
      source: raw.source || undefined,
      model: raw.model || undefined,
      status: raw.status || undefined,
      actor: raw.actor || undefined,
      offset: raw.offset || undefined,
      limit: raw.limit || undefined,
    });
    const analytics = await queryModelUsageAnalytics(
      store.pool,
      w,
      parsed,
      operatorOnly,
    );
    return c.json(analytics);
  });

  return app;
}
