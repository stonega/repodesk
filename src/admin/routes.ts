import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { credentialsSchema } from "../agent/model-settings.ts";
import type { PluginService } from "../agent/plugin-service.ts";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  requireThat,
  type Session,
  settingsSchema,
  skillSchema,
  userId,
  type Workspace,
  workflowSchema,
} from "../domain.ts";
import { reconcileCharge, resolveDelivery } from "../jobs/recovery.ts";
import { logQuery, readRuntimeLogs } from "../observability/logs.ts";
import { requestDeletion } from "../privacy/service.ts";
import { equal, hash, passwordHash } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import { changeSkill, saveSkill, testSkill } from "../skills/catalog.ts";
import { importMarkdown } from "../skills/import.ts";
import { nextOccurrences } from "../workflows/schedule.ts";
import {
  decide,
  proposeInstruction,
  proposeWorkflow,
  workflowAction,
} from "../workflows/service.ts";
import {
  audit,
  authorize,
  eligible,
  revokeWork,
  setPolicy,
} from "../workspaces/policy.ts";
import { cancelRun, createRun, visibleRuns } from "../workspaces/service.ts";
import { claim, login, operator, session, throttle } from "./auth.ts";

type Env = { Variables: { session: Session } };
const version = z.number().int().positive();
const authInput = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
  password: z.string().min(12).max(256),
});
const policyInput = z
  .object({
    version,
    mode: z.enum(["whitelist", "members"]),
    allowed: z.array(userId).max(500),
  })
  .strict();
const validId = (id: string) => z.uuid().parse(id);

import type { GitHubService } from "../github/service.ts";

