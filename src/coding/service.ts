import { randomUUID } from "node:crypto";
import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { githubAccessPending } from "../github/user-access.ts";
import { ModelProviders } from "../models/service.ts";
import { decrypt, encrypt } from "../setup/credentials.ts";
import { clearProgress, recordProgress } from "../telegram/feedback.ts";
import { membersWithProfiles } from "../workspaces/member-profile.ts";
import { audit, eligible } from "../workspaces/policy.ts";
import {
  type CodingPage,
  type CodingTask,
  codingSaveSchema,
  codingTerminal,
  emptyCoding,
} from "./config.ts";
import { DevelopmentExecutor } from "./executor.ts";
import { markRunnerUnavailable, runnerStage } from "./feedback.ts";
import type { LocalDeviceAuth, LocalRunner } from "./local/protocol.ts";
import { checkCodingTask, notifyCoding } from "./policy.ts";

function operatorWorkspace(w: Workspace, admin: Admin) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function codingView(w: Workspace, admin: Admin): CodingPage {
  operatorWorkspace(w, admin);
  const settings = w.coding?.settings ?? emptyCoding;
  return {
    providerApiKeyConfigured: !!w.coding?.providerApiKey,
    legacyActionsConfiguration: !!w.coding && settings.backend !== "podman",
    revision: w.coding?.revision ?? 0,
    settings: {
      enabled: settings.enabled,
      backend: "podman",
      authMode: settings.authMode ?? "provider_key",
      model: settings.model,
      repositories: settings.repositories.map((target) => ({
        repositoryId: target.repositoryId,
        baseBranch: target.baseBranch,
        maintainers: [...target.maintainers],
        development: target.development,
      })),
    },
    repositories: w.github?.installationId ? w.github.repositories : [],
    members: membersWithProfiles(w)
      .filter((m) => eligible(w, m.id))
      .map(({ id, active, username }) => ({ id, active, username })),
    tasks: [...(w.codingTasks ?? [])].reverse(),
  };
}
export function saveCoding(
  w: Workspace,
  admin: Admin,
  value: unknown,
  encryptionKey?: string,
) {
  operatorWorkspace(w, admin);
  const input = codingSaveSchema.parse(value);
  requireThat(
    input.revision === (w.coding?.revision ?? 0),
    "version_conflict",
    409,
  );
  for (const target of input.settings.enabled
    ? input.settings.repositories
    : []) {
    requireThat(
      w.github?.installationId &&
        w.github.repositories.some((r) => r.id === target.repositoryId),
      "github_repository_not_connected",
      409,
    );
    requireThat(
      target.maintainers.every((id) => eligible(w, id)),
      "coding_maintainer_inactive",
      409,
    );
  }
  if (input.settings.model)
    requireThat(
      input.providerApiKey === undefined,
      "provider_credentials_managed_centrally",
    );
  let providerApiKey = input.settings.model
    ? undefined
    : w.coding?.providerApiKey;
  if (input.providerApiKey === null) providerApiKey = undefined;
  else if (input.providerApiKey !== undefined) {
    requireThat(encryptionKey, "coding_credentials_unavailable", 503);
    providerApiKey = encrypt(
      encryptionKey,
      `coding-provider:${w.id}`,
      input.providerApiKey,
    );
  }
  w.coding = {
    revision: input.revision + 1,
    settings: input.settings,
    providerApiKey,
  };
  audit(w, admin.id, "coding.settings_updated", w.id, w.coding.revision);
  return codingView(w, admin);
}
const code = (error: unknown) =>
  error instanceof Fault ? error.code : "coding_failed";

