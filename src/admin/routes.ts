import { randomUUID } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { credentialsSchema } from "../agent/model-settings.ts";
import type { PluginService } from "../agent/plugin-service.ts";
import { modelCapabilities } from "../agent/runtime.ts";
import { cloudflareStateWorkspace } from "../cloudflare/oauth.ts";
import type { LocalDeviceAuth } from "../coding/local/protocol.ts";
import { codingView, saveCoding } from "../coding/service.ts";
import { taskGet, taskList, taskSave } from "../coding/task-store.ts";
import { cancelRequest } from "../coding/tasks.ts";
import { type Sql, transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Admin,
  Fault,
  requireThat,
  type Session,
  settingsSchema,
  skillSchema,
  userId,
  type Workspace,
  workflowSchema,
} from "../domain.ts";
import { type GitHubMember, githubUsernameSchema } from "../github/app.ts";
import { assignGitHubAccount } from "../github/member-account.ts";
import { reconcileCharge, resolveDelivery } from "../jobs/recovery.ts";
import { logQuery, readRuntimeLogs } from "../observability/logs.ts";
import { ObsidianService } from "../obsidian/service.ts";
import { requestDeletion } from "../privacy/service.ts";
import type { ReviewService } from "../review-bot/service.ts";
import { searchProviderIdSchema } from "../search/config.ts";
import {
  equal,
  fingerprint,
  hash,
  passwordHash,
} from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import {
  changeSkill,
  isPresetSkill,
  saveManagedSkill,
  testSkill,
} from "../skills/catalog.ts";
import { githubSkillUrl } from "../skills/github-source.ts";
import { importMarkdown } from "../skills/import.ts";
import { TelegramError } from "../telegram/client.ts";
import { groupVisibility } from "../telegram/visibility.ts";
import { nextOccurrences } from "../workflows/schedule.ts";
import {
  decide,
  proposeInstruction,
  proposeWorkflow,
  workflowAction,
} from "../workflows/service.ts";
import { decideAccessRequest } from "../workspaces/access-requests.ts";
import { issueGroupLink } from "../workspaces/group-links.ts";
import { membersWithProfiles } from "../workspaces/member-profile.ts";
import {
  audit,
  authorize,
  eligible,
  revokeWork,
  updateMembership,
} from "../workspaces/policy.ts";
import { createRun, visibleRuns } from "../workspaces/service.ts";
import { claim, login, operator, session, throttle } from "./auth.ts";
import { runSummaries } from "./run-history.ts";
import { SelfCheckService } from "./self-check.ts";
import { deploymentOrigin, SiteService } from "./site.ts";
import {
  historyPage,
  runThreadKey,
  threadDetail,
  threadGroups,
  threadKey,
  threadSummaries,
} from "./thread-history.ts";
import { workflowOwner, workflowRepositories } from "./workflow-view.ts";

type Env = { Variables: { session: Session } };
const sessionCookie = "repodesk_session";
const sessionCookieValue = (c: Context<Env>) =>
  getCookie(c, sessionCookie) ?? getCookie(c, "deepx_session");
const version = z.number().int().positive();
const authInput = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
  password: z.string().min(12).max(256),
});
const validId = (id: string) => z.uuid().parse(id);
const workspaceActor = (w: Workspace, admin: Admin) => {
  if (admin.telegramId && eligible(w, admin.telegramId, true))
    return admin.telegramId;
  if (admin.operator && w.operatorId === admin.id && !w.deletion)
    return admin.id;
  return authorize(w, admin.telegramId, true);
};

import {
  type LocalRuntimeControl,
  runtimeSave,
} from "../coding/runtime-config.ts";
import type { GitHubService } from "../github/service.ts";
import type { ReleaseUpdates } from "../updates/releases.ts";

