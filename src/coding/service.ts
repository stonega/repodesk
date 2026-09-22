import { randomUUID } from "node:crypto";
import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { audit, eligible } from "../workspaces/policy.ts";
import {
  type CodingPage,
  type CodingTask,
  codingSaveSchema,
  codingTerminal,
  emptyCoding,
} from "./config.ts";
import { CodingGitHub } from "./github.ts";
import { checkCodingTask, notifyCoding } from "./policy.ts";

function operatorWorkspace(w: Workspace, admin: Admin) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function codingView(w: Workspace, admin: Admin): CodingPage {
  operatorWorkspace(w, admin);
  return {
    revision: w.coding?.revision ?? 0,
    settings: structuredClone(w.coding?.settings ?? emptyCoding),
    repositories: w.github?.installationId ? w.github.repositories : [],
    members: w.members
      .filter((m) => eligible(w, m.id))
      .map(({ id, active }) => ({ id, active })),
    tasks: [...(w.codingTasks ?? [])].reverse(),
  };
}
export function saveCoding(w: Workspace, admin: Admin, value: unknown) {
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
  w.coding = { revision: input.revision + 1, settings: input.settings };
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
    private github = new CodingGitHub(),
  ) {}
  async tick(workspaceId: string) {
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
      // No worker may resume an interrupted POST, even if it died before sending it.
      if (["creating_issue", "dispatching"].includes(t.state)) {
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
        if (t.state === "running") {
          t.cancelRequested = true;
          t.error = code(error);
        } else {
          t.state = "cancelled";
          t.error = code(error);
          notifyCoding(w, t);
          return;
        }
      }
      t.lease = lease;
      t.nextPollAt = new Date(Date.now() + 120000).toISOString();
      return structuredClone(t);
    });
    if (!task) return;
    let externalWriteCompleted = false;
    try {
      const snapshot = await this.store.read(workspaceId);
      const app = await this.apps.get(snapshot.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      const token = (
        await app.installationToken(
          task.payload.installationId,
          [task.payload.repositoryId],
          task.state === "queued" ? "issues" : "coding",
        )
      ).token;
      if (task.state === "queued" || task.state === "issue_created") {
        // Authority can change during token minting. Reserve under the workspace lock.
        const reserved = await this.store.change(
          workspaceId,
          async (w, sql) => {
            const t = w.codingTasks?.find((t) => t.id === id);
            if (!t || t.lease !== lease || t.state !== task.state) return;
            checkCodingTask(w, t);
            const d = await this.store.deployment(sql);
            requireThat(d.active && !d.paused, "deployment_paused", 409);
            t.state =
              task.state === "queued" ? "creating_issue" : "dispatching";
            t.updatedAt = new Date().toISOString();
            return structuredClone(t);
          },
        );
        if (!reserved) return;
        if (reserved.state === "creating_issue") {
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
        } else {
          const workflowRunId = await this.github.dispatch(token, reserved);
          externalWriteCompleted = true;
          await this.update(workspaceId, id, lease, {
            state: "running",
            workflowRunId,
            workflowUrl: workflowRunId
              ? `https://github.com/${task.payload.repository}/actions/runs/${workflowRunId}`
              : undefined,
          });
        }
      } else if (task.state === "running") {
        const run = await this.github.run(token, task);
        if (!run) {
          if (Date.parse(task.updatedAt) + 600000 < Date.now())
            throw new Fault("coding_run_not_found");
          await this.update(workspaceId, id, lease, {});
          return;
        }
        task.workflowRunId = run.id;
        const patch: Partial<CodingTask> = {
          workflowRunId: run.id,
          workflowUrl: `https://github.com/${task.payload.repository}/actions/runs/${run.id}`,
        };
        // Recheck revocation after reads, including disconnect/reconfiguration.
        const current = await this.store.read(workspaceId);
        const latest = current.codingTasks?.find((t) => t.id === id);
        if (!latest || latest.lease !== lease) return;
        const d = await this.store.deployment();
        try {
          checkCodingTask(current, latest);
          requireThat(d.active && !d.paused, "deployment_paused", 409);
        } catch {
          task.cancelRequested = true;
        }
        if (run.status === "completed") {
          if (run.conclusion === "success") {
            patch.prUrl = await this.github.pull(token, task);
            requireThat(patch.prUrl, "coding_pr_missing", 409);
            patch.state = "succeeded";
          } else {
            patch.state =
              run.conclusion === "cancelled" ? "cancelled" : "failed";
            patch.error = "coding_workflow_failed";
          }
        } else if (task.cancelRequested && !task.cancellationSent) {
          // Cancellation is best-effort and never retried after an uncertain POST.
          const reserved = await this.update(
            workspaceId,
            id,
            lease,
            { ...patch, cancelRequested: true, cancellationSent: true },
            false,
          );
          if (!reserved) return;
          await this.github.cancel(token, task);
        } else if (Date.parse(task.createdAt) + 2 * 3600000 < Date.now()) {
          requireThat(
            !task.cancellationSent,
            "coding_cancellation_unconfirmed",
            409,
          );
          patch.cancelRequested = true;
          patch.error = "coding_task_timeout";
        }
        await this.update(workspaceId, id, lease, patch);
      }
    } catch (error) {
      const reason = code(error);
      const snapshot = await this.store.read(workspaceId);
      const current = snapshot.codingTasks?.find((t) => t.id === id);
      if (!current || current.lease !== lease) return;
      // Read failures can retry for up to two hours. Writes remain unknown forever.
      if (
        current.state === "running" &&
        !current.cancellationSent &&
        ["coding_github_unavailable", "github_unavailable"].includes(reason) &&
        Date.parse(current.createdAt) + 7200000 > Date.now()
      ) {
        await this.update(workspaceId, id, lease, {});
        return;
      }
      const uncertain =
        externalWriteCompleted ||
        [
          "coding_outcome_unknown",
          "github_issue_outcome_unknown",
          "coding_run_not_found",
          "coding_run_ambiguous",
        ].includes(reason) ||
        current.state === "running";
      await this.update(workspaceId, id, lease, {
        state: uncertain ? "unknown" : "failed",
        error: reason,
      });
    }
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
      const discovered = patch.workflowRunId && !task.workflowRunId;
      Object.assign(task, patch);
      if (changed) {
        task.updatedAt = new Date().toISOString();
        audit(w, task.actor, `coding.${task.state}`, task.id);
      }
      if (changed || discovered) notifyCoding(w, task);
      if (release) {
        task.lease = undefined;
        task.nextPollAt = new Date(Date.now() + 15000).toISOString();
      }
      return true;
    });
  }
}
