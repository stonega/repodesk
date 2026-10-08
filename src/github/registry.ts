import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat } from "../domain.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import { GitHubApp, type GitHubAppConfig } from "./app.ts";

export const githubAppPermissions = {
  contents: "write",
  metadata: "read",
  issues: "write",
  pull_requests: "write",
  members: "read",
} as const;

const account = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
export const registrationInput = z.discriminatedUnion("owner", [
  z
    .object({
      owner: z.literal("personal"),
      name: z.string().trim().min(1).max(34).default("repodesk"),
      public: z.boolean(),
      source: z.literal("setup").optional(),
    })
    .strict(),
  z
    .object({
      owner: z.literal("organization"),
      organization: account,
      name: z.string().trim().min(1).max(34).default("repodesk"),
      public: z.boolean(),
      source: z.literal("setup").optional(),
    })
    .strict(),
]);
const storedConfig = z.object({
  id: z.number().int().positive(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(8192),
  privateKey: z.string().min(1).max(32768),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100),
  webhookSecret: z.string().min(1).max(8192).optional(),
});

/** Credentials belong to the operator; repository connections remain workspace scoped. */
export class GitHubApps {
  constructor(
    private store: Store,
    private key: string,
    private fallback?: GitHubApp,
    private transport: typeof fetch = fetch,
  ) {}
  get canRegister() {
    return !!this.key && !this.fallback;
  }
  async get(operatorId: string): Promise<GitHubApp | undefined> {
    if (this.fallback) return this.fallback;
    const row = (
      await this.store.pool.query(
        "SELECT credentials FROM github_apps WHERE operator_id=$1",
        [operatorId],
      )
    ).rows[0];
    if (!row) return undefined;
    const config = storedConfig.parse(
      JSON.parse(
        decrypt(this.key, `github-app:${operatorId}`, row.credentials),
      ),
    );
    return new GitHubApp(config, this.transport);
  }
  async save(sql: Sql, operatorId: string, config: GitHubAppConfig) {
    const saved = await sql.query(
      "INSERT INTO github_apps(operator_id,credentials) VALUES($1,$2) ON CONFLICT(operator_id) DO NOTHING RETURNING operator_id",
      [
        operatorId,
        encrypt(this.key, `github-app:${operatorId}`, JSON.stringify(config)),
      ],
    );
    requireThat(saved.rowCount, "github_app_already_configured", 409);
  }
  async convert(code: string, organization: string | null) {
    requireThat(
      /^[a-zA-Z0-9_-]{1,200}$/.test(code),
      "github_registration_failed",
      400,
    );
    try {
      const response = await this.transport(
        `https://api.github.com/app-manifests/${code}/conversions`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      requireThat(response.ok, "github_registration_failed", 502);
      const data = z
        .object({
          id: storedConfig.shape.id,
          slug: storedConfig.shape.slug,
          client_id: storedConfig.shape.clientId,
          client_secret: storedConfig.shape.clientSecret,
          pem: storedConfig.shape.privateKey,
          webhook_secret: z.string().min(1).max(8192),
          owner: z.object({ login: account }),
          permissions: z.record(z.string(), z.string()),
        })
        .parse(await response.json());
      requireThat(
        !organization ||
          data.owner.login.toLowerCase() === organization.toLowerCase(),
        "github_registration_failed",
        400,
      );
      requireThat(
        Object.keys(data.permissions).length ===
          Object.keys(githubAppPermissions).length &&
          Object.entries(githubAppPermissions).every(
            ([name, level]) => data.permissions[name] === level,
          ),
        "github_registration_failed",
        400,
      );
      requireThat(
        createPrivateKey(data.pem).asymmetricKeyType === "rsa",
        "github_registration_failed",
        400,
      );
      return {
        id: data.id,
        slug: data.slug,
        clientId: data.client_id,
        clientSecret: data.client_secret,
        privateKey: data.pem,
        webhookSecret: data.webhook_secret,
      };
    } catch {
      // Neither GitHub's response nor key parsing errors may expose credentials.
      throw new Fault("github_registration_failed", 502);
    }
  }
}
