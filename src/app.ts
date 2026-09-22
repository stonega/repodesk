import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { adminRoutes } from "./admin/routes.ts";
import { PluginService } from "./agent/plugin-service.ts";
import type { Store } from "./db/repositories.ts";
import { Fault, requireThat } from "./domain.ts";
import { GitHubService } from "./github/service.ts";
import { equal } from "./setup/credentials.ts";
import type { SetupService } from "./setup/service.ts";
import { updateSchema } from "./telegram/router.ts";
import { Ingress } from "./telegram/webhook.ts";
export function createApp(
  store: Store,
  setup: SetupService,
  origin: string,
  plugins = new PluginService(store),
  github = new GitHubService(store, "", origin),
) {
  const app = new Hono();
  const ingress = new Ingress(store, setup);
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", "https://github.com"],
      },
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const deployment = await store.deployment();
    const heartbeat = await store.pool.query(
      "SELECT 1 FROM worker_heartbeats WHERE at>now()-interval '30 seconds' LIMIT 1",
    );
    const receiverReady =
      setup.telegramTransport !== "polling" ||
      !deployment.credentials.bot ||
      (await setup.receiverStatus(deployment)).ready;
    const status = !heartbeat.rowCount
      ? "worker_unavailable"
      : !receiverReady
        ? "telegram_polling_unavailable"
        : "ready";
    return c.json({ status }, status === "ready" ? 200 : 503);
  });
  app.post("/telegram/webhook", async (c) => {
    requireThat(
      setup.telegramTransport === "webhook",
      "webhook_disabled_in_polling_mode",
      409,
    );
    const secret = await setup.webhookSecret();
    requireThat(
      secret &&
        equal(c.req.header("x-telegram-bot-api-secret-token") ?? "", secret),
      "unauthorized_webhook",
      401,
    );
    const update = updateSchema.parse(await c.req.json());
    return c.json(await ingress.accept(update));
  });
  app.route("/", adminRoutes(store, setup, origin, plugins, github));
  app.get("/", async (c) => {
    const row = (
      await store.pool.query("SELECT claimed FROM deployment WHERE id=true")
    ).rows[0];
    return c.redirect(row?.claimed ? "/admin" : "/setup");
  });
  app.get("/assets/*", serveStatic({ root: "./dist/web" }));
  app.get("/setup", serveStatic({ path: "./dist/web/index.html" }));
  app.get("/admin", serveStatic({ path: "./dist/web/index.html" }));
  app.get("/admin/*", serveStatic({ path: "./dist/web/index.html" }));
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    if (error instanceof Fault) {
      if (error.status >= 500) store.log.write("request_failed", { error });
      return c.json({ error: error.code }, error.status as 400);
    }
    if (error instanceof ZodError) {
      // Expose only known form paths and schema messages, never submitted values/unknown keys.
      const fields = new Set([
        "settings",
        "name",
        "timezone",
        "language",
        "retentionDays",
        "monthlyBudgetUsd",
        "runBudgetUsd",
        "maxInputChars",
        "maxOutputTokens",
        "maxTurns",
        "missedRunMinutes",
        "paused",
        "version",
        "model",
        "modelLimits",
        "contextWindow",
        "modelBaseUrl",
        "modelPricing",
        "input",
        "output",
        "thinkingLevel",
      ]);
      const issues = error.issues
        .filter(
          (issue) =>
            issue.path.length &&
            issue.path.every(
              (part) => typeof part === "string" && fields.has(part),
            ) &&
            issue.code !== "unrecognized_keys",
        )
        .map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
      return c.json({ error: "invalid_request", issues }, 400);
    }
    if (error instanceof SyntaxError)
      return c.json({ error: "invalid_request" }, 400);
    store.log.write("request_failed", { error });
    return c.json({ error: "service_unavailable" }, 503);
  });
  return app;
}
