import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { Fault, requireThat } from "../../domain.ts";
import { equal } from "../../setup/credentials.ts";
import { Docker } from "./docker.ts";
import { Podman } from "./podman.ts";
import { localStart } from "./protocol.ts";
import { runnerSettings } from "./settings.ts";
import { RunnerSupervisor } from "./supervisor.ts";

export function runnerApp(
  supervisor: RunnerSupervisor,
  transport: typeof fetch = fetch,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 8 * 1024 * 1024 }));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    try {
      await supervisor.ready();
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "coding_runner_unavailable" }, 503);
    }
  });
  app.on("POST", ["/v1/responses", "/v1/responses/compact"], async (c) => {
    const providerApiKey = supervisor.providerKey(
      (c.req.header("authorization") ?? "").replace(/^Bearer /, ""),
    );
    const settings = supervisor.settings;
    const body = await c.req.json();
    requireThat(
      body.model === settings.CODEX_MODEL,
      "coding_model_denied",
      403,
    );
    const response = await transport(
      `${settings.CODEX_PROVIDER_BASE_URL.replace(/\/$/, "")}${c.req.path.slice(3)}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(
          settings.CODEX_RUNNER_TIMEOUT_SECONDS * 1000,
        ),
        headers: {
          authorization: `Bearer ${providerApiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) return c.json({ error: "coding_provider_failed" }, 502);
    return new Response(response.body, {
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  });
  app.use("/tasks*", async (c, next) => {
    requireThat(
      equal(
        c.req.header("authorization") ?? "",
        `Bearer ${supervisor.settings.CODEX_RUNNER_TOKEN}`,
      ),
      "coding_runner_denied",
      401,
    );
    await next();
  });
  app.use("/device-auth/*", async (c, next) => {
    requireThat(
      equal(
        c.req.header("authorization") ?? "",
        `Bearer ${supervisor.settings.CODEX_RUNNER_TOKEN}`,
      ),
      "coding_runner_denied",
      401,
    );
    await next();
  });
  app.get("/device-auth/:workspace", async (c) =>
    c.json(
      await supervisor.device.status(z.uuid().parse(c.req.param("workspace"))),
    ),
  );
  app.post("/device-auth/:workspace/start", async (c) =>
    c.json(
      await supervisor.device.start(z.uuid().parse(c.req.param("workspace"))),
    ),
  );
  app.post("/device-auth/:workspace/logout", async (c) =>
    c.json(
      await supervisor.logoutDevice(z.uuid().parse(c.req.param("workspace"))),
    ),
  );
  app.post("/tasks", async (c) => {
    await supervisor.start(localStart.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.get("/tasks/:workspace/:task", async (c) =>
    c.json(
      await supervisor.status(
        z.uuid().parse(c.req.param("workspace")),
        z.uuid().parse(c.req.param("task")),
      ),
    ),
  );
  app.post("/tasks/:workspace/:task/publish", async (c) => {
    const { token } = z
      .object({ token: z.string().min(1).max(8192) })
      .strict()
      .parse(await c.req.json());
    await supervisor.publish(
      z.uuid().parse(c.req.param("workspace")),
      z.uuid().parse(c.req.param("task")),
      token,
    );
    return c.json({ ok: true });
  });
  app.post("/tasks/:workspace/:task/resume-auth", async (c) => {
    await supervisor.resumeAuth(
      z.uuid().parse(c.req.param("workspace")),
      z.uuid().parse(c.req.param("task")),
    );
    return c.json({ ok: true });
  });
  app.post("/tasks/:workspace/:task/erase", async (c) => {
    await supervisor.erase(
      z.uuid().parse(c.req.param("workspace")),
      z.uuid().parse(c.req.param("task")),
    );
    return c.json({ ok: true });
  });
  app.post("/tasks/:workspace/:task/cancel", async (c) => {
    await supervisor.cancel(
      z.uuid().parse(c.req.param("workspace")),
      z.uuid().parse(c.req.param("task")),
    );
    return c.json({ ok: true });
  });
  app.onError((error, c) =>
    c.json(
      { error: error instanceof Fault ? error.code : "coding_runner_failed" },
      error instanceof Fault ? (error.status as 400) : 503,
    ),
  );
  return app;
}

if (import.meta.main) {
  const settings = runnerSettings.parse(process.env);
  const supervisor = new RunnerSupervisor(
    settings,
    settings.CODEX_CONTAINER_ENGINE === "docker"
      ? new Docker(settings)
      : new Podman(settings),
  );
  await supervisor.initialize();
  const app = runnerApp(supervisor);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3020 });
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void supervisor
      .sweep()
      .catch(() => console.error("Codex runner reconciliation failed."))
      .finally(() => {
        sweeping = false;
      });
  }, 5000);
  const shutdown = () => {
    clearInterval(timer);
    server.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
