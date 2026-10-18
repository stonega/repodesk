import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Admin,
  type Approval,
  Fault,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { decrypt, encrypt, fingerprint } from "../setup/credentials.ts";
import { audit, authorize, runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import {
  CloudflareClient,
  type CloudflareTransport,
  deployment,
  dnsRecord,
  pick,
  project,
  row,
} from "./client.ts";
import {
  cloudflareAction,
  cloudflareHasCredentials,
  cloudflareQuery,
  cloudflareSave,
  cloudflareTools,
  emptyCloudflare,
} from "./config.ts";
import { CloudflareOAuth, cloudflareClientSecretAAD } from "./oauth.ts";

const payloadSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    accountId: z.string(),
    zoneName: z.string(),
    request: cloudflareAction,
    before: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function authority(admin: Admin, w: Workspace) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
function scope(w: Workspace, runId: string, revision: number, write = false) {
  const run = w.runs.find((r) => r.id === runId);
  requireThat(run && runAllowed(w, run), "run_revoked", 403);
  authorize(w, run.actor, write);
  requireThat(
    run.chatId === run.actor && !run.workflowId,
    "cloudflare_private_request_required",
    403,
  );
  const config = w.plugins?.cloudflare;
  requireThat(
    config?.settings.enabled && cloudflareHasCredentials(config),
    "cloudflare_not_configured",
    409,
  );
  requireThat(
    w.plugins?.revision === revision,
    "extension_configuration_changed",
    409,
  );
  return { run, config };
}
function zoneScope(w: Workspace, zoneId: string) {
  requireThat(
    w.plugins?.cloudflare?.settings.zoneIds.includes(zoneId),
    "cloudflare_zone_denied",
    403,
  );
}
export function checkCloudflareApproval(w: Workspace, a: Approval) {
  requireThat(
    a.kind === "cloudflare_action" && fingerprint(a.payload) === a.hash,
    "approval_changed",
    409,
  );
  requireThat(Date.parse(a.expiresAt) > Date.now(), "approval_expired", 409);
  const payload = payloadSchema.parse(a.payload);
  const { run, config } = scope(w, a.runId ?? "", payload.revision, true);
  requireThat(
    a.actor === run.actor && config.settings.accountId === payload.accountId,
    "approval_stale",
    409,
  );
  zoneScope(w, payload.request.zoneId);
  return payload;
}

export class CloudflareService {
  private client: CloudflareClient;
  readonly oauth: CloudflareOAuth;
  constructor(
    private store: Store,
    private key: string,
    transport?: CloudflareTransport,
    origin = "http://localhost:3000",
  ) {
    this.client = new CloudflareClient(transport);
    this.oauth = new CloudflareOAuth(store, key, origin, transport);
  }
  private aad(id: string) {
    return `cloudflare:${id}`;
  }
  async view(admin: Admin, id: string) {
    const w = await this.store.read(id);
    authority(admin, w);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: structuredClone(
        w.plugins?.cloudflare?.settings ?? emptyCloudflare,
      ),
      tokenConfigured: !!w.plugins?.cloudflare?.credential,
      resources: structuredClone(w.plugins?.cloudflare?.resources),
      oauth: await this.oauth.view(w),
    };
  }
  async save(
    admin: Admin,
    id: string,
    value: unknown,
    fallback: PluginRecord[] = [],
  ) {
    operator(admin);
    const input = cloudflareSave.parse(value);
    const snapshot = await this.store.read(id);
    authority(admin, snapshot);
    requireThat(
      (snapshot.plugins?.revision ?? 0) === input.revision,
      "version_conflict",
      409,
    );
    const prior = snapshot.plugins?.cloudflare;
    const selecting =
      input.settings.authMethod === "oauth" &&
      prior?.oauth?.connection &&
      (input.settings.accountId !== prior.settings.accountId ||
        fingerprint(input.settings.zoneIds) !==
          fingerprint(prior.settings.zoneIds) ||
        !prior.resources?.account ||
        input.settings.zoneIds.some(
          (id) => !prior.resources?.zones.some((zone) => zone.id === id),
        ));
    const resources = selecting
      ? await this.oauth.selectResources(
          admin,
          id,
          input.revision,
          input.settings.accountId,
          input.settings.zoneIds,
        )
      : prior?.resources?.account?.id === input.settings.accountId
        ? {
            account: prior.resources.account,
            zones: prior.resources.zones.filter((zone) =>
              input.settings.zoneIds.includes(zone.id),
            ),
          }
        : undefined;
    await this.store.change(id, (w) => {
      authority(admin, w);
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      requireThat(this.key, "cloudflare_credentials_unavailable", 503);
      const credential = input.removeToken
        ? undefined
        : input.apiToken
          ? encrypt(this.key, this.aad(id), input.apiToken)
          : w.plugins?.cloudflare?.credential;
      let oauth = structuredClone(w.plugins?.cloudflare?.oauth);
      requireThat(
        !oauth?.connection || input.settings.authMethod === "oauth",
        "cloudflare_disconnect_before_client_change",
        409,
      );
      if (input.oauthClient) {
        const client = input.oauthClient;
        const sameClient = oauth?.clientId === client.clientId;
        requireThat(
          client.clientSecret || (sameClient && oauth?.clientSecret),
          "cloudflare_oauth_client_required",
          409,
        );
        const unchanged =
          sameClient &&
          fingerprint(oauth?.scopes) === fingerprint(client.scopes);
        requireThat(
          !oauth?.connection || unchanged,
          "cloudflare_disconnect_before_client_change",
          409,
        );
        oauth = {
          clientId: client.clientId,
          scopes: client.scopes,
          clientSecret: client.clientSecret
            ? encrypt(
                this.key,
                cloudflareClientSecretAAD(id, client.clientId),
                client.clientSecret,
              )
            : (oauth?.clientSecret as string),
          connection: unchanged ? oauth?.connection : undefined,
        };
      }
      if (oauth) delete oauth.flow;
      requireThat(
        !input.settings.enabled ||
          (input.settings.accountId &&
            cloudflareHasCredentials({
              settings: input.settings,
              credential,
              oauth,
            })),
        "cloudflare_token_and_account_required",
        409,
      );
      if (input.settings.enabled)
        requireThat(
          !(w.plugins?.entries ?? fallback).some(
            (e) =>
              e.enabled &&
              e.tools.some((t) =>
                (cloudflareTools as readonly string[]).includes(t),
              ),
          ),
          "extension_tool_collision",
          409,
        );
      w.plugins = {
        entries: fallback,
        ...w.plugins,
        revision: input.revision + 1,
        cloudflare: { settings: input.settings, credential, oauth, resources },
      };
      audit(w, admin.id, "plugins.updated", "cloudflare", w.plugins.revision);
    });
    return this.view(admin, id);
  }
  private async authorized(
    id: string,
    runId: string,
    revision: number,
    write = false,
  ) {
    const w = await this.store.read(id);
    const current = scope(w, runId, revision, write);
    const d = await this.store.deployment();
    requireThat(d.active && !d.paused, "deployment_paused", 409);
    return { ...current, w };
  }
  private async access(
    id: string,
    runId: string,
    revision: number,
    write = false,
  ) {
    const current = await this.authorized(id, runId, revision, write);
    return {
      ...current,
      token:
        current.config.settings.authMethod === "oauth"
          ? await this.oauth.accessToken(id, revision)
          : decrypt(
              this.key,
              this.aad(id),
              current.config.credential as string,
            ),
    };
  }
  private async recordRead(id: string, runId: string, revision: number) {
    await this.store.change(id, (w) => {
      const { run, config } = scope(w, runId, revision);
      run.cloudflareRead = { revision, accountId: config.settings.accountId };
    });
  }
  private async zone(
    id: string,
    runId: string,
    revision: number,
    zoneId: string,
    signal?: AbortSignal,
  ) {
    const access = await this.access(id, runId, revision);
    zoneScope(access.w, zoneId);
    const response = await this.client.request(
      access.token,
      `/zones/${zoneId}`,
      {
        signal,
        guard: async () => {
          await this.authorized(id, runId, revision);
        },
      },
    );
    const zone = row(response.result);
    requireThat(
      zone.id === zoneId &&
        row(zone.account).id === access.config.settings.accountId &&
        typeof zone.name === "string",
      "cloudflare_zone_denied",
      403,
    );
    return zone;
  }
  async query(
    id: string,
    runId: string,
    revision: number,
    value: unknown,
    signal?: AbortSignal,
    guard = async () => {},
  ) {
    const input = cloudflareQuery.parse(value);
    await guard();
    await this.recordRead(id, runId, revision);
    const access = await this.authorized(id, runId, revision);
    if (input.resource === "zones") {
      const zones = [];
      for (const zoneId of access.config.settings.zoneIds) {
        signal?.throwIfAborted();
        await guard();
        zones.push(
          pick(await this.zone(id, runId, revision, zoneId, signal), [
            "id",
            "name",
            "status",
            "name_servers",
          ]),
        );
      }
      await guard();
      await this.authorized(id, runId, revision);
      return { resource: input.resource, result: zones, complete: true };
    }
    if (input.zoneId)
      await this.zone(id, runId, revision, input.zoneId, signal);
    const path = input.zoneId
      ? `/zones/${input.zoneId}/dns_records`
      : `/accounts/${access.config.settings.accountId}/pages/projects${input.projectName ? `/${input.projectName}/deployments` : ""}`;
    const currentAccess = await this.access(id, runId, revision);
    const result = await this.client.request(
      currentAccess.token,
      `${path}?page=${input.page}&per_page=20`,
      {
        signal,
        guard: async () => {
          await guard();
          await this.authorized(id, runId, revision);
        },
      },
    );
    requireThat(
      Array.isArray(result.result) && result.result.length <= 20,
      "cloudflare_response_too_large",
      409,
    );
    const items = result.result.map(
      input.resource === "dns_records"
        ? dnsRecord
        : input.resource === "pages_projects"
          ? project
          : deployment,
    );
    const output = {
      resource: input.resource,
      result: items,
      result_info: result.result_info,
      guidance:
        "One page only. Use the next page to retrieve more; missing pagination metadata does not establish completeness.",
    };
    requireThat(
      Buffer.byteLength(JSON.stringify(output)) <= 24000,
      "cloudflare_response_too_large",
      409,
    );
    return output;
  }
  async propose(
    id: string,
    runId: string,
    actor: string,
    callId: string,
    revision: number,
    value: unknown,
    signal?: AbortSignal,
    guard = async () => {},
  ) {
    const request = cloudflareAction.parse(value);
    await guard();
    await this.authorized(id, runId, revision, true);
    await this.recordRead(id, runId, revision);
    const zone = await this.zone(id, runId, revision, request.zoneId, signal);
    const zoneName = String(zone.name).toLowerCase();
    const underZone = (name: string) =>
      name.toLowerCase() === zoneName ||
      name.toLowerCase().endsWith(`.${zoneName}`);
    if ("record" in request)
      requireThat(
        underZone(request.record.name),
        "cloudflare_zone_denied",
        403,
      );
    if (request.action === "purge_cache" && request.files)
      requireThat(
        request.files.every((s) => {
          const url = new URL(s);
          return !url.username && !url.password && underZone(url.hostname);
        }),
        "cloudflare_zone_denied",
        403,
      );
    let before: Record<string, unknown> | undefined;
    if ("recordId" in request) {
      const access = await this.access(id, runId, revision, true);
      const response = await this.client.request(
        access.token,
        `/zones/${request.zoneId}/dns_records/${request.recordId}`,
        {
          signal,
          guard: async () => {
            await guard();
            await this.authorized(id, runId, revision, true);
          },
        },
      );
      before = dnsRecord(response.result);
      requireThat(
        before.id === request.recordId &&
          typeof before.name === "string" &&
          underZone(before.name),
        "cloudflare_zone_denied",
        403,
      );
    }
    signal?.throwIfAborted();
    await guard();
    return this.store.change(id, (w) => {
      signal?.throwIfAborted();
      const { run } = scope(w, runId, revision, true);
      requireThat(
        run.actor === actor && run.status === "running",
        "tool_policy_denied",
        403,
      );
      const target = `${run.id}:${callId}`;
      const payload = {
        revision,
        accountId: w.plugins?.cloudflare?.settings.accountId,
        zoneName,
        request,
        before,
      };
      const prior = w.approvals.find(
        (a) => a.kind === "cloudflare_action" && a.target === target,
      );
      if (prior) {
        requireThat(
          prior.actor === actor && prior.hash === fingerprint(payload),
          "approval_changed",
          409,
        );
        return { status: "awaiting_approval", approvalId: prior.id };
      }
      requireThat(
        !w.approvals.some(
          (a) =>
            a.actor === actor &&
            !a.decision &&
            Date.parse(a.expiresAt) > Date.now(),
        ),
        "resolve_existing_proposal_first",
        409,
      );
      const approval: Approval = {
        id: randomUUID(),
        actor,
        kind: "cloudflare_action",
        runId,
        target,
        version: revision,
        payload,
        hash: fingerprint(payload),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
      const preview = `Cloudflare: ${request.action}\nZone: ${zoneName} (${request.zoneId})\n\n${JSON.stringify(request, null, 2)}${before ? `\n\nCurrent record:\n${JSON.stringify(before, null, 2)}` : ""}\n\nApprove this exact Cloudflare change?`;
      requireThat(preview.length <= 3800, "cloudflare_preview_too_large", 409);
      w.approvals.push(approval);
      audit(w, actor, "cloudflare.proposed", approval.id);
      deliver(w, actor, run.chatId, preview, {
        runId,
        topicId: run.topicId,
        id: `cloudflare:${approval.id}:review`,
        buttons: [
          [
            { text: "Approve", callback_data: `approve:${approval.id}` },
            { text: "Reject", callback_data: `reject:${approval.id}` },
          ],
        ],
      });
      return { status: "awaiting_approval", approvalId: approval.id };
    });
  }
  async send(id: string, approvalId: string) {
    const w = await this.store.read(id);
    const candidate = w.approvals.find((a) => a.id === approvalId);
    if (
      candidate?.kind !== "cloudflare_action" ||
      candidate.decision !== "approved"
    )
      return;
    if (candidate.cloudflare) {
      if (
        candidate.cloudflare.state === "sending" &&
        Date.parse(candidate.cloudflare.startedAt) + 60000 < Date.now()
      )
        await this.finish(
          id,
          approvalId,
          "unknown",
          "cloudflare_outcome_unknown",
        );
      return;
    }
    let payload: z.infer<typeof payloadSchema>;
    try {
      payload = checkCloudflareApproval(w, candidate);
      const zone = await this.zone(
        id,
        candidate.runId ?? "",
        payload.revision,
        payload.request.zoneId,
      );
      requireThat(zone.name === payload.zoneName, "approval_stale", 409);
      if ("recordId" in payload.request) {
        const access = await this.access(
          id,
          candidate.runId ?? "",
          payload.revision,
          true,
        );
        const response = await this.client.request(
          access.token,
          `/zones/${payload.request.zoneId}/dns_records/${payload.request.recordId}`,
          {
            guard: async () => {
              await this.authorized(
                id,
                candidate.runId ?? "",
                payload.revision,
                true,
              );
            },
          },
        );
        requireThat(
          fingerprint(dnsRecord(response.result)) ===
            fingerprint(payload.before),
          "cloudflare_record_changed",
          409,
        );
      }
    } catch (error) {
      await this.finish(
        id,
        approvalId,
        "failed",
        error instanceof Fault ? error.code : "cloudflare_request_failed",
        false,
      );
      return;
    }
    const reserved = await this.store.change(id, async (current) => {
      const a = current.approvals.find((a) => a.id === approvalId);
      if (a?.decision !== "approved" || a.cloudflare) return;
      try {
        checkCloudflareApproval(current, a);
        const d = await this.store.deployment();
        requireThat(d.active && !d.paused, "deployment_paused", 409);
        a.cloudflare = {
          state: "sending",
          startedAt: new Date().toISOString(),
        };
        audit(current, a.actor, "cloudflare.sending", a.id);
        return true;
      } catch (error) {
        a.cloudflare = {
          state: "failed",
          startedAt: new Date().toISOString(),
          error:
            error instanceof Fault ? error.code : "cloudflare_request_failed",
        };
        this.notify(current, a);
      }
    });
    if (!reserved) return;
    const request = payload.request;
    const base = `/zones/${request.zoneId}`;
    const path =
      request.action === "purge_cache"
        ? `${base}/purge_cache`
        : `${base}/dns_records${"recordId" in request ? `/${request.recordId}` : ""}`;
    try {
      const access = await this.access(
        id,
        candidate.runId ?? "",
        payload.revision,
        true,
      );
      await this.client.request(access.token, path, {
        method:
          request.action === "delete_dns_record"
            ? "DELETE"
            : request.action === "update_dns_record"
              ? "PATCH"
              : "POST",
        body:
          "record" in request
            ? request.record
            : request.action === "purge_cache"
              ? request.purgeEverything
                ? { purge_everything: true }
                : { files: request.files }
              : undefined,
        guard: async () => {
          const current = await this.store.read(id);
          const a = current.approvals.find((a) => a.id === approvalId);
          requireThat(a?.decision === "approved", "approval_stale", 409);
          checkCloudflareApproval(current, a);
          await this.authorized(
            id,
            candidate.runId ?? "",
            payload.revision,
            true,
          );
        },
      });
      await this.finish(id, approvalId, "completed");
    } catch (error) {
      const code =
        error instanceof Fault ? error.code : "cloudflare_outcome_unknown";
      await this.finish(
        id,
        approvalId,
        code === "cloudflare_outcome_unknown" ? "unknown" : "failed",
        code,
      );
    }
  }
  private async finish(
    id: string,
    approvalId: string,
    state: "completed" | "failed" | "unknown",
    error?: string,
    reserved = true,
  ) {
    await this.store.change(id, (w) => {
      const a = w.approvals.find((a) => a.id === approvalId);
      if (
        !a ||
        (!reserved && a.cloudflare) ||
        (a.cloudflare && a.cloudflare.state !== "sending")
      )
        return;
      a.cloudflare = {
        state,
        startedAt: a.cloudflare?.startedAt ?? new Date().toISOString(),
        error,
      };
      this.notify(w, a);
    });
  }
  private notify(w: Workspace, a: Approval) {
    audit(w, a.actor, `cloudflare.${a.cloudflare?.state}`, a.id);
    const run: Run | undefined = w.runs.find((r) => r.id === a.runId);
    if (!run || !runAllowed(w, run)) return;
    const text =
      a.cloudflare?.state === "completed"
        ? "Approved Cloudflare action completed."
        : a.cloudflare?.state === "unknown"
          ? "Cloudflare action outcome is unknown. Check Cloudflare before proposing it again; this request will not be retried."
          : `Cloudflare action was not completed (${a.cloudflare?.error}). Review the token permissions and saved scope before proposing again.`;
    deliver(w, a.actor, run.chatId, text, {
      runId: run.id,
      topicId: run.topicId,
      id: `cloudflare:${a.id}:result`,
    });
  }
}
