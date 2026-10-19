import { requireThat } from "../domain.ts";
import { projectFields } from "./catalog.ts";
import { row } from "./client.ts";

export const analyticsDimensions = [
  "overview",
  "country",
  "status",
  "content",
  "browser",
] as const;
const breakdowns = {
  overview: "",
  country: "countryMap { clientCountryName requests bytes threats }",
  status: "responseStatusMap { edgeResponseStatus requests }",
  content: "contentTypeMap { edgeResponseContentTypeName requests bytes }",
  browser: "browserMap { uaBrowserFamily pageViews }",
};
const breakdownFields = {
  overview: "",
  country:
    "sum.countryMap.clientCountryName sum.countryMap.requests sum.countryMap.bytes sum.countryMap.threats",
  status:
    "sum.responseStatusMap.edgeResponseStatus sum.responseStatusMap.requests",
  content:
    "sum.contentTypeMap.edgeResponseContentTypeName sum.contentTypeMap.requests sum.contentTypeMap.bytes",
  browser: "sum.browserMap.uaBrowserFamily sum.browserMap.pageViews",
};
export function analyticsRequest(
  zoneId: string,
  since?: string,
  until?: string,
  dimension: keyof typeof breakdowns = "overview",
) {
  const end =
    until ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const start =
    since ??
    new Date(Date.parse(end) - 6 * 86400000).toISOString().slice(0, 10);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  requireThat(
    Number.isInteger(days) &&
      days >= 1 &&
      days <= 31 &&
      end <= new Date().toISOString().slice(0, 10),
    "cloudflare_analytics_range_invalid",
    400,
  );
  return {
    query: `query RepoDeskTraffic($zoneTag: string, $start: Date, $end: Date) { viewer { zones(filter: {zoneTag: $zoneTag}) { zoneTag httpRequests1dGroups(limit: 31, orderBy: [date_ASC], filter: {date_geq: $start, date_leq: $end}) { dimensions { date } sum { requests bytes cachedRequests cachedBytes threats pageViews encryptedRequests encryptedBytes ${breakdowns[dimension]} } uniq { uniques } } } } }`,
    variables: { zoneTag: zoneId, start, end },
  };
}
export function analyticsOutput(
  data: unknown,
  zoneId: string,
  dimension: keyof typeof breakdowns = "overview",
) {
  const zones = row(row(data).viewer).zones;
  requireThat(
    Array.isArray(zones) &&
      zones.length === 1 &&
      row(zones[0]).zoneTag === zoneId,
    "cloudflare_analytics_unavailable",
    409,
  );
  const days = row(zones[0]).httpRequests1dGroups;
  requireThat(
    Array.isArray(days) && days.length <= 31,
    "cloudflare_invalid_response",
    502,
  );
  return projectFields(
    days,
    `dimensions.date sum.requests sum.bytes sum.cachedRequests sum.cachedBytes sum.threats sum.pageViews sum.encryptedRequests sum.encryptedBytes uniq.uniques ${breakdownFields[dimension]}`,
  );
}
