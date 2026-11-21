import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { requireThat } from "../../domain.ts";
import {
  manageNotifications,
  notificationPage,
  updateNotificationSettings,
} from "../../github/notifications.ts";
import {
  managePluginNotifications,
  pluginNotificationInput,
  pluginNotificationPage,
} from "../../plugins/notifications.ts";
import { hash } from "../../setup/credentials.ts";
import { deploymentOrigin } from "../site.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  cookieOptions,
  sessionCookie,
  sessionCookieValue,
  validId,
  workspaceActor,
} from "./shared.ts";

export function githubRoutes(deps: AdminRouteDeps) {
  const { store, origin, github } = deps;
  const app = new Hono<AdminEnv>();

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
      ...cookieOptions(c, origin),
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
      ...cookieOptions(c, origin),
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
  app.get("/api/admin/workspaces/:id/github/notifications", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const admin = c.get("session").admin;
    workspaceActor(w, admin);
    const d = await store.deployment();
    return c.json({
      ...notificationPage(
        w,
        admin.telegramId,
        d.bot?.id,
        !!(await github.webhooks.configured(w.operatorId)),
      ),
      webhookUrl: `${deploymentOrigin(d, origin)}/github/webhook/${w.operatorId}`,
      canConfigureWebhook: admin.operator && admin.id === w.operatorId,
    });
  });
  app.post("/api/admin/workspaces/:id/github/notifications", async (c) => {
    const admin = c.get("session").admin;
    const input = await c.req.json();
    const id = validId(c.req.param("id"));
    await store.change(id, async (w, sql) => {
      workspaceActor(w, admin);
      requireThat(admin.telegramId, "telegram_identity_required", 403);
      const d = await store.deployment(sql);
      requireThat(d.bot, "bot_not_configured", 409);
      manageNotifications(w, admin.telegramId, d.bot.id, input);
    });
    const w = await store.read(id);
    const d = await store.deployment();
    return c.json({
      ...notificationPage(
        w,
        admin.telegramId,
        d.bot?.id,
        !!(await github.webhooks.configured(w.operatorId)),
      ),
      webhookUrl: `${deploymentOrigin(d, origin)}/github/webhook/${w.operatorId}`,
      canConfigureWebhook: admin.operator && admin.id === w.operatorId,
    });
  });
  app.put(
    "/api/admin/workspaces/:id/github/notifications/settings",
    async (c) => {
      const admin = c.get("session").admin;
      const input = await c.req.json();
      const id = validId(c.req.param("id"));
      await store.change(id, (w) => {
        const actor = workspaceActor(w, admin);
        updateNotificationSettings(w, actor, input);
      });
      const w = await store.read(id);
      const d = await store.deployment();
      return c.json({
        ...notificationPage(
          w,
          admin.telegramId,
          d.bot?.id,
          !!(await github.webhooks.configured(w.operatorId)),
        ),
        webhookUrl: `${deploymentOrigin(d, origin)}/github/webhook/${w.operatorId}`,
        canConfigureWebhook: admin.operator && admin.id === w.operatorId,
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:id/github/notifications/webhook",
    async (c) => {
      return c.json(
        await github.webhooks.configure(
          c.get("session").admin,
          validId(c.req.param("id")),
          await c.req.json(),
        ),
      );
    },
  );
  app.get(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId/notifications",
    async (c) => {
      const w = await store.read(validId(c.req.param("id")));
      const admin = c.get("session").admin;
      workspaceActor(w, admin);
      const repositoryId = z.coerce
        .number()
        .int()
        .positive()
        .safe()
        .parse(c.req.param("repositoryId"));
      return c.json(
        pluginNotificationPage(
          w,
          admin.telegramId,
          repositoryId,
          (await store.deployment()).bot?.id,
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId/notifications",
    async (c) => {
      const admin = c.get("session").admin;
      const id = validId(c.req.param("id"));
      const repositoryId = z.coerce
        .number()
        .int()
        .positive()
        .safe()
        .parse(c.req.param("repositoryId"));
      const input = pluginNotificationInput
        .omit({ plugin: true })
        .parse(await c.req.json());
      await store.change(id, async (w, sql) => {
        workspaceActor(w, admin);
        requireThat(admin.telegramId, "telegram_identity_required", 403);
        const d = await store.deployment(sql);
        requireThat(d.bot, "bot_not_configured", 409);
        managePluginNotifications(w, admin.telegramId, d.bot.id, {
          ...input,
          plugin: String(repositoryId),
        });
      });
      return c.json(
        pluginNotificationPage(
          await store.read(id),
          admin.telegramId,
          repositoryId,
          (await store.deployment()).bot?.id,
        ),
      );
    },
  );
  return app;
}
