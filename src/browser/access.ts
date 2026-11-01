import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireThat } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import {
  type BrowserAction,
  type BrowserController,
  browserAction,
  browserController,
  browserLimits,
  browserUrl,
} from "./config.ts";
import type { BrowserHostPolicy } from "./protocol.ts";
import { hostResult } from "./protocol.ts";
import { sameController } from "./state.ts";

const integer = z.number().int().nonnegative().safe();
export const browserOrigin = browserUrl.refine(
  (value) => new URL(value).origin === value,
);
export const browserPageBinding = z
  .object({
    id: z.uuid(),
    revision: integer,
    origin: browserOrigin,
  })
  .strict();
export const browserGrant = z
  .object({
    controller: browserController,
    configuration: integer,
    epoch: integer,
    origins: z.array(browserOrigin).max(32),
    previewOrigins: z.array(browserOrigin).max(8),
    expiresAt: integer,
  })
  .strict();
export type BrowserGrant = z.infer<typeof browserGrant>;
export const browserSite = z
  .object({
    origin: browserOrigin,
    preview: z.boolean(),
    configuration: integer,
    epoch: integer,
    approvedAt: integer,
  })
  .strict();
const sameConsumer = (a: BrowserController, b: BrowserController) =>
  a.kind === b.kind &&
  a.id === b.id &&
  a.pluginId === b.pluginId &&
  a.pluginRevision === b.pluginRevision;
