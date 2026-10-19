import { projectFields } from "./catalog.ts";
import { dnsRecord } from "./client.ts";
import type { CloudflareAction } from "./config.ts";

export function actionTarget(request: CloudflareAction) {
  const base = `/zones/${request.zoneId}`;
  if (request.action === "update_zone_setting")
    return `${base}/settings/${request.settingId}`;
  if (request.action.endsWith("worker_route"))
    return `${base}/workers/routes${"routeId" in request ? `/${request.routeId}` : ""}`;
  return `${base}/dns_records${"recordId" in request ? `/${request.recordId}` : ""}`;
}
export function actionSnapshot(request: CloudflareAction, value: unknown) {
  return request.action === "update_zone_setting"
    ? projectFields(value, "id value")
    : request.action.endsWith("worker_route")
      ? projectFields(value, "id pattern script")
      : dnsRecord(value);
}
export function actionWrite(request: CloudflareAction): {
  path: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
} {
  if (request.action === "purge_cache")
    return {
      path: `/zones/${request.zoneId}/purge_cache`,
      method: "POST",
      body: request.purgeEverything
        ? { purge_everything: true }
        : { files: request.files },
    };
  return {
    path: actionTarget(request),
    method: request.action.startsWith("delete_")
      ? "DELETE"
      : request.action === "update_worker_route"
        ? "PUT"
        : request.action.startsWith("update_")
          ? "PATCH"
          : "POST",
    body:
      "record" in request
        ? request.record
        : request.action === "update_zone_setting"
          ? { value: request.value }
          : "pattern" in request
            ? { pattern: request.pattern, script: request.scriptName }
            : undefined,
  };
}
export function workerRouteWithinZone(pattern: string, zoneName: string) {
  const host = pattern
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    ?.replace(/^\*\./, "")
    .toLowerCase();
  return !!host && (host === zoneName || host.endsWith(`.${zoneName}`));
}
