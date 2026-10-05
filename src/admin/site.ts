import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import { transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, type Deployment, requireThat } from "../domain.ts";
import { operator } from "./auth.ts";

export const siteDomain = z
  .string()
  .trim()
  .max(260)
  .regex(
    /^[^\s/:?#@\\]+$/,
    "Enter only a hostname, without a scheme, port or path.",
  )
  .transform((value) => domainToASCII(value.toLowerCase()))
  .refine(
    (value) =>
      value.length <= 253 &&
      !isIP(value) &&
      value.split(".").length >= 2 &&
      /^[a-z][a-z0-9-]*$/.test(value.split(".").at(-1) ?? "") &&
      !/\.(localhost|local|internal)$/.test(value) &&
      value
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    "Enter a domain such as admin.example.com, without a scheme, port or path.",
  );
const siteInput = z
  .object({
    revision: z.number().int().nonnegative(),
    domain: siteDomain.nullable(),
  })
  .strict();

export function deploymentOrigin(deployment: Deployment, fallback: string) {
  return deployment.site?.domain
    ? `https://${deployment.site.domain}`
    : fallback;
}

export async function publicOrigin(store: Store, fallback: string) {
  return deploymentOrigin(await store.deployment(), fallback);
}

export interface SiteView {
  revision: number;
  domain: string | null;
  origin: string;
  fallbackOrigin: string;
  githubCallbackUrl: string;
  githubSetupUrl: string;
  telegramWebhookUrl: string;
  webhookReady: boolean;
  telegramTransport: "polling" | "webhook";
}

export class SiteService {
  constructor(
    private store: Store,
    private fallback: string,
  ) {}

  async view(
    admin: Admin,
    telegramTransport: SiteView["telegramTransport"],
  ): Promise<SiteView> {
    operator(admin);
    const deployment = await this.store.deployment();
    const origin = deploymentOrigin(deployment, this.fallback);
    return {
      revision: deployment.site?.revision ?? 0,
      domain: deployment.site?.domain ?? null,
      origin,
      fallbackOrigin: this.fallback,
      githubCallbackUrl: `${origin}/api/admin/github/callback`,
      githubSetupUrl: `${origin}/api/admin/github/app/callback`,
      telegramWebhookUrl: `${origin}/telegram/webhook`,
      webhookReady: deployment.webhookReady,
      telegramTransport,
    };
  }

  async save(admin: Admin, value: unknown) {
    operator(admin);
    const input = siteInput.parse(value);
    await transaction(this.store.pool, async (sql) => {
      const deployment = await this.store.deployment(sql, true);
      requireThat(
        (deployment.site?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      if ((deployment.site?.domain ?? null) === input.domain) return;
      deployment.site = { domain: input.domain, revision: input.revision + 1 };
      deployment.webhookReady = false;
      deployment.version++;
      // Pending OAuth flows are bound to the previous callback origin.
      await sql.query("DELETE FROM github_flows");
      await sql.query("DELETE FROM github_app_flows");
      await sql.query("DELETE FROM github_user_flows");
      await this.store.saveDeployment(sql, deployment);
      await sql.query(
        "INSERT INTO operator_audit(actor,action,target) VALUES($1,'site.domain_changed',$2)",
        [admin.id, input.domain ?? this.fallback],
      );
    });
  }
}