export const browserAccessRequest = z
  .object({
    id: z.uuid(),
    controller: browserController,
    configuration: integer,
    epoch: integer,
    operationId: z.string().min(1).max(200),
    kind: z.enum(["site", "action", "control"]),
    action: browserAction.optional(),
    origin: browserOrigin.optional(),
    preview: z.boolean().default(false),
    rememberSite: z.boolean().default(false),
    page: browserPageBinding.optional(),
    generation: integer.optional(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum([
      "waiting",
      "approved",
      "applying",
      "completed",
      "denied",
      "cancelled",
      "expired",
      "unknown",
    ]),
    expiresAt: integer,
    startedAt: integer.optional(),
    resumePending: z.boolean().optional(),
    result: z
      .union([
        hostResult,
        z
          .object({
            status: z.literal("unavailable"),
            code: z.string().regex(/^browser_[a-z_]+$/),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type BrowserAccessRequest = z.infer<typeof browserAccessRequest>;
export const browserAccessState = z
  .object({
    grants: z.array(browserGrant).max(64),
    // Legacy task grants stay temporary; only a new website decision is remembered.
    sites: z.array(browserSite).max(32).default([]),
    requests: z.array(browserAccessRequest).max(256),
  })
  .strict();
export type BrowserAccessState = z.infer<typeof browserAccessState>;
export const emptyBrowserAccess = (): BrowserAccessState => ({
  grants: [],
  sites: [],
  requests: [],
});

export function browserSitePolicy(
  access: BrowserAccessState,
  configuration: number,
  epoch: number,
): BrowserHostPolicy {
  const sites = access.sites.filter(
    (site) => site.configuration === configuration && site.epoch === epoch,
  );
  return {
    origins: sites.map((site) => site.origin),
    previewOrigins: sites
      .filter((site) => site.preview)
      .map((site) => site.origin),
    routineOrigins: sites.map((site) => site.origin),
    interact: false,
  };
}

export function browserGrantPolicy(
  access: BrowserAccessState,
  controller: BrowserController,
  configuration: number,
  epoch: number,
  now = Date.now(),
): BrowserHostPolicy {
  const grant = access.grants.find(
    (grant) =>
      sameConsumer(grant.controller, controller) &&
      grant.configuration === configuration &&
      grant.epoch === epoch &&
      grant.expiresAt > now,
  );
  const sites = browserSitePolicy(access, configuration, epoch);
  return {
    origins: [...new Set([...sites.origins, ...(grant?.origins ?? [])])].slice(
      0,
      32,
    ),
    previewOrigins: [
      ...new Set([...sites.previewOrigins, ...(grant?.previewOrigins ?? [])]),
    ].slice(0, 8),
    routineOrigins: sites.origins,
    interact: false,
  };
}

export function requestBrowserAccess(
  access: BrowserAccessState,
  input: Pick<
    BrowserAccessRequest,
    "controller" | "configuration" | "epoch" | "operationId" | "kind"
  > &
    Partial<
      Pick<
        BrowserAccessRequest,
        "action" | "origin" | "preview" | "page" | "generation"
      >
    >,
  now = Date.now(),
) {
  const hash = fingerprint(input);
  const previous = access.requests.find(
    (request) =>
      sameController(request.controller, input.controller) &&
      request.operationId === input.operationId,
  );
  if (previous) {
    requireThat(previous.hash === hash, "browser_duplicate_conflict", 409);
    return structuredClone(previous);
  }
  access.requests = access.requests.filter(
    (request) =>
      !["completed", "cancelled", "expired", "denied"].includes(
        request.state,
      ) || request.expiresAt > now - 24 * 3600_000,
  );
  // Retain uncertain actions rather than silently making them replayable.
  requireThat(access.requests.length < 256, "browser_capacity", 409);
  const request = browserAccessRequest.parse({
    ...input,
    rememberSite: input.kind === "site",
    id: randomUUID(),
    hash,
    state: "waiting",
    expiresAt: now + browserLimits.requestMs,
  });
  requireThat(
    input.kind !== "site" || !!input.origin,
    "browser_destination_denied",
    403,
  );
  requireThat(
    input.kind !== "action" ||
      (!!input.action && !!input.page && input.generation !== undefined),
    "browser_page_changed",
    409,
  );
  access.requests.push(request);
  return structuredClone(request);
}

export function decideBrowserAccess(
  access: BrowserAccessState,
  id: string,
  approve: boolean,
  configuration: number,
  epoch: number,
  now = Date.now(),
) {
  const request = access.requests.find((request) => request.id === id);
  requireThat(request, "browser_request_unavailable", 404);
  requireThat(
    request.configuration === configuration && request.epoch === epoch,
    "browser_configuration_changed",
    409,
  );
  requireThat(request.expiresAt > now, "browser_request_expired", 410);
  if (request.state === (approve ? "approved" : "denied"))
    return structuredClone(request);
  requireThat(request.state === "waiting", "browser_request_unavailable", 409);
  request.state = approve ? "approved" : "denied";
  return structuredClone(request);
}

export function grantBrowserSite(
  access: BrowserAccessState,
  request: BrowserAccessRequest,
  now = Date.now(),
) {
  requireThat(
    request.kind === "site" &&
      (request.state === "applying" ||
        (request.rememberSite && request.state === "approved")) &&
      request.origin &&
      request.expiresAt > now,
    "browser_request_unavailable",
    409,
  );
  if (!request.rememberSite) {
    let grant = access.grants.find(
      (grant) =>
        sameConsumer(grant.controller, request.controller) &&
        grant.configuration === request.configuration &&
        grant.epoch === request.epoch &&
        grant.expiresAt > now,
    );
    if (!grant) {
      access.grants = access.grants.filter((grant) => grant.expiresAt > now);
      requireThat(access.grants.length < 64, "browser_capacity", 409);
      grant = {
        controller: request.controller,
        configuration: request.configuration,
        epoch: request.epoch,
        origins: [],
        previewOrigins: [],
        expiresAt: now + 30 * 60_000,
      };
      access.grants.push(grant);
    }
    if (!grant.origins.includes(request.origin))
      grant.origins.push(request.origin);
    if (request.preview && !grant.previewOrigins.includes(request.origin))
      grant.previewOrigins.push(request.origin);
    browserGrant.parse(grant);
    return;
  }
  access.sites = access.sites.filter(
    (site) =>
      site.configuration === request.configuration &&
      site.epoch === request.epoch,
  );
  if (access.sites.some((site) => site.origin === request.origin)) return;
  requireThat(access.sites.length < 32, "browser_capacity", 409);
  requireThat(
    !request.preview || access.sites.filter((site) => site.preview).length < 8,
    "browser_capacity",
    409,
  );
  access.sites.push(
    browserSite.parse({
      origin: request.origin,
      preview: request.preview,
      configuration: request.configuration,
      epoch: request.epoch,
      approvedAt: now,
    }),
  );
}

export const browserNeedsActionApproval = (action: BrowserAction) =>
  ["click", "fill", "press", "pointer"].includes(action.action);

export function invalidateBrowserAccess(
  access: BrowserAccessState,
  preserveSites = false,
) {
  access.grants = [];
  if (!preserveSites) access.sites = [];
  for (const request of access.requests)
    if (["waiting", "approved", "applying"].includes(request.state))
      request.state = request.state === "applying" ? "unknown" : "cancelled";
}
