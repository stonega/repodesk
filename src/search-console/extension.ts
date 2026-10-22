import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import { fingerprint } from "../setup/credentials.ts";
import { searchConsoleTool, searchDimensions } from "./config.ts";
import type { SearchConsoleService } from "./service.ts";

export function searchConsoleExtension(
  service: SearchConsoleService,
  workspaceId: string,
  revision: number,
): BuiltinExtension {
  const skill = readFileSync("skills/repodesk-search-console/SKILL.md", "utf8");
  return {
    id: "search-console",
    version: "1",
    path: "<inline:search-console>",
    enabled: true,
    execution: "read-only",
    workspaces: [workspaceId],
    tools: [searchConsoleTool],
    hash: fingerprint({ revision, skill, version: 1 }),
    toolErrorCodes: [
      "access_denied",
      "run_revoked",
      "extension_configuration_changed",
      "deployment_paused",
      "search_console_private_request_required",
      "search_console_not_configured",
      "search_console_property_denied",
      "search_console_access_denied",
      "search_console_rate_limited",
      "search_console_request_failed",
      "search_console_invalid_response",
      "search_console_unavailable",
      "google_not_connected",
      "google_reconnect_required",
      "google_refresh_pending",
      "google_scope_required",
      "google_access_denied",
      "google_rate_limited",
      "google_request_failed",
      "google_unavailable",
      "google_invalid_response",
      "google_response_too_large",
    ],
    factory: (input) => async (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${skill}`,
      }));
      pi.registerTool({
        name: searchConsoleTool,
        label: "Query Google Search Console",
        description:
          "Read selected Google Search Console properties, search performance, sitemaps or Google's indexed URL status. Private interactive requests only; the shared Google connection requires an active workspace owner/admin. Start with properties to find allowed siteUrl values. Analytics requires inclusive YYYY-MM-DD dates (Pacific time), returns finalized top rows only (up to 100/page). URL inspection reads the indexed version; it does not perform a live test or request indexing.",
        parameters: Type.Object(
          {
            resource: Type.Union(
              ["properties", "analytics", "sitemaps", "inspect_url"].map((v) =>
                Type.Literal(v),
              ),
            ),
            siteUrl: Type.Optional(Type.String({ maxLength: 2048 })),
            startDate: Type.Optional(
              Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            ),
            endDate: Type.Optional(
              Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            ),
            dimensions: Type.Optional(
              Type.Array(
                Type.Union(searchDimensions.map((v) => Type.Literal(v))),
                { maxItems: 6, uniqueItems: true },
              ),
            ),
            type: Type.Optional(
              Type.Union(
                ["web", "image", "video", "news", "discover", "googleNews"].map(
                  (v) => Type.Literal(v),
                ),
              ),
            ),
            rowLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            startRow: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 50000 }),
            ),
            inspectionUrl: Type.Optional(Type.String({ maxLength: 2048 })),
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
    },
  };
}