/** Every irreversible operation has a committed reservation; none is replayed. */
export class CodingService {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private local?: LocalRunner,
    private encryptionKey?: string,
  ) {}
  async purgeDeletedWorkspaceAuth(workspaceId: string) {
    const w = await this.store.read(workspaceId);
    requireThat(w.deletion, "deletion_not_requested", 409);
    const device = this.local as
      | (LocalRunner & Partial<LocalDeviceAuth>)
      | undefined;
    if (!device?.deviceLogout) return false;
    await device.deviceLogout(workspaceId);
    return true;
  }
  async tick(workspaceId: string) {
    await new DevelopmentExecutor(
      this.store,
      this.apps,
      this.local,
      this.encryptionKey,
    ).tick(workspaceId);
    const w = await this.store.read(workspaceId);
    for (const task of w.codingTasks ?? []) {
      if (
        codingTerminal(task.state) ||
        Date.parse(task.nextPollAt ?? "1970-01-01") > Date.now()
      )
        continue;
      await this.advance(workspaceId, task.id);
    }
  }
  async advance(workspaceId: string, id: string) {
    const lease = randomUUID();
    const task = await this.store.change(workspaceId, async (w, sql) => {
      const t = w.codingTasks?.find((t) => t.id === id);
      if (
        !t ||
        codingTerminal(t.state) ||
        Date.parse(t.nextPollAt ?? "1970-01-01") > Date.now()
      )
        return;
      if (t.cancelRequested && t.error === "github_user_access_unavailable")
        t.error = undefined;
      if (t.payload.backend !== "podman") {
        t.state = ["queued", "issue_created"].includes(t.state)
          ? "cancelled"
          : "unknown";
        t.error = "coding_legacy_backend_disabled";
        t.updatedAt = new Date().toISOString();
        notifyCoding(w, t);
        return;
      }
      // No worker may resume an interrupted POST, even if it died before sending it.
      if (
        ["creating_issue", "dispatching", "starting_publication"].includes(
          t.state,
        )
      ) {
        if (Date.parse(t.updatedAt) + 120000 < Date.now()) {
          t.state = "unknown";
          t.error = "coding_outcome_unknown";
          notifyCoding(w, t);
        }
        return;
      }
      const d = await this.store.deployment(sql);
      try {
        checkCodingTask(w, t);
        requireThat(d.active && !d.paused, "deployment_paused", 409);
      } catch (error) {
        if (githubAccessPending(error) && !t.cancelRequested) {
          t.error = "github_user_access_unavailable";
          t.nextPollAt = new Date(Date.now() + 30000).toISOString();
          return;
        }
        if (
          t.state === "running" ||
          t.state === "publishing" ||
          (t.state === "auth_required" && t.authResumeState === "running")
        ) {
          t.cancelRequested = true;
          t.error = code(error);
        } else {
          t.state = "cancelled";
          t.error = code(error);
          notifyCoding(w, t);
          return;
        }
      }
      if (t.error === "github_user_access_unavailable") t.error = undefined;
      t.lease = lease;
      t.nextPollAt = new Date(Date.now() + 120000).toISOString();
      return structuredClone(t);
    });
    if (!task) return;
    let externalWriteCompleted = false;
    try {
      requireThat(this.local, "coding_runner_not_configured", 409);
      if (
        task.state === "auth_required" &&
        task.authResumeState !== "running"
      ) {
        const device = this.local as LocalRunner & Partial<LocalDeviceAuth>;
        requireThat(device.deviceStatus, "coding_runner_not_configured", 409);
        if ((await device.deviceStatus(workspaceId)).state === "connected") {
          await this.store.change(workspaceId, async (w, sql) => {
            const t = w.codingTasks?.find((t) => t.id === id);
            if (!t || t.lease !== lease) return;
            checkCodingTask(w, t);
            const d = await this.store.deployment(sql);
            requireThat(d.active && !d.paused, "deployment_paused", 409);
          });
          await this.update(workspaceId, id, lease, {
            state: task.authResumeState ?? "queued",
            error: undefined,
            authWaitMs: this.authWait(task),
            authPausedAt: undefined,
          });
        } else await this.update(workspaceId, id, lease, {});
        return;
      }
      if (task.state === "queued" && task.payload.authMode === "device_code") {
        const device = this.local as LocalRunner & Partial<LocalDeviceAuth>;
        requireThat(device.deviceStatus, "coding_runner_not_configured", 409);
        const status = await device.deviceStatus(workspaceId);
        requireThat(
          status.state === "connected",
          "coding_device_auth_required",
          409,
        );
      }
      if (task.state !== "queued") {
        await this.advanceLocal(workspaceId, task, lease);
        return;
      }
      const snapshot = await this.store.read(workspaceId);
      const app = await this.apps.get(snapshot.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      const token = (
        await app.installationToken(
          task.payload.installationId,
          [task.payload.repositoryId],
          "issues",
        )
      ).token;
      // Authority can change during token minting. Reserve under the workspace lock.
      const reserved = await this.store.change(workspaceId, async (w, sql) => {
        const t = w.codingTasks?.find((t) => t.id === id);
        if (!t || t.lease !== lease || t.state !== "queued") return false;
        checkCodingTask(w, t);
        const d = await this.store.deployment(sql);
        requireThat(d.active && !d.paused, "deployment_paused", 409);
        t.state = "creating_issue";
        t.updatedAt = new Date().toISOString();
        return true;
      });
      if (!reserved) return;
      const issue = await app.createIssue(
        token,
        task.payload.repository,
        task.payload.title,
        task.payload.body,
      );
      externalWriteCompleted = true;
      await this.update(workspaceId, id, lease, {
        issue,
        state: "issue_created",
      });
    } catch (error) {
      const reason = code(error);
      const snapshot = await this.store.read(workspaceId);
      const current = snapshot.codingTasks?.find((t) => t.id === id);
      if (!current || current.lease !== lease) return;
      if (
        reason === "github_user_access_unavailable" &&
        !current.cancelRequested &&
        !["creating_issue", "dispatching", "starting_publication"].includes(
          current.state,
        )
      ) {
        await this.update(workspaceId, id, lease, { error: reason });
        return;
      }
      if (
        reason === "coding_device_auth_required" &&
        task.payload.authMode === "device_code" &&
        ["queued", "issue_created", "dispatching"].includes(current.state)
      ) {
        await this.pauseAuth(
          workspaceId,
          current,
          lease,
          current.state === "queued" ? "queued" : "issue_created",
        );
        return;
      }
      if (
        current.state === "auth_required" &&
        [
          "coding_runner_busy",
          "coding_runner_unavailable",
          "coding_outcome_unknown",
        ].includes(reason)
      ) {
        await this.update(workspaceId, id, lease, {
          progress: current.progress
            ? { ...current.progress, unavailable: true }
            : undefined,
        });
        return;
      }
      // Read failures can retry for up to two hours. Writes remain unknown forever.
      if (
        ["running", "publishing"].includes(current.state) &&
        ["github_unavailable", "coding_runner_unavailable"].includes(reason) &&
        Date.parse(current.createdAt) + 7200000 > Date.now()
      ) {
        markRunnerUnavailable(current);
        await this.update(workspaceId, id, lease, {
          progress: current.progress,
        });
        return;
      }
      const uncertain =
        externalWriteCompleted ||
        ["github_issue_outcome_unknown"].includes(reason) ||
        ["running", "publishing", "starting_publication"].includes(
          current.state,
        );
      await this.update(workspaceId, id, lease, {
        state: uncertain ? "unknown" : "failed",
        error: reason,
      });
    }
  }
  private async advanceLocal(
    workspaceId: string,
    task: CodingTask,
    lease: string,
  ) {
    const runner = this.local;
    requireThat(runner, "coding_runner_not_configured", 409);
    if (task.state === "issue_created") {
      const w = await this.store.read(workspaceId);
      let providerApiKey: string | undefined;
      if (w.coding?.providerApiKey) {
        requireThat(this.encryptionKey, "coding_credentials_unavailable", 503);
        providerApiKey = decrypt(
          this.encryptionKey,
          `coding-provider:${workspaceId}`,
          w.coding.providerApiKey,
        );
      }
      const sharedProvider =
        task.payload.authMode === "provider_key"
          ? await new ModelProviders(
              this.store,
              this.encryptionKey ?? "",
            ).runner(w, w.coding?.settings.model, task.runnerModel)
          : {};
      if (sharedProvider.modelProvider)
        await this.update(
          workspaceId,
          task.id,
          lease,
          { runnerModel: sharedProvider.modelProvider },
          false,
        );
      const token = await this.localToken(workspaceId, task, "contents");
      const reserved = await this.reserveLocal(
        workspaceId,
        task.id,
        lease,
        "dispatching",
      );
      if (!reserved) return;
      requireThat(task.issue, "coding_issue_missing", 409);
      try {
        await runner.start({
          workspaceId,
          taskId: task.id,
          payload: task.payload,
          issue: task.issue,
          readToken: token,
          providerApiKey,
          ...sharedProvider,
        });
      } catch (error) {
        if (error instanceof Fault && error.code === "coding_runner_busy") {
          await this.update(workspaceId, task.id, lease, {
            state: "issue_created",
          });
          return;
        }
        throw error;
      }
      await this.update(workspaceId, task.id, lease, { state: "running" });
      return;
    }
    const result = await runner.status(workspaceId, task.id);
    const current = await this.store.read(workspaceId);
    const latest = current.codingTasks?.find((t) => t.id === task.id);
    if (!latest || latest.lease !== lease) return;
    const d = await this.store.deployment();
    let cancelled = false;
    try {
      checkCodingTask(current, latest);
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      requireThat(
        Date.parse(task.createdAt) + this.authWait(task) + 7200000 > Date.now(),
        "coding_task_timeout",
      );
    } catch (error) {
      if (githubAccessPending(error) && !latest.cancelRequested) throw error;
      cancelled = true;
    }
    if (
      cancelled &&
      !["succeeded", "failed", "cancelled", "unknown"].includes(result.state)
    ) {
      await runner.cancel(workspaceId, task.id);
      await this.update(workspaceId, task.id, lease, {
        state: task.state === "publishing" ? "unknown" : "cancelled",
        cancelRequested: true,
      });
      return;
    }
    if (result.state === "auth_required") {
      requireThat(
        task.payload.authMode === "device_code" && task.state !== "publishing",
        "coding_result_invalid",
        409,
      );
      if (task.state !== "auth_required") {
        await this.pauseAuth(workspaceId, task, lease, "running");
      } else {
        const device = runner as LocalRunner & Partial<LocalDeviceAuth>;
        requireThat(device.deviceStatus, "coding_runner_not_configured", 409);
        if ((await device.deviceStatus(workspaceId)).state === "connected") {
          requireThat(runner.resumeAuth, "coding_runner_not_configured", 409);
          await this.localToken(workspaceId, task, "contents");
          await this.store.change(workspaceId, async (w, sql) => {
            const t = w.codingTasks?.find((t) => t.id === task.id);
            if (!t || t.lease !== lease)
              throw new Fault("coding_cancelled", 409);
            checkCodingTask(w, t);
            const deployment = await this.store.deployment(sql);
            requireThat(
              deployment.active && !deployment.paused,
              "deployment_paused",
              409,
            );
          });
          await runner.resumeAuth(workspaceId, task.id);
          await this.update(workspaceId, task.id, lease, {
            state: "running",
            error: undefined,
            authPausedAt: undefined,
            authWaitMs: this.authWait(task),
          });
        } else await this.update(workspaceId, task.id, lease, {});
      }
      return;
    }
    if (task.state === "auth_required")
      await this.update(
        workspaceId,
        task.id,
        lease,
        {
          state: "running",
          error: undefined,
          authPausedAt: undefined,
          authWaitMs: this.authWait(task),
        },
        false,
      );
    if (result.state === "ready") {
      const token = await this.localToken(workspaceId, task, "publish");
      try {
        if (
          !(await this.reserveLocal(
            workspaceId,
            task.id,
            lease,
            "starting_publication",
          ))
        )
          return;
      } catch (error) {
        // No publication request has been made. Revoke the prepared local work
        // immediately if authority changed while minting the token.
        if (!(error instanceof Fault)) throw error;
        await runner.cancel(workspaceId, task.id);
        await this.update(workspaceId, task.id, lease, {
          state: "cancelled",
          error: error.code,
        });
        return;
      }
      await runner.publish(workspaceId, task.id, token);
      await this.update(workspaceId, task.id, lease, {
        state: "publishing",
        threadId: result.threadId,
      });
    } else if (result.state === "succeeded") {
      requireThat(
        result.prUrl &&
          new RegExp(
            `^https://github\\.com/${task.payload.repository.replaceAll(".", "\\.")}/pull/[1-9][0-9]*$`,
          ).test(result.prUrl),
        "coding_pr_missing",
      );
      await this.update(workspaceId, task.id, lease, {
        state: "succeeded",
        prUrl: result.prUrl,
        threadId: result.threadId,
      });
    } else if (["failed", "cancelled", "unknown"].includes(result.state)) {
      await this.update(workspaceId, task.id, lease, {
        state: result.state as "failed" | "cancelled" | "unknown",
        error: result.error,
        threadId: result.threadId,
      });
    } else {
      await this.store.change(workspaceId, (w) => {
        const t = w.codingTasks?.find((t) => t.id === task.id);
        if (!t || t.lease !== lease || t.cancelRequested) return;
        checkCodingTask(w, t);
        recordProgress(
          w,
          t,
          "coding",
          runnerStage(result),
          `${t.createdAt}:${result.repairCount ?? 0}`,
        );
      });
      await this.update(workspaceId, task.id, lease, {
        threadId: result.threadId,
      });
    }
  }
  private authWait(task: CodingTask) {
    return (
      (task.authWaitMs ?? 0) +
      (task.authPausedAt
        ? Math.max(0, Date.now() - Date.parse(task.authPausedAt))
        : 0)
    );
  }
  private async pauseAuth(
    workspaceId: string,
    task: CodingTask,
    lease: string,
    resumeState: "queued" | "issue_created" | "running",
  ) {
    await this.update(workspaceId, task.id, lease, {
      state: "auth_required",
      error: "coding_device_auth_required",
      authResumeState: resumeState,
      authPausedAt: new Date().toISOString(),
      authPauses: (task.authPauses ?? 0) + 1,
    });
  }
  private async localToken(
    workspaceId: string,
    task: CodingTask,
    permission: "contents" | "publish",
  ) {
    const w = await this.store.read(workspaceId);
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const token = (
      await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        permission,
      )
    ).token;
    return token;
  }
  private async reserveLocal(
    workspaceId: string,
    id: string,
    lease: string,
    state: "dispatching" | "starting_publication",
  ) {
    return this.store.change(workspaceId, async (w, sql) => {
      const task = w.codingTasks?.find((t) => t.id === id);
      if (!task || task.lease !== lease) return false;
      checkCodingTask(w, task);
      const d = await this.store.deployment(sql);
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      task.state = state;
      if (state === "starting_publication")
        recordProgress(w, task, "coding", "publish", task.createdAt);
      task.updatedAt = new Date().toISOString();
      return true;
    });
  }
  private async update(
    workspaceId: string,
    id: string,
    lease: string,
    patch: Partial<CodingTask>,
    release = true,
  ) {
    return this.store.change(workspaceId, (w) => {
      const task = w.codingTasks?.find((t) => t.id === id);
      if (!task || task.lease !== lease || codingTerminal(task.state)) return;
      const changed = patch.state && patch.state !== task.state;
      Object.assign(task, patch);
      if (task.progress?.unavailable) clearProgress(w, "coding", task.id);
      if (!["running", "publishing"].includes(task.state))
        clearProgress(w, "coding", task.id);
      if (changed) {
        task.updatedAt = new Date().toISOString();
        audit(w, task.actor, `coding.${task.state}`, task.id);
      }
      if (changed) notifyCoding(w, task);
      if (release) {
        task.lease = undefined;
        task.nextPollAt = new Date(Date.now() + 15000).toISOString();
      }
      return true;
    });
  }
}