export function adminRoutes(
  store: Store,
  setup: SetupService,
  origin: string,
  plugins: PluginService,
  github: GitHubService,
) {
  const app = new Hono<Env>();
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method))
      requireThat(c.req.header("origin") === origin, "origin_denied", 403);
    if (
      c.req.path === "/api/setup/status" ||
      c.req.path === "/api/setup/claim" ||
      c.req.path === "/api/admin/auth/login"
    )
      return next();
    const current = await session(store.pool, getCookie(c, "deepx_session"));
    requireThat(current, "authentication_required", 401);
    c.set("session", current);
    if (!["GET", "HEAD"].includes(c.req.method))
      requireThat(
        equal(c.req.header("x-csrf-token") ?? "", current.csrf),
        "csrf_denied",
        403,
      );
    await next();
  });
  const cookieOptions = {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 8 * 3600,
  };
  app.get("/api/setup/status", async (c) => {
    const row = (
      await store.pool.query("SELECT claimed FROM deployment WHERE id=true")
    ).rows[0];
    return c.json({ initialized: !!row?.claimed });
  });
  app.post("/api/setup/claim", async (c) => {
    await throttle(store.pool, "claim");
    const input = authInput
      .extend({ token: z.string().max(100) })
      .strict()
      .parse(await c.req.json());
    const result = await claim(
      store.pool,
      input.token,
      input.username,
      input.password,
    );
    setCookie(c, "deepx_session", result.raw, cookieOptions);
    return c.json({ csrf: result.csrf });
  });
  app.post("/api/admin/auth/login", async (c) => {
    const input = authInput.strict().parse(await c.req.json());
    await throttle(store.pool, `login:${input.username}`);
    const result = await login(store.pool, input.username, input.password);
    setCookie(c, "deepx_session", result.raw, cookieOptions);
    return c.json({ csrf: result.csrf });
  });
  app.get("/api/admin/auth/session", (c) => c.json(c.get("session")));
  app.post("/api/admin/auth/logout", async (c) => {
    await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(getCookie(c, "deepx_session") ?? ""),
    ]);
    deleteCookie(c, "deepx_session", { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/setup/progress", async (c) =>
    c.json(await setup.progress(c.get("session").admin)),
  );
  app.post("/api/setup/workspaces", async (c) =>
    c.json(
      await setup.createWorkspace(
        c.get("session").admin,
        settingsSchema.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.put("/api/setup/workspaces/:id", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    const input = z
      .object({ version, settings: settingsSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await store.change(validId(c.req.param("id")), (w) => {
        requireThat(
          w.operatorId === admin.id &&
            !w.members.some((m) => m.role === "owner"),
          "use_workspace_settings",
          409,
        );
        requireThat(w.version === input.version, "version_conflict", 409);
        w.settings = input.settings;
        w.version++;
        audit(w, admin.id, "setup.settings_updated", w.id, w.version);
        return { version: w.version };
      }),
    );
  });
  app.put("/api/admin/operator/credentials", async (c) =>
    c.json(
      await setup.saveCredentials(
        c.get("session").admin,
        credentialsSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post("/api/setup/identity/:id", async (c) =>
    c.json(
      await setup.identityToken(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.post("/api/setup/webhook", async (c) =>
    c.json(await setup.register(c.get("session").admin)),
  );
  app.post("/api/setup/activate", async (c) =>
    c.json(await setup.activate(c.get("session").admin)),
  );
  app.get("/api/admin/github/app/callback", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    try {
      const input = z
        .object({
          state: z.string().min(20).max(200),
          code: z.string().min(1).max(200).optional(),
        })
        .parse(c.req.query());
      const id = await github.registrationResult(
        c.get("session").admin,
        hash(getCookie(c, "deepx_session") ?? ""),
        input.state,
        input.code,
      );
      return c.redirect(`/admin/plugins?workspace=${id}&github=app-created`);
    } catch {
      return c.redirect("/admin/plugins?github=registration-failed");
    }
  });
  app.post("/api/admin/workspaces/:id/github/register", async (c) => {
    const raw = getCookie(c, "deepx_session") ?? "";
    const result = await github.register(
      c.get("session").admin,
      validId(c.req.param("id")),
      hash(raw),
      await c.req.json(),
    );
    setCookie(c, "deepx_session", raw, {
      ...cookieOptions,
      maxAge: Math.max(
        0,
        Math.floor(
          (Date.parse(c.get("session").expiresAt) - Date.now()) / 1000,
        ),
      ),
    });
    return c.json(result);
  });
  app.get("/api/admin/github/callback", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    try {
      const input = z
        .object({
          state: z.string().min(20).max(200),
          code: z.string().min(1).max(1000).optional(),
        })
        .parse(c.req.query());
      const id = await github.callbackResult(
        c.get("session").admin,
        hash(getCookie(c, "deepx_session") ?? ""),
        input.state,
        input.code,
      );
      return c.redirect(`/admin/plugins?workspace=${id}&github=authorized`);
    } catch {
      return c.redirect("/admin/plugins?github=failed");
    }
  });
  app.get("/api/admin/workspaces/:id/github", async (c) =>
    c.json(
      await github.view(
        c.get("session").admin,
        validId(c.req.param("id")),
        hash(getCookie(c, "deepx_session") ?? ""),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/github/connect", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const raw = getCookie(c, "deepx_session") ?? "";
    const result = await github.begin(
      c.get("session").admin,
      validId(c.req.param("id")),
      hash(raw),
    );
    // Refresh existing Strict cookies for the top-level OAuth return. All ordinary writes still require Origin and CSRF.
    setCookie(c, "deepx_session", raw, {
      ...cookieOptions,
      maxAge: Math.max(
        0,
        Math.floor(
          (Date.parse(c.get("session").expiresAt) - Date.now()) / 1000,
        ),
      ),
    });
    return c.json(result);
  });
  app.get(
    "/api/admin/workspaces/:id/github/installations/:installationId/repositories",
    async (c) =>
      c.json(
        await github.repositories(
          c.get("session").admin,
          validId(c.req.param("id")),
          hash(getCookie(c, "deepx_session") ?? ""),
          z.coerce
            .number()
            .int()
            .positive()
            .parse(c.req.param("installationId")),
        ),
      ),
  );
  app.put("/api/admin/workspaces/:id/github", async (c) =>
    c.json(
      await github.connect(
        c.get("session").admin,
        validId(c.req.param("id")),
        hash(getCookie(c, "deepx_session") ?? ""),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/api/admin/workspaces/:id/github", async (c) =>
    c.json(
      await github.disconnect(
        c.get("session").admin,
        validId(c.req.param("id")),
        hash(getCookie(c, "deepx_session") ?? ""),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/code-truth", async (c) =>
    c.json(
      await plugins.codeTruthView(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.put("/api/admin/workspaces/:id/plugins/code-truth", async (c) =>
    c.json(
      await plugins.saveCodeTruth(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/plugins/code-truth/status", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(
      await plugins.codeTruthStatus(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    );
  });
  app.get("/api/admin/workspaces/:id/plugins", async (c) =>
    c.json(
      await plugins.view(c.get("session").admin, validId(c.req.param("id"))),
    ),
  );
  app.put("/api/admin/workspaces/:id/plugins", async (c) =>
    c.json(
      await plugins.save(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
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
        "SELECT (SELECT count(*) FROM outbox WHERE dispatched_at IS NULL)::int AS pending, (SELECT extract(epoch from now()-min(created_at)) FROM outbox WHERE dispatched_at IS NULL)::float AS oldest_seconds, (SELECT count(*) FROM worker_heartbeats WHERE at>now()-interval '30 seconds')::int AS workers, (SELECT count(*) FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'runs') r WHERE r->>'status'='failed')::int AS failed_runs, (SELECT count(*) FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'deliveries') d WHERE d->>'state'='delivery_unknown')::int AS unknown_deliveries",
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
      if (!w.policy.allowed.includes(member.id))
        w.policy.allowed.push(member.id);
      w.policy.version++;
      audit(w, admin.id, "access.recovered", member.id, w.policy.version);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'workspace.recovered',$2)",
        [admin.id, w.id],
      );
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/workspaces", async (c) => {
    const actor = c.get("session").admin.telegramId;
    return c.json(
      (await store.all())
        .filter((w) => actor && eligible(w, actor, true))
        .map((w) => ({ id: w.id, name: w.settings.name })),
    );
  });
  app.use("/api/admin/workspaces/:id/*", async (c, next) => {
    const w = await store.read(validId(c.req.param("id") ?? ""));
    authorize(w, c.get("session").admin.telegramId, true);
    await next();
  });
  app.get("/api/admin/workspaces/:id/:resource", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = authorize(w, c.get("session").admin.telegramId, true);
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const take = <T>(items: T[]) => ({
      items: items.slice(offset, offset + 100),
      total: items.length,
      offset,
    });
    switch (c.req.param("resource")) {
      case "overview":
        return c.json({
          id: w.id,
          settings: w.settings,
          version: w.version,
          counts: {
            members: w.members.filter((m) => m.active).length,
            runs: visibleRuns(w, actor).length,
            workflows: w.workflows.filter((f) => f.status === "active").length,
          },
          policyVersion: w.policy.version,
        });
      case "settings":
        return c.json({ version: w.version, settings: w.settings });
      case "access-policy":
        return c.json({
          ...w.policy,
          members: w.members,
          affected: {
            runs: w.runs
              .filter((r) => ["queued", "running"].includes(r.status))
              .map((r) => ({ id: r.id, actor: r.actor })),
            workflows: w.workflows
              .filter((f) => f.status === "active")
              .map((f) => ({ id: f.id, owner: f.owner })),
          },
        });
      case "members":
        return c.json(take(w.members));
      case "chats":
        return c.json(take(w.chats));
      case "workflows":
        return c.json(
          take(
            w.workflows
              .filter(
                (f) =>
                  f.status !== "deleted" &&
                  (f.owner === actor ||
                    w.chats.some((c) => c.id === f.spec.chatId && c.active)),
              )
              .map((f) => ({
                ...f,
                next: nextOccurrences(f.spec.recurrence, new Date()),
              })),
          ),
        );
      case "approvals":
        return c.json(
          take(w.approvals.filter((a) => a.actor === actor && !a.decision)),
        );
      case "skills":
        return c.json(
          take(
            w.skills.map((s) => ({
              ...s,
              dependents: w.workflows
                .filter((f) => f.spec.skillId === s.id)
                .map((f) => ({
                  id: f.id,
                  name: f.spec.name,
                  version: f.skillVersion,
                  status: f.status,
                })),
            })),
          ),
        );
      case "instructions":
        return c.json(
          take(
            w.instructions.filter(
              (i) => i.active && (i.scope !== "personal" || i.author === actor),
            ),
          ),
        );
      case "runs":
        return c.json(
          take(
            visibleRuns(w, actor)
              .toReversed()
              .map((r) => ({
                ...r,
                deliveries: w.deliveries.filter((d) => d.runId === r.id),
              })),
          ),
        );
      case "usage": {
        const attempts = w.runs.flatMap((r) =>
          r.attempts.map((a) => ({ ...a, runId: r.id, model: r.model })),
        );
        return c.json({
          budget: w.settings.monthlyBudgetUsd,
          totalUsd: attempts.reduce((n, a) => n + (a.actual ?? a.reserved), 0),
          ...take(attempts.toReversed()),
        });
      }
      case "audit":
        return c.json(take(w.audit.toReversed()));
      case "deletion":
        return c.json(
          w.deletion ?? {
            status: "not_requested",
            retentionDays: w.settings.retentionDays,
          },
        );
      default:
        return c.json({ error: "not_found" }, 404);
    }
  });
  const change = async <T>(
    c: {
      req: { param: (key: string) => string };
      get: (key: "session") => Session;
    },
    fn: (w: Workspace, actor: string) => T,
  ) =>
    store.change(validId(c.req.param("id")), (w) =>
      fn(w, authorize(w, c.get("session").admin.telegramId, true)),
    );
  app.put("/api/admin/workspaces/:id/settings", async (c) => {
    const input = z
      .object({ version, settings: settingsSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        requireThat(w.version === input.version, "version_conflict", 409);
        w.settings = input.settings;
        w.version++;
        revokeWork(w);
        audit(w, actor, "settings.updated", w.id, w.version);
        return { version: w.version, settings: w.settings };
      }),
    );
  });
  app.put("/api/admin/workspaces/:id/access-policy", async (c) => {
    const input = policyInput.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        setPolicy(w, actor, input.version, input.mode, input.allowed);
        return w.policy;
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/access-policy/preview", async (c) => {
    const input = policyInput.parse(await c.req.json());
    return c.json(
      await change(c, (w) => {
        const removed = w.members.filter(
          (m) =>
            m.active &&
            input.mode === "whitelist" &&
            !input.allowed.includes(m.id),
        );
        return {
          added: input.allowed.filter((id) => !w.policy.allowed.includes(id)),
          removed: w.policy.allowed.filter((id) => !input.allowed.includes(id)),
          revoked: removed.map((m) => m.id),
          runs: w.runs
            .filter(
              (r) =>
                removed.some((m) => m.id === r.actor) &&
                ["queued", "running"].includes(r.status),
            )
            .map((r) => r.id),
          workflows: w.workflows
            .filter(
              (f) =>
                removed.some((m) => m.id === f.owner) && f.status === "active",
            )
            .map((f) => f.id),
        };
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/members", async (c) => {
    const input = z
      .object({
        id: userId,
        role: z.enum(["admin", "member"]),
        active: z.boolean(),
        allow: z.boolean(),
        version,
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        requireThat(
          w.policy.version === input.version,
          "version_conflict",
          409,
        );
        const previous = w.members.find((m) => m.id === input.id);
        requireThat(
          previous?.role !== "owner",
          "owner_requires_host_recovery",
          409,
        );
        if (previous)
          Object.assign(previous, { role: input.role, active: input.active });
        else
          w.members.push({
            id: input.id,
            role: input.role,
            active: input.active,
          });
        if (input.allow && !w.policy.allowed.includes(input.id))
          w.policy.allowed.push(input.id);
        requireThat(
          w.members.some(
            (m) =>
              m.active &&
              m.role !== "member" &&
              (w.policy.mode === "members" || w.policy.allowed.includes(m.id)),
          ),
          "last_admin_lockout",
          409,
        );
        w.policy.version++;
        revokeWork(w);
        audit(w, actor, "member.updated", input.id, w.policy.version);
        if (input.allow)
          audit(w, actor, "access.allowed", input.id, w.policy.version);
        return w.members;
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/chats/:chat/action", async (c) => {
    const input = z
      .object({ action: z.enum(["collect", "directed", "unlink"]) })
      .strict()
      .parse(await c.req.json());
    const id = c.req.param("chat");
    await store.change(validId(c.req.param("id")), async (w, sql) => {
      const actor = authorize(w, c.get("session").admin.telegramId, true);
      const chat = w.chats.find((c) => c.id === id);
      requireThat(chat, "not_found", 404);
      if (input.action === "collect") {
        requireThat(chat.active && chat.visibleAll, "bot_visibility_required");
        chat.collection = true;
        chat.consentAt = new Date().toISOString();
        chat.consentBy = actor;
      } else chat.collection = false;
      if (input.action === "unlink") {
        chat.active = false;
        await sql.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
          w.id,
        ]);
      }
      revokeWork(w);
      audit(w, actor, `chat.${input.action}`, id);
    });
    return c.json({ ok: true });
  });
  app.post("/api/admin/workspaces/:id/workflows", async (c) => {
    const input = workflowSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => proposeWorkflow(w, actor, input)),
      201,
    );
  });
  app.put("/api/admin/workspaces/:id/workflows/:workflow", async (c) => {
    const input = z
      .object({ version, spec: workflowSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        proposeWorkflow(
          w,
          actor,
          input.spec,
          new Date(),
          c.req.param("workflow"),
          input.version,
        ),
      ),
    );
  });
  app.post(
    "/api/admin/workspaces/:id/workflows/:workflow/action",
    async (c) => {
      const input = z
        .object({
          version,
          action: z.enum(["pause", "resume", "delete", "run"]),
        })
        .strict()
        .parse(await c.req.json());
      const d = await store.deployment();
      return c.json(
        await change(c, (w, actor) =>
          workflowAction(
            w,
            actor,
            c.req.param("workflow"),
            input.action,
            input.version,
            d.model,
          ),
        ),
      );
    },
  );
  app.post("/api/admin/workspaces/:id/approvals/:approval", async (c) => {
    const input = z
      .object({ approve: z.boolean() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        decide(w, actor, c.req.param("approval"), input.approve),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/instructions", async (c) => {
    const input = z
      .object({
        body: z.string().min(1).max(4000),
        scope: z.enum(["personal", "workspace", "workflow"]),
        workflowId: z.string().optional(),
        replaceId: z.string().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        proposeInstruction(
          w,
          actor,
          input.body,
          input.scope,
          "admin_panel",
          input.workflowId,
          input.replaceId,
        ),
      ),
      201,
    );
  });
  app.delete(
    "/api/admin/workspaces/:id/instructions/:instruction",
    async (c) => {
      const input = z
        .object({ version })
        .strict()
        .parse(await c.req.json());
      await change(c, (w, actor) => {
        const i = w.instructions.find(
          (i) => i.id === c.req.param("instruction"),
        );
        requireThat(
          i && (i.scope !== "personal" || i.author === actor),
          "not_found",
          404,
        );
        requireThat(i.version === input.version, "version_conflict", 409);
        i.active = false;
        i.body = "";
        i.version++;
        audit(w, actor, "instruction.forgotten", i.id, i.version);
      });
      return c.json({ ok: true });
    },
  );
  app.post("/api/admin/workspaces/:id/skills/import", async (c) => {
    const input = z
      .object({ markdown: z.string().max(16384) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveSkill(w, actor, importMarkdown(input.markdown)),
      ),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/skills", async (c) => {
    const spec = skillSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => saveSkill(w, actor, spec)),
      201,
    );
  });
  app.put("/api/admin/workspaces/:id/skills/:skill", async (c) => {
    const input = z
      .object({ version, spec: skillSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveSkill(w, actor, input.spec, c.req.param("skill"), input.version),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/skills/:skill/action", async (c) => {
    const input = z
      .object({
        version,
        action: z.enum(["publish", "enable", "disable", "archive", "rollback"]),
        pin: z.number().int().positive().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        changeSkill(
          w,
          actor,
          c.req.param("skill"),
          input.version,
          input.action,
          input.pin,
        ),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/skills/:skill/test", async (c) => {
    const input = z
      .object({ sample: z.string().max(4000) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        testSkill(w, actor, c.req.param("skill"), input.sample),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/runs", async (c) => {
    const input = z
      .object({
        task: z.string().min(1).max(4000),
        chatId: z.string(),
        topicId: z.number().int().nonnegative().default(0),
      })
      .strict()
      .parse(await c.req.json());
    const d = await store.deployment();
    requireThat(d.active && !d.paused, "deployment_inactive", 409);
    return c.json(
      await change(c, (w, actor) =>
        createRun(w, actor, input.task, input.chatId, input.topicId, d.model),
      ),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/runs/:run/cancel", async (c) =>
    c.json(
      await change(c, (w, actor) => cancelRun(w, actor, c.req.param("run"))),
    ),
  );
  app.post("/api/admin/workspaces/:id/runs/:run/retry", async (c) => {
    const d = await store.deployment();
    return c.json(
      await change(c, (w, actor) => {
        const r = visibleRuns(w, actor).find(
          (r) => r.id === c.req.param("run"),
        );
        requireThat(
          r && ["failed", "cancelled", "partial"].includes(r.status),
          "run_not_retryable",
          409,
        );
        return createRun(w, actor, r.task, r.chatId, r.topicId, d.model, {
          workflowId: r.workflowId,
        });
      }),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/deletion", async (c) =>
    c.json(await change(c, (w, actor) => requestDeletion(w, actor)), 201),
  );
  app.post("/api/admin/workspaces/:id/runs/:run/reconcile", async (c) => {
    const input = z
      .object({
        attemptId: z.string(),
        actualUsd: z.number().min(0).max(100),
        reference: z.string().min(3).max(100),
      })
      .strict()
      .parse(await c.req.json());
    await change(c, (w, actor) =>
      reconcileCharge(
        w,
        actor,
        c.req.param("run"),
        input.attemptId,
        input.actualUsd,
        input.reference,
      ),
    );
    return c.json({ ok: true });
  });
  app.post(
    "/api/admin/workspaces/:id/deliveries/:delivery/resolve",
    async (c) => {
      const input = z
        .object({
          action: z.enum(["confirm_sent", "abandon"]),
          remoteId: z.number().int().positive().optional(),
        })
        .strict()
        .parse(await c.req.json());
      await change(c, (w, actor) =>
        resolveDelivery(
          w,
          actor,
          c.req.param("delivery"),
          input.action,
          input.remoteId,
        ),
      );
      return c.json({ ok: true });
    },
  );
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
  app.post("/api/admin/workspaces/:id/chats/:chat/visibility", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    authorize(w, c.get("session").admin.telegramId, true);
    const me = await (await setup.client()).call<{
      can_read_all_group_messages?: boolean;
    }>("getMe");
    return c.json(
      await change(c, (w, actor) => {
        const chat = w.chats.find((chat) => chat.id === c.req.param("chat"));
        requireThat(chat, "not_found", 404);
        chat.visibleAll = !!me.can_read_all_group_messages;
        if (!chat.visibleAll) chat.collection = false;
        audit(w, actor, "chat.visibility_checked", chat.id);
        return chat;
      }),
    );
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
            .filter((d) => d.runId === id)
            .map((d) => ({ id: d.id, state: d.state, remoteId: d.remoteId })),
        });
    }
    return c.json({ error: "not_found" }, 404);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