export function adminRoutes(
  store: Store,
  setup: SetupService,
  origin: string,
  plugins: PluginService,
  github: GitHubService,
  encryptionKey?: string,
  deviceAuth?: LocalDeviceAuth & Partial<LocalRuntimeControl>,
  review?: ReviewService,
  updates?: ReleaseUpdates,
  selfCheck = new SelfCheckService(store, setup),
) {
  const app = new Hono<Env>();
  const site = new SiteService(store, origin);
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const configured = deploymentOrigin(await store.deployment(), origin);
      requireThat(
        [origin, configured].includes(c.req.header("origin") ?? ""),
        "origin_denied",
        403,
      );
    }
    if (
      c.req.path === "/api/setup/status" ||
      c.req.path === "/api/setup/claim" ||
      c.req.path === "/api/admin/auth/login"
    )
      return next();
    const current = await session(store.pool, sessionCookieValue(c));
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
  const cookieOptions = (c: Context<Env>) => ({
    httpOnly: true,
    secure: (c.req.header("origin") ?? origin).startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 8 * 3600,
  });
  app.get("/api/setup/status", async (c) => {
    const row = (
      await store.pool.query("SELECT claimed FROM deployment WHERE id=true")
    ).rows[0];
    return c.json({ initialized: !!row?.claimed });
  });
  app.get("/api/admin/updates", async (c) => {
    requireThat(updates, "updates_unavailable", 503);
    return c.json(await updates.view(c.get("session").admin));
  });
  app.post("/api/admin/operator/updates", async (c) => {
    requireThat(updates, "updates_unavailable", 503);
    return c.json(
      await updates.start(c.get("session").admin, await c.req.json()),
    );
  });
  app.post("/api/setup/claim", async (c) => {
    await throttle(store.pool, "claim");
    const input = authInput.strict().parse(await c.req.json());
    const result = await claim(store.pool, input.username, input.password);
    setCookie(c, sessionCookie, result.raw, cookieOptions(c));
    return c.json({ csrf: result.csrf });
  });
  app.post("/api/admin/auth/login", async (c) => {
    const input = authInput.strict().parse(await c.req.json());
    await throttle(store.pool, `login:${input.username}`);
    const result = await login(store.pool, input.username, input.password);
    setCookie(c, sessionCookie, result.raw, cookieOptions(c));
    return c.json({ csrf: result.csrf });
  });
  app.get("/api/admin/auth/session", (c) => c.json(c.get("session")));
  app.get("/api/admin/operator/coding-runtime", async (c) => {
    operator(c.get("session").admin);
    requireThat(
      deviceAuth?.runtimeStatus,
      "coding_runtime_control_unavailable",
      503,
    );
    return c.json(await deviceAuth.runtimeStatus());
  });
  app.put("/api/admin/operator/coding-runtime", async (c) => {
    const admin = c.get("session").admin;
    operator(admin);
    requireThat(
      deviceAuth?.runtimeSave,
      "coding_runtime_control_unavailable",
      503,
    );
    const value = runtimeSave.parse(await c.req.json());
    const result = await deviceAuth.runtimeSave(value);
    try {
      await store.pool.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'coding.runtime_selected',$2)",
        [admin.id, value.selection ?? "environment"],
      );
    } catch {
      throw new Fault("coding_outcome_unknown", 503);
    }
    return c.json(result);
  });
  app.get("/api/admin/operator/site", async (c) =>
    c.json(await site.view(c.get("session").admin, setup.telegramTransport)),
  );
  app.put("/api/admin/operator/site", async (c) => {
    await site.save(c.get("session").admin, await c.req.json());
    return c.json(
      await site.view(c.get("session").admin, setup.telegramTransport),
    );
  });
  app.post("/api/admin/auth/logout", async (c) => {
    await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(sessionCookieValue(c) ?? ""),
    ]);
    deleteCookie(c, sessionCookie, { path: "/" });
    deleteCookie(c, "deepx_session", { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/setup/progress", async (c) =>
    c.json(await setup.progress(c.get("session").admin)),
  );
  app.get("/api/admin/operator/model-providers", async (c) =>
    c.json(await setup.models.catalog(c.get("session").admin)),
  );
  app.get("/api/admin/operator/search-providers", async (c) =>
    c.json(await setup.search.catalog(c.get("session").admin)),
  );
  app.put("/api/admin/operator/search-providers", async (c) =>
    c.json(await setup.search.save(c.get("session").admin, await c.req.json())),
  );
  app.delete("/api/admin/operator/search-providers/:provider", async (c) => {
    const input = z
      .object({ version })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await setup.search.remove(
        c.get("session").admin,
        searchProviderIdSchema.parse(c.req.param("provider")),
        input.version,
      ),
    );
  });
  app.post("/api/admin/operator/model-providers/discover", async (c) =>
    c.json(
      await setup.models.discover(c.get("session").admin, await c.req.json()),
    ),
  );
  app.put("/api/admin/operator/model-providers", async (c) =>
    c.json(await setup.models.save(c.get("session").admin, await c.req.json())),
  );
  app.delete("/api/admin/operator/model-providers/:provider", async (c) => {
    const input = z
      .object({ version })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await setup.models.remove(
        c.get("session").admin,
        validId(c.req.param("provider")),
        input.version,
      ),
    );
  });
  app.get("/api/admin/workspaces/:id/models", async (c) =>
    c.json(
      await setup.models.workspace(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.put("/api/admin/workspaces/:id/models", async (c) =>
    c.json(
      await setup.saveChatModel(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
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
  app.get("/api/setup/workspaces/:id/access", async (c) =>
    c.json(
      await setup.access(c.get("session").admin, validId(c.req.param("id"))),
    ),
  );
  app.post("/api/setup/workspaces/:id/access", async (c) => {
    const input = z
      .object({ actor: userId, version })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await setup.allowMember(
        c.get("session").admin,
        validId(c.req.param("id")),
        input.actor,
        input.version,
      ),
    );
  });
  app.delete("/api/setup/workspaces/:id/access/:actor", async (c) => {
    const input = z
      .object({ version })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await setup.revokeMember(
        c.get("session").admin,
        validId(c.req.param("id")),
        userId.parse(c.req.param("actor")),
        input.version,
      ),
    );
  });
  app.post(
    "/api/setup/workspaces/:id/access-requests/:request/decision",
    async (c) => {
      const input = z
        .object({ version, decision: z.enum(["approved", "rejected"]) })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await setup.decideAccess(
          c.get("session").admin,
          validId(c.req.param("id")),
          validId(c.req.param("request")),
          input.decision,
          input.version,
        ),
      );
    },
  );
  app.get("/api/admin/github/app/callback", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    let fromSetup = false;
    try {
      const input = z
        .object({
          state: z.string().min(20).max(200),
          code: z.string().min(1).max(200).optional(),
        })
        .parse(c.req.query());
      fromSetup = input.state.startsWith("setup_");
      const id = await github.registrationResult(
        c.get("session").admin,
        hash(sessionCookieValue(c) ?? ""),
        input.state,
        input.code,
      );
      return c.redirect(
        fromSetup
          ? `/setup?step=github&workspace=${id}&github=app-created`
          : `/admin/plugins?workspace=${id}&github=app-created`,
      );
    } catch {
      return c.redirect(
        fromSetup
          ? "/setup?step=github&github=registration-failed"
          : "/admin/plugins?github=registration-failed",
      );
    }
  });
  app.post("/api/admin/workspaces/:id/github/register", async (c) => {
    const raw = sessionCookieValue(c) ?? "";
    const result = await github.register(
      c.get("session").admin,
      validId(c.req.param("id")),
      hash(raw),
      await c.req.json(),
    );
    setCookie(c, sessionCookie, raw, {
      ...cookieOptions(c),
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
    let fromSetup = false;
    try {
      const input = z
        .object({
          state: z.string().min(20).max(200),
          code: z.string().min(1).max(1000).optional(),
        })
        .parse(c.req.query());
      fromSetup = input.state.startsWith("setup_");
      const id = await github.callbackResult(
        c.get("session").admin,
        hash(sessionCookieValue(c) ?? ""),
        input.state,
        input.code,
      );
      return c.redirect(
        fromSetup
          ? `/setup?step=github&workspace=${id}&github=authorized`
          : `/admin/plugins?workspace=${id}&github=authorized`,
      );
    } catch {
      return c.redirect(
        fromSetup
          ? "/setup?step=github&github=failed"
          : "/admin/plugins?github=failed",
      );
    }
  });
  app.get("/api/admin/workspaces/:id/github", async (c) =>
    c.json(
      await github.view(
        c.get("session").admin,
        validId(c.req.param("id")),
        hash(sessionCookieValue(c) ?? ""),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/github/connect", async (c) => {
    const input = z
      .object({ source: z.literal("setup").optional() })
      .strict()
      .parse(await c.req.json());
    const raw = sessionCookieValue(c) ?? "";
    const result = await github.begin(
      c.get("session").admin,
      validId(c.req.param("id")),
      hash(raw),
      input.source,
    );
    // Refresh existing Strict cookies for the top-level OAuth return. All ordinary writes still require Origin and CSRF.
    setCookie(c, sessionCookie, raw, {
      ...cookieOptions(c),
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
          hash(sessionCookieValue(c) ?? ""),
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
        hash(sessionCookieValue(c) ?? ""),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/api/admin/workspaces/:id/github", async (c) =>
    c.json(
      await github.disconnect(
        c.get("session").admin,
        validId(c.req.param("id")),
        hash(sessionCookieValue(c) ?? ""),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/review-bot", async (c) => {
    requireThat(review, "review_bot_unavailable", 409);
    return c.json(
      await review.view(c.get("session").admin, validId(c.req.param("id"))),
    );
  });
  app.put("/api/admin/workspaces/:id/plugins/review-bot", async (c) => {
    requireThat(review, "review_bot_unavailable", 409);
    return c.json(
      await review.save(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    );
  });
  app.post(
    "/api/admin/workspaces/:id/plugins/review-bot/webhook",
    async (c) => {
      requireThat(review, "review_bot_unavailable", 409);
      return c.json(
        await review.configureHook(
          c.get("session").admin,
          validId(c.req.param("id")),
          await c.req.json(),
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/review-bot/:task/cancel",
    async (c) => {
      requireThat(review, "review_bot_unavailable", 409);
      return c.json(
        await review.cancel(
          c.get("session").admin,
          validId(c.req.param("id")),
          validId(c.req.param("task")),
        ),
      );
    },
  );
  app.get("/api/admin/workspaces/:id/plugins/coding", async (c) => {
    const id = validId(c.req.param("id"));
    const { workspace, refreshError } = await github.repositorySync.refresh(
      c.get("session").admin,
      id,
    );
    const page = codingView(workspace, c.get("session").admin);
    page.repositoryRefreshError = refreshError;
    page.tasks = await taskList(store.pool, id);
    if (deviceAuth)
      try {
        page.deviceAuth = await deviceAuth.deviceStatus(id);
      } catch {
        page.deviceAuth = { state: "unavailable" };
      }
    else page.deviceAuth = { state: "unavailable" };
    return c.json(page);
  });
  app.put("/api/admin/workspaces/:id/plugins/coding", async (c) => {
    const input = await c.req.json();
    const id = validId(c.req.param("id"));
    const page = await store.change(id, async (w) => {
      const page = saveCoding(w, c.get("session").admin, input, encryptionKey);
      if (page.settings.model)
        await setup.models.selected(w, page.settings.model);
      return page;
    });
    page.tasks = await taskList(store.pool, id);
    if (deviceAuth)
      try {
        page.deviceAuth = await deviceAuth.deviceStatus(id);
      } catch {
        page.deviceAuth = { state: "unavailable" };
      }
    else page.deviceAuth = { state: "unavailable" };
    return c.json(page);
  });
  app.post(
    "/api/admin/workspaces/:id/plugins/coding/device/start",
    async (c) => {
      const id = validId(c.req.param("id"));
      const page = codingView(await store.read(id), c.get("session").admin);
      requireThat(
        page.settings.authMode === "device_code",
        "coding_device_mode_required",
        409,
      );
      requireThat(deviceAuth, "coding_runner_not_configured", 409);
      const status = await deviceAuth.deviceStart(id);
      const current = await store.read(id);
      if (
        current.deletion ||
        current.coding?.settings.authMode !== "device_code"
      ) {
        await deviceAuth.deviceLogout(id);
        requireThat(false, "coding_device_mode_required", 409);
      }
      return c.json(status);
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/coding/device/logout",
    async (c) => {
      const id = validId(c.req.param("id"));
      codingView(await store.read(id), c.get("session").admin);
      requireThat(deviceAuth, "coding_runner_not_configured", 409);
      const status = await deviceAuth.deviceLogout(id);
      const page = await store.change(id, (w) => {
        codingView(w, c.get("session").admin);
        requireThat(w.coding, "coding_local_configuration_required", 409);
        w.coding.revision++;
        audit(w, c.get("session").admin.id, "coding.device_logged_out", id);
        return codingView(w, c.get("session").admin);
      });
      page.deviceAuth = status;
      page.tasks = await taskList(store.pool, id);
      return c.json(page);
    },
  );
  app.post("/api/admin/workspaces/:id/plugins/coding/:task/cancel", async (c) =>
    c.json(
      await store.change(validId(c.req.param("id")), async (w, sql) => {
        codingView(w, c.get("session").admin);
        const task = await taskGet(sql, w.id, validId(c.req.param("task")));
        if (
          !task.cancelRequested &&
          !["failed", "cancelled", "unknown"].includes(task.state)
        ) {
          task.cancelRequested = true;
          if (
            ["queued", "waiting", "review"].includes(task.state) ||
            (task.state === "auth_required" && !task.attemptId)
          )
            task.state = "cancelled";
          await taskSave(sql, task);
          audit(
            w,
            c.get("session").admin.id,
            "coding.cancel_requested",
            task.id,
          );
        }
        return { ok: true };
      }),
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
  app.get("/api/admin/workspaces/:id/plugins/cloudflare", async (c) =>
    c.json(
      await plugins.cloudflareView(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/cloudflare/resources",
    async (c) => {
      requireThat(
        plugins.cloudflare,
        "cloudflare_credentials_unavailable",
        503,
      );
      return c.json(
        await plugins.cloudflare.resources(
          c.get("session").admin,
          validId(c.req.param("id")),
          hash(sessionCookieValue(c) ?? ""),
          await c.req.json(),
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/cloudflare/oauth/resources",
    async (c) => {
      requireThat(
        plugins.cloudflare,
        "cloudflare_credentials_unavailable",
        503,
      );
      return c.json(
        await plugins.cloudflare.oauth.resources(
          c.get("session").admin,
          validId(c.req.param("id")),
          await c.req.json(),
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/cloudflare/oauth/connect",
    async (c) => {
      requireThat(
        plugins.cloudflare,
        "cloudflare_credentials_unavailable",
        503,
      );
      const input = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await plugins.cloudflare.oauth.begin(
          c.get("session").admin,
          validId(c.req.param("id")),
          hash(sessionCookieValue(c) ?? ""),
          input.revision,
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/cloudflare/oauth/disconnect",
    async (c) => {
      requireThat(
        plugins.cloudflare,
        "cloudflare_credentials_unavailable",
        503,
      );
      const input = z
        .object({ revision: z.number().int().nonnegative() })
        .strict()
        .parse(await c.req.json());
      const revocationConfirmed = await plugins.cloudflare.oauth.disconnect(
        c.get("session").admin,
        validId(c.req.param("id")),
        input.revision,
      );
      return c.json({
        ...(await plugins.cloudflare.view(
          c.get("session").admin,
          validId(c.req.param("id")),
        )),
        revocationConfirmed,
      });
    },
  );
  app.get("/api/admin/cloudflare/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    let id: string | undefined;
    try {
      requireThat(
        plugins.cloudflare,
        "cloudflare_credentials_unavailable",
        503,
      );
      const input = z
        .object({
          state: z.string().max(200),
          code: z.string().min(1).max(2000).optional(),
        })
        .parse(c.req.query());
      id = cloudflareStateWorkspace(input.state);
      await plugins.cloudflare.oauth.callback(
        c.get("session").admin,
        hash(sessionCookieValue(c) ?? ""),
        input.state,
        input.code,
      );
      return c.redirect(
        `/admin/plugins/cloudflare?workspace=${id}&cloudflare=connected`,
      );
    } catch {
      return c.redirect(
        id
          ? `/admin/plugins/cloudflare?workspace=${id}&cloudflare=failed`
          : "/admin/plugins?cloudflare=failed",
      );
    }
  });
  app.put("/api/admin/workspaces/:id/plugins/cloudflare", async (c) =>
    c.json(
      await plugins.saveCloudflare(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
        hash(sessionCookieValue(c) ?? ""),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/google", async (c) => {
    requireThat(plugins.google, "google_credentials_unavailable", 503);
    return c.json(
      await plugins.google.view(
        c.get("session").admin,
        validId(c.req.param("id")),
        "google",
      ),
    );
  });
  const obsidian = new ObsidianService(store);
  app.get("/api/admin/workspaces/:id/plugins/obsidian", async (c) => {
    const query = c.req.query();
    return c.json(
      await obsidian.view(c.get("session").admin, validId(c.req.param("id")), {
        ...query,
        ...(query.offset !== undefined ? { offset: Number(query.offset) } : {}),
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        ...(query.trash !== undefined ? { trash: query.trash === "true" } : {}),
      }),
    );
  });
  app.put("/api/admin/workspaces/:id/plugins/obsidian", async (c) =>
    c.json(
      await plugins.configureObsidian(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/obsidian/file", async (c) =>
    c.json(
      await obsidian.read(
        c.get("session").admin,
        validId(c.req.param("id")),
        c.req.query("path") ?? "",
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/plugins/obsidian/files", async (c) =>
    c.json(
      await obsidian.mutate(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/obsidian/export", async (c) => {
    const zip = await obsidian.export(
      c.get("session").admin,
      validId(c.req.param("id")),
    );
    return new Response(Buffer.from(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="organization-vault.zip"',
        "cache-control": "no-store",
      },
    });
  });
  app.put("/api/admin/workspaces/:id/plugins/google", async (c) =>
    c.json(
      await plugins.saveGoogle(
        c.get("session").admin,
        validId(c.req.param("id")),
        "google",
        await c.req.json(),
      ),
    ),
  );
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
      w.memberVersion++;
      audit(w, admin.id, "access.recovered", member.id, w.memberVersion);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'workspace.recovered',$2)",
        [admin.id, w.id],
      );
    });
    return c.json({ ok: true });
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
  app.use("/api/admin/workspaces/:id/*", async (c, next) => {
    const w = await store.read(validId(c.req.param("id") ?? ""));
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    if (actor === admin.id) {
      const resource = c.req.path.split("/").slice(5).join("/");
      requireThat(
        /^(overview|settings|members|access-requests|chats|skills|workflows)(\/.*)?$/.test(
          resource,
        ) ||
          (resource === "self-check" && c.req.method === "POST") ||
          (c.req.method === "GET" && resource === "approvals") ||
          (c.req.method === "POST" && /^approvals\/[^/]+$/.test(resource)) ||
          (c.req.method === "GET" &&
            /^(runs|threads)(?:\/[^/]+)?$/.test(resource)),
        "access_denied",
        403,
      );
    }
    await next();
  });
  app.post("/api/admin/workspaces/:id/self-check", async (c) => {
    const admin = c.get("session").admin;
    const id = validId(c.req.param("id"));
    await throttle(store.pool, `self-check:${admin.id}`);
    return c.json(
      await selfCheck.reply(
        admin,
        id,
        await c.req.json(),
        c.req.raw.signal,
        async () => {
          const current = await session(store.pool, sessionCookieValue(c));
          requireThat(
            current?.admin.id === admin.id,
            "authentication_required",
            401,
          );
          workspaceActor(await store.read(id), current.admin);
        },
      ),
    );
  });
  app.get("/api/admin/workspaces/:id/:resource", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const take = <T>(items: T[]) => ({
      items: items.slice(offset, offset + 100),
      total: items.length,
      offset,
    });
    switch (c.req.param("resource")) {
      case "overview": {
        const admin = c.get("session").admin;
        const operatorView = actor === w.operatorId;
        const deployment =
          admin.operator && w.operatorId === admin.id
            ? await store.deployment()
            : undefined;
        return c.json({
          id: w.id,
          settings: w.settings,
          version: w.version,
          counts: {
            members: w.members.filter((m) => m.active).length,
            runs: w.runs.length,
            threads: threadGroups(w).size,
            workflows: w.workflows.filter((f) => f.status !== "deleted").length,
            ...(operatorView
              ? {
                  codingTasks: (await taskList(store.pool, w.id)).length,
                }
              : {}),
          },
          connections: deployment
            ? {
                bot: {
                  configured: !!deployment.credentials.bot && !!deployment.bot,
                  username: deployment.credentials.bot
                    ? deployment.bot?.username
                    : undefined,
                },
                github: {
                  connected: !!w.github?.installationId,
                  account: w.github?.account,
                  repositories: w.github?.repositories.length ?? 0,
                },
              }
            : undefined,
        });
      }
      case "settings": {
        const deployment = await store.deployment();
        return c.json({
          version: w.version,
          settings: w.settings,
          model: deployment.model,
          capabilities: modelCapabilities(deployment.model, deployment) ?? null,
        });
      }
      case "members": {
        const search = (c.req.query("search") ?? "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase();
        const members = membersWithProfiles(w).filter((member) =>
          `${member.id} ${member.username ?? ""} ${member.name ?? ""} ${member.github?.login ?? ""} ${member.githubAccount?.login ?? ""}`
            .toLowerCase()
            .includes(search),
        );
        return c.json({ version: w.memberVersion, ...take(members) });
      }
      case "access-requests": {
        const deployment = await store.deployment();
        return c.json({
          version: w.memberVersion,
          items: (w.accessRequests ?? []).filter((r) => r.status === "pending"),
          ...setup.accessLinks.view(w, deployment.bot),
        });
      }
      case "chats":
        return c.json(take(w.chats));
      case "workflows":
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          repositorySources: workflowRepositories(w, actor),
          ...take(
            w.workflows
              .filter((f) => f.status !== "deleted")
              .map((f) => ({
                ...f,
                next: nextOccurrences(f.spec.recurrence, new Date()),
              })),
          ),
        });
      case "approvals":
        return c.json(
          take(
            w.approvals.filter(
              (a) =>
                (a.kind === "workflow" || a.actor === actor) && !a.decision,
            ),
          ),
        );
      case "skills":
        return c.json(
          take(
            w.skills.map((s) => ({
              ...s,
              preset: isPresetSkill(w, s),
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
      case "threads": {
        const page = historyPage.parse(c.req.query());
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          ...threadSummaries(w, page.offset, page.limit),
        });
      }
      case "runs": {
        const page = z
          .object({
            offset: z.coerce
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .default(0),
            limit: z.coerce.number().int().min(1).max(100).default(25),
          })
          .parse(c.req.query());
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          items: runSummaries(w, page.offset, page.limit),
          total: w.runs.length,
          ...page,
        });
      }
      case "usage": {
        const attempts = [...w.runs, ...(w.adminChecks ?? [])].flatMap((r) =>
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
    fn: (w: Workspace, actor: string, sql: Sql) => T,
  ) =>
    store.change(validId(c.req.param("id")), (w, sql) =>
      fn(w, workspaceActor(w, c.get("session").admin), sql),
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
  app.post(
    "/api/admin/workspaces/:id/access-requests/:request/decision",
    async (c) => {
      const input = z
        .object({ decision: z.enum(["approved", "rejected"]), version })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("request"));
      return c.json(
        await change(c, async (w, actor, sql) => {
          const request = decideAccessRequest(
            w,
            actor,
            id,
            input.decision,
            input.version,
          );
          if (request.status === "approved")
            await sql.query(
              "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO NOTHING",
              [request.actor, w.id],
            );
          return request;
        }),
      );
    },
  );
  app.get("/api/admin/workspaces/:id/members/github", async (c) => {
    const id = validId(c.req.param("id"));
    const w = await store.read(id);
    workspaceActor(w, c.get("session").admin);
    const directory = await github.memberDirectory(w);
    const current = await store.read(id);
    workspaceActor(current, c.get("session").admin);
    requireThat(
      (current.github?.revision ?? 0) === directory.revision &&
        current.github?.installationId === w.github?.installationId,
      "github_connection_changed",
      409,
    );
    return c.json(directory);
  });
  app.post("/api/admin/workspaces/:id/members", async (c) => {
    const input = z
      .object({
        id: userId,
        role: z.enum(["admin", "member"]),
        active: z.boolean(),
        githubId: z.number().int().positive().safe().nullable().optional(),
        githubUsername: githubUsernameSchema.optional(),
        githubRevision: z.number().int().nonnegative().optional(),
        version,
      })
      .strict()
      .refine(
        (input) =>
          input.githubUsername === undefined || input.githubId === undefined,
      )
      .parse(await c.req.json());
    let account: GitHubMember | null = null;
    let githubRevision = input.githubRevision;
    const githubChanged =
      input.githubId !== undefined || input.githubUsername !== undefined;
    if (githubChanged) {
      const w = await store.read(validId(c.req.param("id")));
      workspaceActor(w, c.get("session").admin);
      requireThat(w.memberVersion === input.version, "version_conflict", 409);
      if (input.githubId === null) githubRevision ??= w.github?.revision ?? 0;
      if (input.githubUsername !== undefined) {
        githubRevision ??= w.github?.revision ?? 0;
        requireThat(
          (w.github?.revision ?? 0) === githubRevision,
          "github_connection_changed",
          409,
        );
        account = await github.memberAccount(w, input.githubUsername);
      } else if (input.githubId != null) {
        const directory = await github.memberDirectory(w);
        requireThat(
          directory.revision === githubRevision,
          "github_connection_changed",
          409,
        );
        account =
          directory.members.find((m) => m.id === input.githubId) ?? null;
        requireThat(account, "github_member_not_found", 409);
      }
    }
    return c.json(
      await change(c, (w, actor) => {
        updateMembership(w, actor, input.version, input);
        if (githubChanged) {
          requireThat(
            (w.github?.revision ?? 0) === githubRevision,
            "github_connection_changed",
            409,
          );
          const member = w.members.find((m) => m.id === input.id);
          requireThat(member, "not_found", 404);
          assignGitHubAccount(w, member, account);
          audit(
            w,
            actor,
            "github.account_assigned",
            `${input.id}:${account?.id ?? "none"}`,
          );
        }
        return w.members;
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/chats/link-token", async (c) => {
    const deployment = await store.deployment();
    requireThat(deployment.bot, "bot_not_configured", 409);
    const bot = deployment.bot;
    return c.json(
      await change(c, (w) => issueGroupLink(w, c.get("session").admin, bot)),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/chats/:chat/action", async (c) => {
    const input = z
      .object({ action: z.enum(["collect", "directed", "unlink"]) })
      .strict()
      .parse(await c.req.json());
    const id = c.req.param("chat");
    await store.change(validId(c.req.param("id")), async (w, sql) => {
      const actor = workspaceActor(w, c.get("session").admin);
      const chat = w.chats.find((c) => c.id === id);
      requireThat(chat, "not_found", 404);
      if (input.action === "collect") {
        requireThat(chat.active, "bot_visibility_required");
        chat.collection = true;
        chat.consentAt = new Date().toISOString();
        chat.consentBy = actor;
      } else chat.collection = false;
      if (input.action === "unlink") {
        chat.active = false;
        w.tokens = w.tokens.filter((entry) => entry.kind !== "group");
        await sql.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
          w.id,
        ]);
      }
      revokeWork(w);
      audit(w, actor, `chat.${input.action}`, id);
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/workspaces/:id/workflows/:workflow", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const id = validId(c.req.param("workflow"));
    const operatorView = actor === w.operatorId;
    const workflow = w.workflows.find(
      (f) => f.id === id && f.status !== "deleted",
    );
    requireThat(workflow, "not_found", 404);
    return c.json({
      mode: operatorView ? "operator" : "member",
      workflow: {
        ...workflow,
        next: nextOccurrences(workflow.spec.recurrence, new Date()),
      },
      repositorySources: workflowRepositories(w, actor),
    });
  });
  app.post("/api/admin/workspaces/:id/workflows", async (c) => {
    const input = workflowSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        proposeWorkflow(
          w,
          workflowOwner(w, actor, input),
          input,
          new Date(),
          undefined,
          undefined,
          actor,
        ),
      ),
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
          workflowOwner(w, actor, input.spec, c.req.param("workflow")),
          input.spec,
          new Date(),
          c.req.param("workflow"),
          input.version,
          actor,
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
            workflowOwner(w, actor, undefined, c.req.param("workflow")),
            c.req.param("workflow"),
            input.action,
            input.version,
            d.model,
            actor,
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
        decide(
          w,
          actor,
          c.req.param("approval"),
          input.approve,
          new Date(),
          w.approvals.find((a) => a.id === c.req.param("approval"))?.kind ===
            "workflow"
            ? actor
            : undefined,
        ),
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
  app.post("/api/admin/workspaces/:id/skills/github/discover", async (c) => {
    const input = z
      .object({ url: githubSkillUrl })
      .strict()
      .parse(await c.req.json());
    const id = validId(c.req.param("id"));
    const actor = workspaceActor(await store.read(id), c.get("session").admin);
    return c.json(await github.skills.discover(id, actor, input.url));
  });
  app.post("/api/admin/workspaces/:id/skills/github/import", async (c) => {
    const id = validId(c.req.param("id"));
    const actor = workspaceActor(await store.read(id), c.get("session").admin);
    return c.json(
      await github.skills.import(id, actor, await c.req.json()),
      201,
    );
  });
  app.post(
    "/api/admin/workspaces/:id/skills/:skill/github/check",
    async (c) => {
      const input = z
        .object({ version })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("id"));
      const actor = workspaceActor(
        await store.read(id),
        c.get("session").admin,
      );
      return c.json(
        await github.skills.check(
          id,
          actor,
          validId(c.req.param("skill")),
          input.version,
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/skills/:skill/github/update",
    async (c) => {
      const input = z
        .object({
          version,
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          replaceLocal: z.boolean().default(false),
        })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("id"));
      const actor = workspaceActor(
        await store.read(id),
        c.get("session").admin,
      );
      return c.json(
        await github.skills.update(
          id,
          actor,
          validId(c.req.param("skill")),
          input.version,
          input.commit,
          input.replaceLocal,
        ),
      );
    },
  );
  app.post("/api/admin/workspaces/:id/skills/import", async (c) => {
    const input = z
      .object({ markdown: z.string().max(16384) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveManagedSkill(w, actor, importMarkdown(input.markdown)),
      ),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/skills", async (c) => {
    const spec = skillSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => saveManagedSkill(w, actor, spec)),
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
        saveManagedSkill(
          w,
          actor,
          input.spec,
          c.req.param("skill"),
          input.version,
        ),
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
      await change(c, (w, actor) => {
        const id = c.req.param("skill");
        const skill = w.skills.find((s) => s.id === id);
        let expected = input.version;
        // Approve the displayed instructions when enabling legacy catalog entries.
        if (
          input.action === "enable" &&
          skill &&
          !isPresetSkill(w, skill) &&
          (!skill.published.length ||
            fingerprint(skill.draft) !== fingerprint(skill.published.at(-1)))
        ) {
          expected = changeSkill(w, actor, id, expected, "publish").version;
        }
        return changeSkill(w, actor, id, expected, input.action, input.pin);
      }),
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
  app.get("/api/admin/workspaces/:id/threads/:thread", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const id = threadKey.parse(c.req.param("thread"));
    const page = historyPage.parse(c.req.query());
    return c.json({
      mode: actor === w.operatorId ? "operator" : "member",
      ...threadDetail(w, id, page.offset, page.limit),
    });
  });
  app.get("/api/admin/workspaces/:id/runs/:run", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const runId = validId(c.req.param("run"));
    const run = w.runs.find((r) => r.id === runId);
    requireThat(run, "not_found", 404);
    return c.json({
      mode: actor === w.operatorId ? "operator" : "member",
      threadId: runThreadKey(w, run),
      run: {
        ...run,
        deliveries: w.deliveries.filter(
          (d) => d.runId === run.id || d.cancellationRunId === run.id,
        ),
      },
    });
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
      await change(c, (w, actor, sql) =>
        cancelRequest(sql, w, actor, c.req.param("run")),
      ),
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
    workspaceActor(w, c.get("session").admin);
    const linkedChat = w.chats.find((chat) => chat.id === c.req.param("chat"));
    requireThat(linkedChat, "not_found", 404);
    const deployment = await store.deployment();
    requireThat(deployment.bot, "bot_not_configured", 409);
    const client = await setup.client(deployment);
    const visibleAll = await groupVisibility(
      client,
      linkedChat.id,
      deployment.bot.id,
    );
    const details = await client
      .call<{ title?: string }>("getChat", { chat_id: linkedChat.id })
      .catch((error: unknown) => {
        // Inactive groups may be inaccessible; keep their last known name.
        if (!(error instanceof TelegramError)) throw error;
        return undefined;
      });
    return c.json(
      await change(c, (w, actor) => {
        const chat = w.chats.find((chat) => chat.id === c.req.param("chat"));
        requireThat(chat, "not_found", 404);
        if (details?.title?.trim()) chat.title = details.title.trim();
        chat.visibleAll = visibleAll;
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
            .filter((d) => d.runId === id || d.cancellationRunId === id)
            .map((d) => ({ id: d.id, state: d.state, remoteId: d.remoteId })),
        });
    }
    return c.json({ error: "not_found" }, 404);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
