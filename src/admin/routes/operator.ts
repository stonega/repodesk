import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { transaction } from "../../db/pool.ts";
import { requireThat, userId } from "../../domain.ts";
import { logQuery, readRuntimeLogs } from "../../observability/logs.ts";
import { passwordHash } from "../../setup/credentials.ts";
import { audit, eligible } from "../../workspaces/policy.ts";
import { operator } from "../auth.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  authInput,
  validId,
  version,
} from "./shared.ts";

export function operatorRoutes(deps: AdminRouteDeps) {
  const { store, setup } = deps;
  const app = new Hono<AdminEnv>();

  app.get("/api/admin/operator/logs", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    return c.json(
      await readRuntimeLogs(
        store.pool,
        admin.id,
        logQuery.parse(c.req.query()),
      ),
    );
  });
  app.get("/api/admin/operator/health", async (c) => {
    operator(c.get("session").admin);
    const metrics = (
      await store.pool.query(
        "SELECT (SELECT count(*) FROM outbox WHERE dispatched_at IS NULL)::int AS pending, (SELECT extract(epoch from now()-min(created_at)) FROM outbox WHERE dispatched_at IS NULL)::float AS oldest_seconds, (SELECT count(*) FROM worker_heartbeats WHERE at>now()-interval '30 seconds')::int AS workers, ((SELECT count(*) FROM workspace_runs WHERE status='failed') + (SELECT count(*) FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'runs','[]'::jsonb)) r WHERE w.data ? 'runs' AND r->>'status'='failed'))::int AS failed_runs, ((SELECT count(*) FROM workspace_deliveries WHERE state='delivery_unknown') + (SELECT count(*) FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'deliveries','[]'::jsonb)) d WHERE w.data ? 'deliveries' AND d->>'state'='delivery_unknown'))::int AS unknown_deliveries",
      )
    ).rows[0];
    return c.json({
      ...metrics,
      paused: (await store.deployment()).paused,
      audit: (
        await store.pool.query(
          "SELECT actor,action,target,at FROM operator_audit ORDER BY id DESC LIMIT 100",
        )
      ).rows,
    });
  });
  app.post("/api/admin/operator/pause", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    const input = z
      .object({ paused: z.boolean(), version })
      .strict()
      .parse(await c.req.json());
    await transaction(store.pool, async (sql) => {
      const d = await store.deployment(sql, true);
      requireThat(d.version === input.version, "version_conflict", 409);
      d.paused = input.paused;
      d.version++;
      await store.saveDeployment(sql, d);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'deployment.pause_changed','deployment')",
        [admin.id],
      );
    });
    return c.json({ ok: true });
  });
  app.post("/api/admin/operator/accounts", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    const input = authInput.strict().parse(await c.req.json());
    const id = randomUUID();
    const encoded = await passwordHash(input.password);
    await transaction(store.pool, async (sql) => {
      await sql.query(
        "INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3)",
        [id, input.username, encoded],
      );
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'account.created',$2)",
        [admin.id, id],
      );
    });
    return c.json({ id }, 201);
  });
  app.post("/api/admin/operator/accounts/:account/link", async (c) => {
    const input = z
      .object({ workspaceId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await setup.accountIdentityToken(
        c.get("session").admin,
        validId(c.req.param("account")),
        input.workspaceId,
      ),
    );
  });
  app.post("/api/admin/operator/recover/:id", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    const input = z
      .object({ telegramId: userId })
      .strict()
      .parse(await c.req.json());
    await store.change(validId(c.req.param("id")), async (w, sql) => {
      requireThat(w.operatorId === admin.id, "access_denied", 403);
      const member = w.members.find(
        (m) => m.id === input.telegramId && m.role !== "member",
      );
      requireThat(member, "existing_admin_required");
      member.active = true;
      w.memberVersion++;
      audit(w, admin.id, "access.recovered", member.id, w.memberVersion);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'workspace.recovered',$2)",
        [admin.id, w.id],
      );
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/operator/runs/:run", async (c) => {
    operator(c.get("session").admin);
    const id = validId(c.req.param("run"));
    for (const w of await store.all()) {
      const r = w.runs.find((r) => r.id === id);
      if (r)
        return c.json({
          runId: r.id,
          workspaceId: w.id,
          status: r.status,
          error: r.error,
          at: r.at,
          finishedAt: r.finishedAt,
          model: r.model,
          settingsVersion: r.settingsVersion,
          workflowVersion: r.workflowVersion,
          attempts: r.attempts.map((a) => ({
            id: a.id,
            status: a.status,
            reserved: a.reserved,
            actual: a.actual,
          })),
          deliveries: w.deliveries
            .filter((d) => d.runId === id || d.cancellationRunId === id)
            .map((d) => ({ id: d.id, state: d.state, remoteId: d.remoteId })),
        });
    }
    return c.json({ error: "not_found" }, 404);
  });
  app.get("/api/admin/workspaces", async (c) => {
    const admin = c.get("session").admin;
    return c.json(
      (await store.all())
        .filter(
          (w) =>
            !w.deletion &&
            ((admin.telegramId && eligible(w, admin.telegramId, true)) ||
              (admin.operator && w.operatorId === admin.id)),
        )
        .map((w) => ({ id: w.id, name: w.settings.name })),
    );
  });
  return app;
}
