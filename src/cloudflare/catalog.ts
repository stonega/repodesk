import { requireThat } from "../domain.ts";
import { deployment, dnsRecord, project, row } from "./client.ts";

interface Resource {
  scope: "account" | "zone";
  path: string;
  fields: string;
  pagination: "page" | "local" | "cursor" | "none";
  key?: string;
  size?: number;
}
const zone = (
  path: string,
  fields: string,
  pagination: Resource["pagination"] = "local",
): Resource => ({ scope: "zone", path, fields, pagination });
const account = (
  path: string,
  fields: string,
  pagination: Resource["pagination"] = "local",
): Resource => ({ scope: "account", path, fields, pagination });

/** Closed API inventory. Every response uses explicit scalar field paths, including nested arrays. */
export const cloudflareResources = {
  dns_records: zone("/dns_records", "", "page"),
  pages_projects: { ...account("/pages/projects", "", "page"), size: 10 },
  pages_deployments: {
    ...account("/pages/projects/{projectName}/deployments", "", "page"),
    size: 10,
  },
  pages_domains: account(
    "/pages/projects/{projectName}/domains",
    "id name status created_on zone_tag validation_data.status verification_data.status",
  ),
  zone_settings: zone("/settings", "id value editable modified_on"),
  dnssec: zone(
    "/dnssec",
    "status algorithm key_tag digest digest_type digest_algorithm ds dnskey public_key",
    "none",
  ),
  ssl_certificates: zone(
    "/ssl/certificate_packs",
    "id type status hosts certificate_authority certificates.id certificates.hosts certificates.issuer certificates.expires_on",
    "page",
  ),
  ssl_verification: zone(
    "/ssl/verification",
    "certificate_status verification_type verification_status",
  ),
  worker_routes: zone("/workers/routes", "id pattern script"),
  page_rules: zone(
    "/pagerules",
    "id status priority created_on modified_on targets.target targets.constraint.operator targets.constraint.value actions.id actions.value",
    "page",
  ),
  rulesets: zone(
    "/rulesets",
    "id name description kind phase version last_updated",
  ),
  ruleset: zone(
    "/rulesets/{resourceId}",
    "id name description kind phase version last_updated rules.id rules.action rules.expression rules.description rules.enabled rules.version",
    "none",
  ),
  firewall_rules: zone(
    "/firewall/rules",
    "id action description paused priority filter.id filter.expression",
    "page",
  ),
  access_rules: zone(
    "/firewall/access_rules/rules",
    "id mode notes configuration.target configuration.value created_on modified_on",
    "page",
  ),
  load_balancers: zone(
    "/load_balancers",
    "id name description enabled proxied ttl steering_policy default_pools fallback_pool created_on modified_on",
  ),
  healthchecks: zone(
    "/healthchecks",
    "id name description address type status suspended interval retries timeout created_on modified_on",
    "page",
  ),
  custom_hostnames: zone(
    "/custom_hostnames",
    "id hostname status created_at ssl.status ssl.method ssl.type ssl.expires_on",
    "page",
  ),
  email_routing: zone(
    "/email/routing",
    "id tag name enabled status created modified",
    "none",
  ),
  email_routing_rules: zone(
    "/email/routing/rules",
    "tag name enabled priority matchers.type matchers.field matchers.value actions.type",
    "page",
  ),
  waiting_rooms: zone(
    "/waiting_rooms",
    "id name description host path suspended queue_all new_users_per_minute total_active_users session_duration queueing_method",
    "page",
  ),
  account: account("", "id name type created_on", "none"),
  workers: account(
    "/workers/scripts",
    "id etag created_on modified_on usage_model handlers compatibility_date",
  ),
  worker_domains: account(
    "/workers/domains",
    "id hostname zone_id zone_name service environment",
  ),
  worker_schedules: {
    ...account(
      "/workers/scripts/{scriptName}/schedules",
      "cron created_on modified_on",
    ),
    key: "schedules",
  },
  worker_deployments: {
    ...account(
      "/workers/scripts/{scriptName}/deployments",
      "id source strategy created_on versions.version_id versions.percentage",
      "page",
    ),
    key: "deployments",
  },
  worker_versions: {
    ...account(
      "/workers/scripts/{scriptName}/versions",
      "id number metadata.created_on metadata.source",
      "page",
    ),
    key: "items",
  },
  worker_subdomain: account("/workers/subdomain", "subdomain", "none"),
  kv_namespaces: account(
    "/storage/kv/namespaces",
    "id title supports_url_encoding",
    "page",
  ),
  r2_buckets: {
    ...account(
      "/r2/buckets",
      "name creation_date location storage_class jurisdiction",
      "cursor",
    ),
    key: "buckets",
  },
  r2_bucket: account(
    "/r2/buckets/{bucketName}",
    "name creation_date location storage_class jurisdiction",
    "none",
  ),
  d1_databases: account(
    "/d1/database",
    "uuid name version created_at jurisdiction",
    "page",
  ),
  d1_database: account(
    "/d1/database/{resourceId}",
    "uuid name version created_at file_size num_tables read_replication.mode",
    "none",
  ),
  queues: account(
    "/queues",
    "queue_id queue_name created_on modified_on producers_total_count consumers_total_count",
  ),
  queue_consumers: account(
    "/queues/{resourceId}/consumers",
    "consumer_id type script service environment created_on",
  ),
  vectorize_indexes: account(
    "/vectorize/v2/indexes",
    "name description created_on modified_on config.dimensions config.metric",
  ),
  hyperdrive_configs: account(
    "/hyperdrive/configs",
    "id name created_on modified_on origin_connection_limit caching.disabled caching.max_age caching.stale_while_revalidate",
    "page",
  ),
  turnstile_widgets: account(
    "/challenges/widgets",
    "sitekey name domains mode clearance_level bot_fight_mode created_on modified_on",
    "page",
  ),
  load_balancer_pools: account(
    "/load_balancers/pools",
    "id name description enabled monitor check_regions minimum_origins origins.name origins.address origins.enabled origins.weight created_on modified_on",
  ),
  load_balancer_monitors: account(
    "/load_balancers/monitors",
    "id type description method path port interval retries timeout expected_codes created_on modified_on",
  ),
  account_rulesets: account(
    "/rulesets",
    "id name description kind phase version last_updated",
  ),
  account_ruleset: account(
    "/rulesets/{resourceId}",
    "id name description kind phase version last_updated rules.id rules.action rules.expression rules.description rules.enabled",
    "none",
  ),
  web_analytics_sites: account(
    "/rum/site_info/list",
    "site_tag site_id host created auto_install zone_tag",
    "page",
  ),
} satisfies Record<string, Resource>;
export type CloudflareResourceName = keyof typeof cloudflareResources;
export const cloudflareQueryResources = [
  "zones",
  "zone_analytics",
  ...Object.keys(cloudflareResources),
] as [string, ...string[]];

