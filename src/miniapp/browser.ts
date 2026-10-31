import { Hono } from "hono";
import { z } from "zod";
import { deploymentOrigin } from "../admin/site.ts";
import { BrowserMembers } from "../browser/member.ts";
import type { BrowserService } from "../browser/service.ts";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { decrypt } from "../setup/credentials.ts";
import { telegramIdentity } from "./auth.ts";

const request = z
  .object({
    initData: z.string().max(16384),
    reference: z.string().regex(/^browser_[a-f0-9]{32}$/),
    operation: z.unknown().optional(),
  })
  .strict();
/** A launch reference locates a workspace; only signed Telegram identity chooses its owner. */
export function browserMiniRoutes(
  store: Store,
  key: string,
  origin: string,
  service: BrowserService,
) {
  const app = new Hono(),
    members = new BrowserMembers(store, service);
  app.post("/*", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const deployment = await store.deployment();
    requireThat(
      c.req.header("origin") === deploymentOrigin(deployment, origin),
      "origin_denied",
      403,
    );
    requireThat(
      deployment.active &&
        !deployment.paused &&
        deployment.bot &&
        deployment.credentials.bot,
      "miniapp_unavailable",
      503,
    );
    const input = request.parse(await c.req.json());
    const identity = telegramIdentity(
      input.initData,
      decrypt(key, "bot", deployment.credentials.bot),
    );
    const hex = input.reference.slice(8),
      workspaceId = z
        .uuid()
        .parse(
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
    const owner = { workspaceId, actor: identity.actor };
    // No cookie, model-supplied actor, admin role or unchecked start parameter authorizes this route.
    await service
      .personalRuntime(owner, deployment.bot.id, true)
      .catch((error) => {
        // The landing page must still explain missing service configuration.
        if (
          service.configured ||
          !(error instanceof Error) ||
          error.message !== "browser_service_unavailable"
        )
          throw error;
      });
    const path = c.req.path.split("/").at(-1);
    if (path === "view") {
      requireThat(input.operation === undefined, "invalid_request", 400);
      return c.json(await members.view(owner, deployment.bot.id));
    }
    if (path === "decide") {
      const value = z
        .object({ id: z.uuid(), approve: z.boolean() })
        .strict()
        .parse(input.operation);
      await service.decide(owner, value.id, value.approve);
      return c.json({ status: "completed" });
    }
    if (path === "input") {
      const value = z
        .object({
          id: z.uuid(),
          submissionId: z.uuid(),
          value: z.string().min(1).max(4096),
        })
        .strict()
        .parse(input.operation);
      return c.json(
        await members.submitInput(
          owner,
          deployment.bot.id,
          value.id,
          value.submissionId,
          value.value,
        ),
      );
    }
    requireThat(path === "operate", "not_found", 404);
    return c.json(
      await members.operate(owner, deployment.bot.id, input.operation),
    );
  });
  return app;
}
