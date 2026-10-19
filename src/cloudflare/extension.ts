import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import { fingerprint } from "../setup/credentials.ts";
import { analyticsDimensions } from "./analytics.ts";
import { cloudflareQueryResources } from "./catalog.ts";
import { cloudflareTools, zoneSettingNames } from "./config.ts";
import type { CloudflareService } from "./service.ts";

export function cloudflareExtension(
  service: CloudflareService,
  workspaceId: string,
  revision: number,
): BuiltinExtension {
  const skill = readFileSync("skills/repodesk-cloudflare/SKILL.md", "utf8");
  const id = Type.String({ pattern: "^[a-fA-F0-9]{32}$" });
  return {
    id: "cloudflare",
    version: "3",
    path: "<inline:cloudflare>",
    enabled: true,
    execution: "read-only",
    workspaces: [workspaceId],
    tools: [...cloudflareTools],
    hash: fingerprint({ revision, skill, version: 3 }),
    toolErrorCodes: [
      "cloudflare_reconnect_required",
      "cloudflare_refresh_pending",
      "access_denied",
      "run_revoked",
      "cloudflare_private_request_required",
      "cloudflare_not_configured",
      "extension_configuration_changed",
      "cloudflare_zone_denied",
      "cloudflare_access_denied",
      "cloudflare_rate_limited",
      "cloudflare_request_failed",
      "cloudflare_analytics_unavailable",
      "cloudflare_analytics_range_invalid",
      "cloudflare_invalid_response",
      "cloudflare_setting_not_editable",
      "cloudflare_unavailable",
      "cloudflare_response_too_large",
      "cloudflare_preview_too_large",
      "resolve_existing_proposal_first",
    ],
    factory: (input) => async (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${skill}`,
      }));
      pi.registerTool({
        name: "query_cloudflare",
        label: "Query Cloudflare",
        description:
          "Read Cloudflare traffic analytics and account/selected-zone metadata across DNS, Pages, Workers, storage, security, TLS, routing and more. Use capabilities to discover supported resources and required parameters. Private interactive requests only. Secrets, source code, stored data and arbitrary API requests are excluded. Lists return one page.",
        parameters: Type.Object(
          {
            resource: Type.Union(
              ["capabilities", ...cloudflareQueryResources].map((v) =>
                Type.Literal(v),
              ),
            ),
            zoneId: Type.Optional(id),
            projectName: Type.Optional(
              Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,57}$" }),
            ),
            scriptName: Type.Optional(
              Type.String({ pattern: "^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$" }),
            ),
            bucketName: Type.Optional(
              Type.String({ pattern: "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" }),
            ),
            resourceId: Type.Optional(
              Type.String({
                pattern:
                  "^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$",
              }),
            ),
            cursor: Type.Optional(
              Type.String({ minLength: 1, maxLength: 2048 }),
            ),
            since: Type.Optional(
              Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            ),
            until: Type.Optional(
              Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            ),
            dimension: Type.Optional(
              Type.Union(analyticsDimensions.map((v) => Type.Literal(v))),
            ),
            page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
          },
          { additionalProperties: false },
        ),
        execute: async (_callId, args, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await service.query(
                  workspaceId,
                  input.runId,
                  revision,
                  args,
                  AbortSignal.any([input.signal, ...(signal ? [signal] : [])]),
                  input.guard,
                ),
              ),
            },
          ],
          details: {},
        }),
      });
      pi.registerTool({
        name: "propose_cloudflare_action",
        label: "Propose Cloudflare action",
        description:
          "Draft an exact DNS change, cache purge, zone setting change or Worker route create/update/delete for a configured zone. Only workspace owners/admins in private interactive requests. Creates an actor-bound approval; does not execute the change. Inspect zone_settings or worker_routes before changing them. Routes need explicit pattern and scriptName (null means bypass). For DNS supply a supported complete record. For purge specify files OR purgeEverything=true.",
        parameters: Type.Object(
          {
            action: Type.Union(
              [
                "update_zone_setting",
                "create_worker_route",
                "update_worker_route",
                "delete_worker_route",
                "create_dns_record",
                "update_dns_record",
                "delete_dns_record",
                "purge_cache",
              ].map((v) => Type.Literal(v)),
            ),
            zoneId: id,
            recordId: Type.Optional(id),
            routeId: Type.Optional(id),
            pattern: Type.Optional(
              Type.String({ minLength: 1, maxLength: 1024 }),
            ),
            scriptName: Type.Optional(
              Type.Union([
                Type.String({ pattern: "^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$" }),
                Type.Null(),
              ]),
            ),
            settingId: Type.Optional(
              Type.Union(zoneSettingNames.map((v) => Type.Literal(v))),
            ),
            value: Type.Optional(
              Type.Union([
                Type.String(),
                Type.Integer({ minimum: 0, maximum: 31536000 }),
              ]),
            ),
            record: Type.Optional(
              Type.Object(
                {
                  type: Type.Union(
                    ["A", "AAAA", "CNAME", "TXT", "MX"].map((v) =>
                      Type.Literal(v),
                    ),
                  ),
                  name: Type.String({ minLength: 1, maxLength: 253 }),
                  content: Type.String({ minLength: 1, maxLength: 1000 }),
                  ttl: Type.Integer({ minimum: 1, maximum: 86400 }),
                  proxied: Type.Optional(Type.Boolean()),
                  priority: Type.Optional(
                    Type.Integer({ minimum: 0, maximum: 65535 }),
                  ),
                },
                { additionalProperties: false },
              ),
            ),
            files: Type.Optional(
              Type.Array(Type.String({ maxLength: 2048 }), {
                minItems: 1,
                maxItems: 20,
              }),
            ),
            purgeEverything: Type.Optional(Type.Literal(true)),
          },
          { additionalProperties: false },
        ),
        execute: async (callId, args, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await service.propose(
                  workspaceId,
                  input.runId,
                  input.actor,
                  callId,
                  revision,
                  args,
                  AbortSignal.any([input.signal, ...(signal ? [signal] : [])]),
                  input.guard,
                ),
              ),
            },
          ],
          details: {},
        }),
      });
    },
  };
}