/** Object-valued leaves are excluded, so adding an upstream secret cannot widen output. */
export function projectFields(value: unknown, fields: string): unknown {
  if (Array.isArray(value))
    return value.map((item) => projectFields(item, fields));
  const source = row(value);
  const output: Record<string, unknown> = {};
  const paths = fields.split(" ").filter(Boolean);
  for (const key of new Set(
    paths.map((path) => path.split(".")[0] as string),
  )) {
    if (!(key in source)) continue;
    const nested = paths
      .filter((path) => path.startsWith(`${key}.`))
      .map((path) => path.slice(key.length + 1));
    const v = source[key];
    if (nested.length) output[key] = projectFields(v, nested.join(" "));
    else if (v === null || ["string", "number", "boolean"].includes(typeof v))
      output[key] = v;
    else if (
      Array.isArray(v) &&
      v.every(
        (item) =>
          item === null ||
          ["string", "number", "boolean"].includes(typeof item),
      )
    )
      output[key] = v;
  }
  return output;
}
export function resourceDefinition(name: string): Resource | undefined {
  return Object.hasOwn(cloudflareResources, name)
    ? cloudflareResources[name as CloudflareResourceName]
    : undefined;
}
export function resourceParameters(definition: Resource): string[] {
  return [...definition.path.matchAll(/\{(\w+)\}/g)].map(
    (match) => match[1] as string,
  );
}
export function resourcePath(
  definition: Resource,
  input: Record<string, unknown>,
  scopeId: string,
) {
  const prefix =
    definition.scope === "zone" ? `/zones/${scopeId}` : `/accounts/${scopeId}`;
  const path =
    prefix +
    definition.path.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(String(input[key])),
    );
  const query = new URLSearchParams();
  const size = definition.size ?? 20;
  if (definition.pagination === "page") {
    query.set("page", String(input.page));
    query.set("per_page", String(size));
  }
  if (definition.pagination === "cursor") {
    query.set("per_page", String(size));
    if (input.cursor) query.set("cursor", String(input.cursor));
  }
  return path + (query.size ? `?${query}` : "");
}
export function resourceOutput(
  name: string,
  definition: Resource,
  result: unknown,
  page: number,
) {
  let source = definition.key ? row(result)[definition.key] : result;
  if (definition.pagination !== "none") {
    requireThat(Array.isArray(source), "cloudflare_invalid_response", 502);
    if (definition.pagination === "local") {
      const total = source.length;
      source = source.slice((page - 1) * 20, page * 20);
      return {
        result: projectFields(source, definition.fields),
        localPagination: {
          page,
          per_page: 20,
          total_count: total,
          total_pages: Math.ceil(total / 20),
        },
      };
    }
    requireThat(
      source.length <= (definition.size ?? 20),
      "cloudflare_response_too_large",
      409,
    );
  } else
    requireThat(
      source && typeof source === "object" && !Array.isArray(source),
      "cloudflare_invalid_response",
      502,
    );
  return {
    result:
      name === "dns_records"
        ? (source as unknown[]).map(dnsRecord)
        : name === "pages_projects"
          ? (source as unknown[]).map(project)
          : name === "pages_deployments"
            ? (source as unknown[]).map(deployment)
            : projectFields(source, definition.fields),
  };
}
