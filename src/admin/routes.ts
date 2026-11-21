import { Hono } from "hono";
import type { PluginService } from "../agent/plugin-service.ts";
import type { LocalDeviceAuth } from "../coding/local/protocol.ts";
import type { LocalRuntimeControl } from "../coding/runtime-config.ts";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import type { GitHubService } from "../github/service.ts";
import type { ReviewService } from "../review-bot/service.ts";
import { equal } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import type { ReleaseUpdates } from "../updates/releases.ts";
import { session } from "./auth.ts";
import { authSetupRoutes } from "./routes/auth-setup.ts";
import { githubRoutes } from "./routes/github.ts";
import { modelUsageRoutes } from "./routes/model-usage.ts";
import { operatorRoutes } from "./routes/operator.ts";
import { orchestrationRoutes } from "./routes/orchestration.ts";
import { pluginRoutes } from "./routes/plugins.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  sessionCookieValue,
} from "./routes/shared.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { SelfCheckService } from "./self-check.ts";
import { deploymentOrigin, SiteService } from "./site.ts";

export interface AdminRoutesOptions {
  store: Store;
  setup: SetupService;
  origin: string;
  plugins: PluginService;
  github: GitHubService;
  encryptionKey?: string;
  deviceAuth?: LocalDeviceAuth & Partial<LocalRuntimeControl>;
  review?: ReviewService;
  updates?: ReleaseUpdates;
  selfCheck?: SelfCheckService;
}

export function adminRoutes(options: AdminRoutesOptions): Hono<AdminEnv>;
/** @deprecated Pass a named {@link AdminRoutesOptions} object. */
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
  selfCheck?: SelfCheckService,
): Hono<AdminEnv>;
export function adminRoutes(
  storeOrOptions: Store | AdminRoutesOptions,
  setupArg?: SetupService,
  originArg?: string,
  pluginsArg?: PluginService,
  githubArg?: GitHubService,
  encryptionKeyArg?: string,
  deviceAuthArg?: LocalDeviceAuth & Partial<LocalRuntimeControl>,
  reviewArg?: ReviewService,
  updatesArg?: ReleaseUpdates,
  selfCheckArg?: SelfCheckService,
) {
  const options: AdminRoutesOptions =
    "store" in storeOrOptions
      ? storeOrOptions
      : {
          store: storeOrOptions,
          setup: setupArg as SetupService,
          origin: originArg as string,
          plugins: pluginsArg as PluginService,
          github: githubArg as GitHubService,
          encryptionKey: encryptionKeyArg,
          deviceAuth: deviceAuthArg,
          review: reviewArg,
          updates: updatesArg,
          selfCheck: selfCheckArg,
        };
  const { store, setup, origin } = options;
  const deps: AdminRouteDeps = {
    ...options,
    selfCheck: options.selfCheck ?? new SelfCheckService(store, setup),
    site: new SiteService(store, origin),
  };

  const app = new Hono<AdminEnv>();
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

  app.route("/", authSetupRoutes(deps));
  app.route("/", githubRoutes(deps));
  app.route("/", pluginRoutes(deps));
  app.route("/", operatorRoutes(deps));
  app.route("/", orchestrationRoutes(deps));
  app.route("/", modelUsageRoutes(deps));
  app.route("/", workspaceRoutes(deps));
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
