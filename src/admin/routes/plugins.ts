import { Hono } from "hono";
import { z } from "zod";
import { browserPanelTask } from "../../browser/privacy.ts";
import { cloudflareStateWorkspace } from "../../cloudflare/oauth.ts";
import {
  antigravityView,
  codingView,
  saveAntigravity,
  saveCoding,
} from "../../coding/service.ts";
import { taskGet, taskList, taskSave } from "../../coding/task-store.ts";
import { requireThat } from "../../domain.ts";
import { ObsidianService } from "../../obsidian/service.ts";
import { packageFault } from "../../plugins/package-service.ts";
import { hash } from "../../setup/credentials.ts";
import { audit } from "../../workspaces/policy.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  sessionCookieValue,
  validId,
} from "./shared.ts";

export function pluginRoutes(deps: AdminRouteDeps) {
  const { store, setup, plugins, github, encryptionKey, deviceAuth, review } =
    deps;
  const app = new Hono<AdminEnv>();
  const obsidian = new ObsidianService(store);

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
    page.tasks = (await taskList(store.pool, id))
      .filter((t) => !t.payload.engine || t.payload.engine === "codex")
      .map(browserPanelTask);
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
    page.tasks = (await taskList(store.pool, id))
      .filter((t) => !t.payload.engine || t.payload.engine === "codex")
      .map(browserPanelTask);
    if (deviceAuth)
      try {
        page.deviceAuth = await deviceAuth.deviceStatus(id);
      } catch {
        page.deviceAuth = { state: "unavailable" };
      }
    else page.deviceAuth = { state: "unavailable" };
    return c.json(page);
  });
  app.get("/api/admin/workspaces/:id/plugins/antigravity", async (c) => {
    const id = validId(c.req.param("id"));
    const { workspace, refreshError } = await github.repositorySync.refresh(
      c.get("session").admin,
      id,
    );
    const page = antigravityView(workspace, c.get("session").admin);
    page.repositoryRefreshError = refreshError;
    page.tasks = (await taskList(store.pool, id))
      .filter((t) => t.payload.engine === "antigravity")
      .map(browserPanelTask);
    if (deviceAuth?.antigravityStatus)
      try {
        page.oauthAuth = await deviceAuth.antigravityStatus(id);
      } catch {
        page.oauthAuth = { state: "unavailable" };
      }
    else page.oauthAuth = { state: "unavailable" };
    return c.json(page);
  });
  app.put("/api/admin/workspaces/:id/plugins/antigravity", async (c) => {
    const input = await c.req.json();
    const id = validId(c.req.param("id"));
    const page = await store.change(id, async (w) =>
      saveAntigravity(w, c.get("session").admin, input, encryptionKey),
    );
    page.tasks = (await taskList(store.pool, id))
      .filter((t) => t.payload.engine === "antigravity")
      .map(browserPanelTask);
    if (deviceAuth?.antigravityStatus)
      try {
        page.oauthAuth = await deviceAuth.antigravityStatus(id);
      } catch {
        page.oauthAuth = { state: "unavailable" };
      }
    else page.oauthAuth = { state: "unavailable" };
    return c.json(page);
  });
  app.post(
    "/api/admin/workspaces/:id/plugins/antigravity/auth/start",
    async (c) => {
      const id = validId(c.req.param("id"));
      const page = antigravityView(
        await store.read(id),
        c.get("session").admin,
      );
      requireThat(
        page.settings.authMode === "google_oauth",
        "coding_device_mode_required",
        409,
      );
      requireThat(
        deviceAuth?.antigravityStart && deviceAuth.antigravityLogout,
        "coding_runner_not_configured",
        409,
      );
      const status = await deviceAuth.antigravityStart(id);
      const current = await store.read(id);
      if (
        current.deletion ||
        current.antigravity?.settings.authMode !== "google_oauth"
      ) {
        await deviceAuth.antigravityLogout(id);
        requireThat(false, "coding_device_mode_required", 409);
      }
      return c.json(status);
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/antigravity/auth/complete",
    async (c) => {
      const id = validId(c.req.param("id"));
      const page = antigravityView(
        await store.read(id),
        c.get("session").admin,
      );
      requireThat(
        page.settings.authMode === "google_oauth",
        "coding_device_mode_required",
        409,
      );
      requireThat(
        deviceAuth?.antigravityComplete,
        "coding_runner_not_configured",
        409,
      );
      const { code } = z
        .object({ code: z.string().trim().min(1).max(4096) })
        .strict()
        .parse(await c.req.json());
      const status = await deviceAuth.antigravityComplete(id, code);
      const updated = await store.change(id, (w) => {
        antigravityView(w, c.get("session").admin);
        audit(w, c.get("session").admin.id, "antigravity.oauth_connected", id);
        return antigravityView(w, c.get("session").admin);
      });
      updated.oauthAuth = status;
      updated.tasks = (await taskList(store.pool, id))
        .filter((t) => t.payload.engine === "antigravity")
        .map(browserPanelTask);
      return c.json(updated);
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/antigravity/auth/logout",
    async (c) => {
      const id = validId(c.req.param("id"));
      antigravityView(await store.read(id), c.get("session").admin);
      requireThat(
        deviceAuth?.antigravityLogout,
        "coding_runner_not_configured",
        409,
      );
      const status = await deviceAuth.antigravityLogout(id);
      const page = await store.change(id, (w) => {
        antigravityView(w, c.get("session").admin);
        if (w.antigravity) w.antigravity.revision++;
        audit(w, c.get("session").admin.id, "antigravity.oauth_logged_out", id);
        return antigravityView(w, c.get("session").admin);
      });
      page.oauthAuth = status;
      page.tasks = (await taskList(store.pool, id))
        .filter((t) => t.payload.engine === "antigravity")
        .map(browserPanelTask);
      return c.json(page);
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/antigravity/:task/cancel",
    async (c) =>
      c.json(
        await store.change(validId(c.req.param("id")), async (w, sql) => {
          antigravityView(w, c.get("session").admin);
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
              "antigravity.cancel_requested",
              task.id,
            );
          }
          return { ok: true };
        }),
      ),
  );
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
      page.tasks = (await taskList(store.pool, id)).map(browserPanelTask);
      return c.json(page);
    },
  );
  app.get(
    "/api/admin/workspaces/:id/plugins/coding/environments",
    async (c) => {
      const id = validId(c.req.param("id"));
      codingView(await store.read(id), c.get("session").admin);
      requireThat(
        deviceAuth?.listEnvironments,
        "coding_runner_not_configured",
        409,
      );
      return c.json({ environments: await deviceAuth.listEnvironments(id) });
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugins/coding/environments/:repositoryId/reset",
    async (c) => {
      const id = validId(c.req.param("id"));
      const admin = c.get("session").admin;
      codingView(await store.read(id), admin);
      requireThat(
        deviceAuth?.resetEnvironment,
        "coding_runner_not_configured",
        409,
      );
      const repositoryId = z.coerce
        .number()
        .int()
        .positive()
        .safe()
        .parse(c.req.param("repositoryId"));
      const result = await deviceAuth.resetEnvironment(id, repositoryId);
      await store.change(id, (w) => {
        codingView(w, admin);
        audit(w, admin.id, "coding.environment_reset", String(repositoryId));
      });
      return c.json(result);
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
  app.get("/api/admin/workspaces/:id/plugins/nowledge-mem", async (c) =>
    c.json(
      await plugins.nowledgeMem.view(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.put("/api/admin/workspaces/:id/plugins/nowledge-mem", async (c) =>
    c.json(
      await plugins.configureNowledge(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/plugins/nowledge-mem/spaces", async (c) =>
    c.json(
      await plugins.nowledgeMem.spaces(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/browser", async (c) =>
    c.json(
      await plugins.browser.view(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.put("/api/admin/workspaces/:id/plugins/browser", async (c) =>
    c.json(
      await plugins.configureBrowser(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/admin/workspaces/:id/plugins/transcription", async (c) =>
    c.json(
      await plugins.transcription.view(
        c.get("session").admin,
        validId(c.req.param("id")),
      ),
    ),
  );
  app.put("/api/admin/workspaces/:id/plugins/transcription", async (c) =>
    c.json(
      await plugins.configureTranscription(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/plugins/transcription/retry", async (c) =>
    c.json(
      await plugins.transcription.retry(
        c.get("session").admin,
        validId(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
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
  const packageCall = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      return packageFault(error);
    }
  };
  const packageRepositoryId = (id: string) =>
    z.coerce.number().int().positive().safe().parse(id);
  app.get("/api/admin/workspaces/:id/plugin-packages", async (c) =>
    c.json(
      await packageCall(() =>
        plugins.packages.view(
          c.get("session").admin,
          validId(c.req.param("id")),
        ),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/plugin-packages/cleanup", async (c) => {
    const value = await c.req.json();
    return c.json(
      await packageCall(() =>
        plugins.packages.collect(
          c.get("session").admin,
          validId(c.req.param("id")),
          value,
        ),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/plugin-packages/previews", async (c) => {
    const value = await c.req.json();
    return c.json(
      await packageCall(() =>
        plugins.packages.preview(
          c.get("session").admin,
          validId(c.req.param("id")),
          value,
          c.req.raw.signal,
        ),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/plugin-packages", async (c) => {
    const value = await c.req.json();
    return c.json(
      await packageCall(() =>
        plugins.packages.apply(
          c.get("session").admin,
          validId(c.req.param("id")),
          value,
        ),
      ),
    );
  });
  app.get(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId",
    async (c) => {
      const view = await packageCall(() =>
        plugins.packages.view(
          c.get("session").admin,
          validId(c.req.param("id")),
        ),
      );
      const entry = view.entries.find(
        (p) =>
          p.source.repositoryId ===
          packageRepositoryId(c.req.param("repositoryId")),
      );
      requireThat(entry, "plugin_not_found", 404);
      return c.json({
        revision: view.revision,
        runnerConfigured: view.runnerConfigured,
        entry,
      });
    },
  );
  app.patch(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId",
    async (c) => {
      const value = await c.req.json();
      return c.json(
        await packageCall(() =>
          plugins.packages.update(
            c.get("session").admin,
            validId(c.req.param("id")),
            packageRepositoryId(c.req.param("repositoryId")),
            value,
          ),
        ),
      );
    },
  );
  app.delete(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId",
    async (c) => {
      const value = await c.req.json();
      return c.json(
        await packageCall(() =>
          plugins.packages.remove(
            c.get("session").admin,
            validId(c.req.param("id")),
            packageRepositoryId(c.req.param("repositoryId")),
            value,
          ),
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/plugin-packages/:repositoryId/connections",
    async (c) => {
      const value = await c.req.json();
      return c.json(
        await packageCall(() =>
          plugins.packages.connect(
            c.get("session").admin,
            validId(c.req.param("id")),
            packageRepositoryId(c.req.param("repositoryId")),
            value,
          ),
        ),
      );
    },
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
  return app;
}
