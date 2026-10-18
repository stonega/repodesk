import { z } from "zod";

export const cloudflareId = z
  .string()
  .regex(/^[a-f0-9]{32}$/i)
  .transform((v) => v.toLowerCase());
export const cloudflareSettings = z
  .object({
    enabled: z.boolean(),
    accountId: z.union([cloudflareId, z.literal("")]),
    zoneIds: z.array(cloudflareId).max(20),
    authMethod: z.enum(["oauth", "api_token"]).optional(),
  })
  .strict()
  .refine((s) => new Set(s.zoneIds).size === s.zoneIds.length);
export type CloudflareSettings = z.infer<typeof cloudflareSettings>;
export const cloudflareResource = z.object({
  id: cloudflareId,
  name: z.string().min(1).max(253),
});
export type CloudflareResource = z.infer<typeof cloudflareResource>;
export interface CloudflareResources {
  account?: CloudflareResource;
  zones: CloudflareResource[];
}
export interface CloudflareResourcePage {
  items: CloudflareResource[];
  page: number;
  hasMore: boolean;
}
export const cloudflareDiscovery = z.discriminatedUnion("resource", [
  z
    .object({
      revision: z.number().int().nonnegative(),
      resource: z.literal("accounts"),
      page: z.number().int().min(1).max(1000).default(1),
    })
    .strict(),
  z
    .object({
      revision: z.number().int().nonnegative(),
      resource: z.literal("zones"),
      accountId: cloudflareId,
      page: z.number().int().min(1).max(1000).default(1),
    })
    .strict(),
]);
export interface CloudflareConfig {
  settings: CloudflareSettings;
  resources?: CloudflareResources;
  credential?: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    scopes: string[];
    connection?: {
      id: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt: string;
      reconnectRequired?: boolean;
      refresh?: { id: string; at: string };
    };
    flow?: {
      stateHash: string;
      sessionHash: string;
      adminId: string;
      revision: number;
      redirectUri: string;
      verifier: string;
      expiresAt: string;
      exchanging?: boolean;
    };
  };
}
export interface CloudflarePage {
  revision: number;
  settings: CloudflareSettings;
  tokenConfigured: boolean;
  resources?: CloudflareResources;
  oauth?: {
    clientId: string;
    scopes: string[];
    clientSecretConfigured: boolean;
    redirectUri: string;
    status: "not_connected" | "connected" | "refreshing" | "reconnect_required";
    expiresAt?: string;
  };
}
export const emptyCloudflare: CloudflareSettings = {
  enabled: false,
  accountId: "",
  zoneIds: [],
  authMethod: "api_token",
};
export const cloudflareSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: cloudflareSettings,
    apiToken: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,256}$/)
      .optional(),
    removeToken: z.boolean().optional(),
    verifyResources: z.boolean().optional(),
    oauthClient: z
      .object({
        clientId: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_.-]{1,200}$/),
        clientSecret: z.string().trim().min(1).max(4096).optional(),
        scopes: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,199}$/))
          .min(1)
          .max(30)
          .refine(
            (s) =>
              new Set(s).size === s.length && s.some((v) => v.includes(".")),
          ),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => !(s.apiToken && s.removeToken));

export const cloudflareQuery = z
  .object({
    resource: z.enum([
      "zones",
      "dns_records",
      "pages_projects",
      "pages_deployments",
    ]),
    zoneId: cloudflareId.optional(),
    projectName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,57}$/)
      .optional(),
    page: z.number().int().min(1).max(1000).default(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      (s.resource === "dns_records") !== !!s.zoneId ||
      (s.resource === "pages_deployments") !== !!s.projectName
    )
      ctx.addIssue({
        code: "custom",
        message: "Select the resource's zone or project.",
      });
  });

const record = z
  .object({
    type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX"]),
    name: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(?:\*\.)?[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?$/),
    content: z.string().min(1).max(1000),
    ttl: z
      .number()
      .int()
      .refine((n) => n === 1 || (n >= 60 && n <= 86400)),
    proxied: z.boolean().optional(),
    priority: z.number().int().min(0).max(65535).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.type === "MX" && s.priority === undefined)
      ctx.addIssue({ code: "custom", message: "MX requires priority." });
    if (s.proxied && !["A", "AAAA", "CNAME"].includes(s.type))
      ctx.addIssue({
        code: "custom",
        message: "This record type cannot be proxied.",
      });
  });
export const cloudflareAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_dns_record"),
      zoneId: cloudflareId,
      record,
    })
    .strict(),
  z
    .object({
      action: z.literal("update_dns_record"),
      zoneId: cloudflareId,
      recordId: cloudflareId,
      record,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete_dns_record"),
      zoneId: cloudflareId,
      recordId: cloudflareId,
    })
    .strict(),
  z
    .object({
      action: z.literal("purge_cache"),
      zoneId: cloudflareId,
      files: z
        .array(
          z
            .url()
            .max(2048)
            .refine((s) => /^https?:\/\//.test(s)),
        )
        .min(1)
        .max(20)
        .optional(),
      purgeEverything: z.literal(true).optional(),
    })
    .strict()
    .refine((s) => !!s.files !== !!s.purgeEverything),
]);
export type CloudflareAction = z.infer<typeof cloudflareAction>;
export const cloudflareTools = [
  "query_cloudflare",
  "propose_cloudflare_action",
] as const;

export function cloudflareHasCredentials(config: CloudflareConfig) {
  const c = config.oauth?.connection;
  return (config.settings.authMethod ?? "api_token") === "api_token"
    ? !!config.credential
    : !!c &&
        !c.reconnectRequired &&
        (!c.refresh || Date.parse(c.refresh.at) + 30000 >= Date.now()) &&
        (Date.parse(c.expiresAt) > Date.now() || !!c.refreshToken);
}
