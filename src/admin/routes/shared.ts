import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { PluginService } from "../../agent/plugin-service.ts";
import type {
  LocalAntigravityAuth,
  LocalDeviceAuth,
  LocalEnvironmentControl,
} from "../../coding/local/protocol.ts";
import type { LocalRuntimeControl } from "../../coding/runtime-config.ts";
import type { Sql } from "../../db/pool.ts";
import type { Store } from "../../db/repositories.ts";
import type { Admin, Session, Workspace } from "../../domain.ts";
import type { GitHubService } from "../../github/service.ts";
import type { ReviewService } from "../../review-bot/service.ts";
import type { SetupService } from "../../setup/service.ts";
import type { ReleaseUpdates } from "../../updates/releases.ts";
import { authorize, eligible } from "../../workspaces/policy.ts";
import type { SelfCheckService } from "../self-check.ts";
import type { SiteService } from "../site.ts";

export type AdminEnv = { Variables: { session: Session } };

export interface AdminRouteDeps {
  store: Store;
  setup: SetupService;
  origin: string;
  plugins: PluginService;
  github: GitHubService;
  encryptionKey?: string;
  deviceAuth?: LocalDeviceAuth &
    Partial<LocalAntigravityAuth> &
    Partial<LocalRuntimeControl> &
    Partial<LocalEnvironmentControl>;
  review?: ReviewService;
  updates?: ReleaseUpdates;
  selfCheck: SelfCheckService;
  site: SiteService;
}

export const sessionCookie = "repodesk_session";
export const sessionCookieValue = (c: Context<AdminEnv>) =>
  getCookie(c, sessionCookie) ?? getCookie(c, "deepx_session");
export const version = z.number().int().positive();
export const authInput = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
  password: z.string().min(12).max(256),
});
export const validId = (id: string) => z.uuid().parse(id);

export const workspaceActor = (w: Workspace, admin: Admin) => {
  if (admin.telegramId && eligible(w, admin.telegramId, true))
    return admin.telegramId;
  if (admin.operator && w.operatorId === admin.id && !w.deletion)
    return admin.id;
  return authorize(w, admin.telegramId, true);
};

export const cookieOptions = (c: Context<AdminEnv>, origin: string) => ({
  httpOnly: true,
  secure: (c.req.header("origin") ?? origin).startsWith("https:"),
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 8 * 3600,
});

export function workspaceChange(store: Store) {
  return <T>(
    c: {
      req: { param: (key: string) => string };
      get: (key: "session") => Session;
    },
    fn: (w: Workspace, actor: string, sql: Sql) => T,
  ) =>
    store.change(validId(c.req.param("id")), (w, sql) =>
      fn(w, workspaceActor(w, c.get("session").admin), sql),
    );
}
