import { z } from "zod";
import { analyticsDimensions } from "./analytics.ts";
import {
  cloudflareQueryResources,
  resourceDefinition,
  resourceParameters,
} from "./catalog.ts";

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
    resource: z.enum(["capabilities", ...cloudflareQueryResources]),
    zoneId: cloudflareId.optional(),
    projectName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,57}$/)
      .optional(),
    scriptName: z
      .string()
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/)
      .optional(),
    bucketName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
      .optional(),
    resourceId: z
      .string()
      .regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)
      .optional(),
    page: z.number().int().min(1).max(1000).default(1),
    cursor: z.string().min(1).max(2048).optional(),
    since: z.iso.date().optional(),
    until: z.iso.date().optional(),
    dimension: z.enum(analyticsDimensions).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const definition = resourceDefinition(s.resource);
    const analytics = s.resource === "zone_analytics";
    const required = definition ? resourceParameters(definition) : [];
    if (definition?.scope === "zone" || analytics) required.push("zoneId");
    const allowed = new Set([
      ...required,
      ...(analytics ? ["since", "until", "dimension"] : []),
      ...(definition?.pagination === "cursor" ? ["cursor"] : []),
    ]);
    const supplied = s as Record<string, unknown>;
    if (
      required.some((key) => !supplied[key]) ||
      Object.keys(s).some(
        (key) => !["resource", "page"].includes(key) && !allowed.has(key),
      ) ||
      (s.page !== 1 &&
        (!definition || ["none", "cursor"].includes(definition.pagination)))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Select only the resource's required zone, identifiers and supported pagination or analytics options.",
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
export const zoneSettingValues = {
  ssl: ["off", "flexible", "full", "strict"],
  always_use_https: ["on", "off"],
  automatic_https_rewrites: ["on", "off"],
  min_tls_version: ["1.0", "1.1", "1.2", "1.3"],
  tls_1_3: ["on", "off", "zrt"],
  security_level: [
    "off",
    "essentially_off",
    "low",
    "medium",
    "high",
    "under_attack",
  ],
  browser_check: ["on", "off"],
  cache_level: ["aggressive", "basic", "simplified"],
  development_mode: ["on", "off"],
  http3: ["on", "off"],
  ipv6: ["on", "off"],
  websockets: ["on", "off"],
  early_hints: ["on", "off"],
  browser_cache_ttl: [] as string[],
} satisfies Record<string, string[]>;
export const zoneSettingNames = Object.keys(zoneSettingValues) as [
  keyof typeof zoneSettingValues,
  ...(keyof typeof zoneSettingValues)[],
];
const workerPattern = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?:https?:\/\/)?(?:\*\.)?[a-zA-Z0-9][a-zA-Z0-9.-]*(?:\/[^\s?#]*)?$/);
const workerScript = z
  .string()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/)
  .nullable();
export const cloudflareAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("update_zone_setting"),
      zoneId: cloudflareId,
      settingId: z.enum(zoneSettingNames),
      value: z.union([z.string(), z.number().int().min(0).max(31536000)]),
    })
    .strict()
    .superRefine((s, ctx) => {
      if (
        s.settingId === "browser_cache_ttl"
          ? typeof s.value !== "number"
          : typeof s.value !== "string" ||
            !zoneSettingValues[s.settingId].includes(s.value)
      )
        ctx.addIssue({
          code: "custom",
          message: "Unsupported value for this zone setting.",
        });
    }),
  z
    .object({
      action: z.literal("create_worker_route"),
      zoneId: cloudflareId,
      pattern: workerPattern,
      scriptName: workerScript,
    })
    .strict(),
  z
    .object({
      action: z.literal("update_worker_route"),
      zoneId: cloudflareId,
      routeId: cloudflareId,
      pattern: workerPattern,
      scriptName: workerScript,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete_worker_route"),
      zoneId: cloudflareId,
      routeId: cloudflareId,
    })
    .strict(),
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
