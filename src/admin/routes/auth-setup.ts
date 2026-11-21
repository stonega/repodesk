import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { credentialsSchema } from "../../agent/model-settings.ts";
import { runtimeSave } from "../../coding/runtime-config.ts";
import { Fault, requireThat, settingsSchema, userId } from "../../domain.ts";
import { searchProviderIdSchema } from "../../search/config.ts";
import { hash } from "../../setup/credentials.ts";
import { audit } from "../../workspaces/policy.ts";
import { claim, login, operator, throttle } from "../auth.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  authInput,
  cookieOptions,
  sessionCookie,
  sessionCookieValue,
  validId,
  version,
} from "./shared.ts";

export function authSetupRoutes(deps: AdminRouteDeps) {
  const { store, setup, origin, deviceAuth, updates, site } = deps;
  const app = new Hono<AdminEnv>();

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
    setCookie(c, sessionCookie, result.raw, cookieOptions(c, origin));
    return c.json({ csrf: result.csrf });
  });
  app.post("/api/admin/auth/login", async (c) => {
    const input = authInput.strict().parse(await c.req.json());
    await throttle(store.pool, `login:${input.username}`);
    const result = await login(store.pool, input.username, input.password);
    setCookie(c, sessionCookie, result.raw, cookieOptions(c, origin));
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
  return app;
}
