import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { decrypt } from "../setup/credentials.ts";
import {
  type DevelopmentRun,
  type DevelopmentTask,
  developmentStopped,
} from "./development.ts";
import type {
  LocalDeviceAuth,
  LocalRunner,
  LocalStatus,
} from "./local/protocol.ts";
import {
  finishAttempt,
  taskEvent,
  taskGet,
  taskInputs,
  taskList,
  taskSave,
} from "./task-store.ts";
import { checkDevelopment, notifyDevelopment } from "./tasks.ts";

const reason = (e: unknown) =>
  e instanceof Fault ? e.code : "coding_execution_failed";
/** Durable task identity is distinct from a fenced, single-use runner attempt. */
export class DevelopmentExecutor {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private runner?: LocalRunner,
    private key?: string,
  ) {}
  async tick(workspaceId: string) {
    for (const task of await taskList(this.store.pool, workspaceId)) {
      if (developmentStopped(task.state) && !task.contentRemoved) continue;
      await this.advance(workspaceId, task.id);
    }
  }
  private async allowed(w: Workspace, sql: Sql, task: DevelopmentTask) {
    checkDevelopment(w, task);
    requireThat(!w.settings.paused, "coding_workspace_paused", 409);
    const deployment = await this.store.deployment(sql);
    requireThat(
      deployment.active && !deployment.paused,
      "deployment_paused",
      409,
    );
    requireThat(deployment.bot?.id === task.botId, "coding_bot_changed", 409);
    const references =
      (
        await sql.query(
          "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
          [w.id, task.id],
        )
      ).rows[0]?.data?.sources ?? [];
    requireThat(
      references.every((reference: { id: string }) =>
        w.messages.some(
          (s) =>
            s.id === reference.id &&
            s.chatId === task.chatId &&
            s.topicId === task.topicId &&
            Date.parse(s.expiresAt) > Date.now(),
        ),
      ),
      "coding_source_expired",
      409,
    );
    const inputs = await taskInputs(sql, task);
    for (const actor of new Set(inputs.map((i) => i.actor)))
      checkDevelopment(w, task, actor);
    requireThat(
      inputs.length &&
        inputs.every((i) =>
          w.messages.some(
            (s) =>
              s.id === i.sourceId &&
              s.author === i.actor &&
              s.chatId === task.chatId &&
              s.topicId === task.topicId &&
              Date.parse(s.expiresAt) > Date.now(),
          ),
        ),
      "coding_source_expired",
      409,
    );
  }
  private async token(
    task: DevelopmentTask,
    permission: "contents" | "publish",
  ) {
    const w = await this.store.read(task.workspaceId);
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const token = (
      await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        permission === "contents" ? "coding_read" : permission,
      )
    ).token;
    if (task.payload.authMode === "device_code")
      requireThat(
        await app.repositoryPrivate(token, task.payload.repository),
        "coding_device_private_repository_required",
        409,
      );
    return { token, app };
  }
  async advance(workspaceId: string, id: string) {
    const lease = randomUUID();
    const task = await this.store.change(workspaceId, async (w, sql) => {
      const t = await taskGet(sql, workspaceId, id);
      if (
        (developmentStopped(t.state) && !t.contentRemoved) ||
        Date.parse(t.leaseUntil ?? "1970-01-01") > Date.now() ||
        Date.parse(t.nextPollAt ?? "1970-01-01") > Date.now()
      )
        return;
      try {
        await this.allowed(w, sql, t);
      } catch (error) {
        t.cancelRequested = true;
        t.error = reason(error);
      }
      if (t.cancelRequested && !t.attemptId && !t.contentRemoved) {
        t.state = "cancelled";
        await taskSave(sql, t);
        return;
      }
      if (!t.cancelRequested && ["review", "waiting"].includes(t.state)) return;
      t.lease = lease;
      t.leaseUntil = new Date(Date.now() + 120000).toISOString();
      await taskSave(sql, t);
      return structuredClone(t);
    });
    if (!task) return;
    let dispatched = false;
    try {
      requireThat(this.runner, "coding_runner_not_configured", 409);
      if (task.contentRemoved) {
        requireThat(this.runner.erase, "coding_runner_cleanup_required", 503);
        const attempts = await this.store.pool.query(
          "SELECT id FROM coding_task_attempts WHERE workspace_id=$1 AND task_id=$2",
          [workspaceId, id],
        );
        for (const attempt of attempts.rows)
          await this.runner.erase(workspaceId, attempt.id);
        await this.store.change(workspaceId, async (_w, sql) => {
          await sql.query(
            "DELETE FROM coding_tasks WHERE workspace_id=$1 AND id=$2",
            [workspaceId, id],
          );
        });
        return;
      }
      if (task.cancelRequested) {
        if (task.attemptId)
          await this.runner.cancel(workspaceId, task.attemptId).catch((e) => {
            if (!(e instanceof Fault) || e.code !== "coding_task_not_found")
              throw e;
          });
        await this.update(task, lease, async (_w, sql, t) => {
          t.state = t.state === "publishing" ? "unknown" : "cancelled";
          await finishAttempt(
            sql,
            t,
            t.state === "unknown" ? "unknown" : "done",
          );
        });
        return;
      }
      if (task.state === "queued") {
        requireThat(
          task.attempts < task.policy.maxAttempts &&
            task.activeMs < task.policy.activeSeconds * 1000 &&
            task.tokens < task.policy.maxTokens,
          "coding_budget_exhausted",
          409,
        );
        if (task.payload.authMode === "device_code") {
          const device = this.runner as LocalRunner & Partial<LocalDeviceAuth>;
          requireThat(
            device.deviceStatus &&
              (await device.deviceStatus(workspaceId)).state === "connected",
            "coding_device_auth_required",
            409,
          );
        }
        const { token, app } = await this.token(task, "contents");
        const pr = task.pr
          ? await app.codingPull(token, task.payload.repository, task.pr.number)
          : undefined;
        if (pr)
          requireThat(
            pr.branch === task.pr?.branch,
            "coding_pr_target_changed",
            409,
          );
        const snapshot = await this.store.read(workspaceId);
        const providerApiKey = snapshot.coding?.providerApiKey
          ? decrypt(
              this.key ?? "",
              `coding-provider:${workspaceId}`,
              snapshot.coding.providerApiKey,
            )
          : undefined;
        const reserved = await this.update(
          task,
          lease,
          async (w, sql, t) => {
            await this.allowed(w, sql, t);
            t.pr = pr;
            t.fence++;
            t.attempts++;
            t.attemptId = randomUUID();
            t.state = "working";
            t.consumedRevision = t.revision;
            const inputs = await taskInputs(sql, t);
            const events = (
              await sql.query(
                "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
                [workspaceId, id],
              )
            ).rows[0]?.data;
            const decisions = (
              await sql.query(
                "SELECT id,data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND (id LIKE 'question:%' OR id LIKE 'answer:%') ORDER BY created_at,id LIMIT 200",
                [workspaceId, id],
              )
            ).rows;
            const run: DevelopmentRun = {
              taskId: t.id,
              revision: t.revision,
              mode: t.phase,
              inputs,
              context: JSON.stringify({
                references: events?.sources ?? [],
                decisions,
                priorResult: t.result,
                priorQuestion: t.question,
              }).slice(0, 40000),
              previousAttemptId: t.previousAttemptId,
              threadId: t.threadId,
              pr,
              maxRepairAttempts: t.policy.maxRepairAttempts,
              activeSeconds: Math.max(
                1,
                Math.floor(t.policy.activeSeconds - t.activeMs / 1000),
              ),
              maxTokens: t.policy.maxTokens - t.tokens,
            };
            await sql.query(
              "INSERT INTO coding_task_attempts(workspace_id,id,task_id,fence,state,data) VALUES($1,$2,$3,$4,'reserved',$5)",
              [
                workspaceId,
                t.attemptId,
                id,
                t.fence,
                JSON.stringify({
                  revision: t.revision,
                  startedAt: Date.now(),
                  run,
                  usageReserved: run.maxTokens,
                }),
              ],
            );
            notifyDevelopment(
              w,
              t,
              t.phase === "intake"
                ? "Codex is investigating the request."
                : t.phase === "analysis"
                  ? "Codex is investigating your question."
                  : "Codex is implementing and checking the change.",
              `phase:${t.fence}`,
            );
            return { attemptId: t.attemptId, run };
          },
          false,
        );
        if (!reserved) return;
        dispatched = true;
        await this.runner.start({
          workspaceId,
          taskId: reserved.attemptId,
          payload: task.payload,
          readToken: token,
          providerApiKey,
          development: reserved.run,
        });
        await this.update(task, lease, async (_w, sql, t) => {
          await sql.query(
            "UPDATE coding_task_attempts SET state='running' WHERE workspace_id=$1 AND id=$2 AND state='reserved'",
            [workspaceId, t.attemptId],
          );
        });
        return;
      }
      requireThat(task.attemptId, "coding_attempt_missing", 409);
      const status = await this.runner.status(workspaceId, task.attemptId);
      if (["preparing", "running", "publishing"].includes(status.state)) {
        await this.update(task, lease, async () => {});
        return;
      }
      if (
        task.state === "publishing" &&
        status.state === "unknown" &&
        status.publishedSha
      ) {
        const { token, app } = await this.token(task, "contents");
        const pr = await app.codingPublishedPull(
          token,
          task.payload.repository,
          task.pr?.branch ?? `codex/repodesk-${task.id}`,
          status.publishedSha,
          task.payload.baseBranch,
        );
        if (pr && (!task.pr || task.pr.number === pr.number)) {
          await this.update(task, lease, async (w, sql, t) => {
            await this.allowed(w, sql, t);
            await this.settle(sql, t, status);
            t.pr = pr;
            t.state = t.revision > t.consumedRevision ? "queued" : "review";
            t.phase = "intake";
            t.attemptId = undefined;
            t.previousAttemptId = undefined;
            await this.notice(
              w,
              t,
              `Publication confirmed: ${pr.url}`,
              `published:${t.fence}`,
            );
          });
          return;
        }
      }
      if (task.state === "publishing" && status.state === "ready") {
        await this.update(task, lease, async (w, sql, t) => {
          t.state = "unknown";
          t.error = "coding_publication_unknown";
          await finishAttempt(sql, t, "unknown");
          await this.notice(
            w,
            t,
            "Publication outcome is unknown. It will not be repeated automatically.",
            `stopped:${t.fence}`,
          );
        });
        return;
      }
      if (status.state === "ready") {
        await this.ready(task, lease, status);
        return;
      }
      await this.update(task, lease, async (w, sql, t) => {
        await this.allowed(w, sql, t);
        await this.settle(sql, t, status);
        if (status.state === "succeeded" && t.state === "publishing") {
          requireThat(
            status.prUrl && status.publishedSha,
            "coding_pr_missing",
            409,
          );
          const prefix = `https://github.com/${t.payload.repository}/pull/`;
          requireThat(
            status.prUrl.startsWith(prefix) &&
              /^[1-9]\d*$/.test(status.prUrl.slice(prefix.length)),
            "coding_pr_missing",
            409,
          );
          const number = Number(status.prUrl.slice(prefix.length));
          requireThat(
            !t.pr || t.pr.number === number,
            "coding_pr_target_changed",
            409,
          );
          t.pr = {
            number,
            url: status.prUrl,
            branch: t.pr?.branch ?? `codex/repodesk-${t.id}`,
            headSha: status.publishedSha,
          };
          t.state = t.revision > t.consumedRevision ? "queued" : "review";
          t.phase = "intake";
          t.previousAttemptId = undefined;
          await this.notice(
            w,
            t,
            `Draft PR: ${t.pr.url}\n${t.result?.summary ?? "Configured checks passed."}`,
            `published:${t.fence}`,
          );
        } else if (status.state === "succeeded") {
          requireThat(status.result, "coding_result_invalid", 409);
          t.result = status.result;
          if (t.revision > t.consumedRevision) {
            t.state = "queued";
            t.phase = "intake";
          } else if (status.result.status === "needs_input") {
            t.state = "waiting";
            t.question = {
              id: randomUUID(),
              text: status.result.question ?? "",
              revision: t.consumedRevision,
            };
            await taskEvent(sql, t, `question:${t.question.id}`, t.question);
            await this.notice(
              w,
              t,
              t.question.text,
              `question:${t.question.id}`,
            );
          } else if (t.phase === "intake") {
            const input = (await taskInputs(sql, t)).find(
              (i) => i.revision === t.consumedRevision,
            );
            const result = status.result;
            requireThat(
              input &&
                result.status === "intent" &&
                result.evidenceRevision === input.revision &&
                result.evidence.trim().length > 0 &&
                input.text.includes(result.evidence),
              "coding_intent_unverified",
              409,
            );
            if (result.intent === "uncertain") {
              t.state = "waiting";
              t.question = {
                id: randomUUID(),
                text: "What outcome should Codex deliver for this request?",
                revision: t.consumedRevision,
              };
              await taskEvent(sql, t, `question:${t.question.id}`, t.question);
              await this.notice(
                w,
                t,
                t.question.text,
                `question:${t.question.id}`,
              );
            } else {
              t.canImplement = result.intent === "implement";
              t.canPublish =
                t.canImplement &&
                (result.publishRequested ||
                  t.policy.publishByDefault ||
                  !!t.pr);
              t.phase = t.canImplement ? "work" : "analysis";
              t.state = "queued";
              await taskEvent(sql, t, `grant:${t.consumedRevision}`, {
                actor: input.actor,
                sourceId: input.sourceId,
                text: input.text,
                policy: t.policy,
                payload: t.payload,
                interpretation: result,
                operations: t.canImplement
                  ? ["read", "implement", ...(t.canPublish ? ["publish"] : [])]
                  : ["read"],
              });
            }
          } else {
            t.state = "review";
            t.previousAttemptId = undefined;
            await this.notice(w, t, status.result.summary, `result:${t.fence}`);
          }
        } else if (status.error === "coding_remote_head_changed") {
          t.state = "queued";
          t.phase = "work";
          t.previousAttemptId = undefined;
        } else {
          t.state =
            status.state === "unknown"
              ? "unknown"
              : status.state === "cancelled"
                ? "cancelled"
                : "failed";
          t.error = status.error ?? "coding_execution_failed";
          await this.notice(
            w,
            t,
            `Codex stopped: ${t.error}${t.pr ? `\n${t.pr.url}` : ""}`,
            `stopped:${t.fence}`,
          );
        }
        t.attemptId = undefined;
      });
    } catch (error) {
      const code = reason(error);
      if (task.contentRemoved) {
        await this.update(task, lease, async (_w, _sql, t) => {
          t.error = code;
        });
        return;
      }
      if (
        !dispatched &&
        task.attemptId &&
        ["coding_runner_unavailable", "coding_runner_request_failed"].includes(
          code,
        )
      ) {
        await this.update(task, lease, async () => {});
        return;
      }
      if (task.attemptId && task.state !== "publishing")
        await this.runner?.cancel(workspaceId, task.attemptId).catch(() => {});
      await this.update(task, lease, async (w, sql, t) => {
        if (dispatched && code === "coding_outcome_unknown") {
          t.error = code; // Poll the committed attempt identity; never resend start.
        } else if (dispatched && code === "coding_runner_busy") {
          await finishAttempt(sql, t);
          t.state = "queued";
          t.attemptId = undefined;
          t.attempts--;
        } else {
          t.state =
            dispatched ||
            t.state === "publishing" ||
            code === "coding_task_not_found"
              ? "unknown"
              : "failed";
          t.error = code;
          await finishAttempt(
            sql,
            t,
            t.state === "unknown" ? "unknown" : "done",
          );
          await this.notice(
            w,
            t,
            `Codex stopped: ${code}${t.pr ? `\n${t.pr.url}` : ""}`,
            `stopped:${t.fence}`,
          );
        }
      });
    }
  }
  private async ready(
    task: DevelopmentTask,
    lease: string,
    status: LocalStatus,
  ) {
    requireThat(
      this.runner &&
        task.attemptId &&
        status.checkPassed &&
        status.result?.status === "completed" &&
        task.canImplement,
      "coding_unverified_artifact",
      409,
    );
    let publish = false;
    const credentials = task.canPublish
      ? await this.token(task, "publish")
      : undefined;
    await this.update(
      task,
      lease,
      async (w, sql, t) => {
        await this.allowed(w, sql, t);
        t.result = status.result;
        t.threadId = status.threadId;
        t.verifiedRevision = t.consumedRevision;
        if (t.revision > t.verifiedRevision || !t.canPublish) {
          await this.settle(sql, t, status);
          t.state = t.revision > t.verifiedRevision ? "queued" : "review";
          t.phase = "intake";
          t.attemptId = undefined;
          if (t.state === "review")
            await this.notice(
              w,
              t,
              `${status.result?.summary}\nVerified locally; publication has not been requested.`,
              `result:${t.fence}`,
            );
        } else {
          t.state = "publishing";
          await sql.query(
            "UPDATE coding_task_attempts SET state='publishing' WHERE workspace_id=$1 AND id=$2",
            [t.workspaceId, t.attemptId],
          );
          publish = true;
        }
      },
      false,
    );
    if (!publish) {
      await this.runner.cancel(task.workspaceId, task.attemptId);
      await this.update(task, lease, async () => {});
      return;
    }
    requireThat(credentials, "coding_publication_denied", 409);
    // This POST is never retried. A lost acknowledgement is reconciled by status only.
    try {
      await this.runner.publish(
        task.workspaceId,
        task.attemptId,
        credentials.token,
      );
    } catch {
      /* Reservation survives: subsequent polls inspect the existing runner attempt. */
    }
    await this.update(task, lease, async () => {});
  }
  private async settle(sql: Sql, task: DevelopmentTask, status: LocalStatus) {
    const row = (
      await sql.query(
        "SELECT data FROM coding_task_attempts WHERE workspace_id=$1 AND id=$2",
        [task.workspaceId, task.attemptId],
      )
    ).rows[0];
    task.activeMs += Math.max(
      0,
      Date.now() - (row?.data.startedAt ?? Date.now()),
    );
    task.tokens +=
      status.tokens ?? row?.data.usageReserved ?? task.policy.maxTokens;
    task.threadId = status.threadId;
    task.previousAttemptId = task.attemptId;
    await finishAttempt(
      sql,
      task,
      status.state === "unknown" ? "unknown" : "done",
      {
        endedAt: Date.now(),
        tokens: status.tokens,
        checkPassed: status.checkPassed,
      },
    );
  }
  private async notice(
    w: Workspace,
    task: DevelopmentTask,
    text: string,
    eventId: string,
  ) {
    try {
      if (!w.deletion) notifyDevelopment(w, task, text, eventId);
    } catch {
      /* Revoked audience receives nothing. */
    }
  }
  private async update<T>(
    task: DevelopmentTask,
    lease: string,
    action: (w: Workspace, sql: Sql, t: DevelopmentTask) => Promise<T>,
    release = true,
  ) {
    return this.store.change(task.workspaceId, async (w, sql) => {
      const t = await taskGet(sql, task.workspaceId, task.id);
      if (t.lease !== lease) return;
      const result = await action(w, sql, t);
      if (release) {
        t.lease = undefined;
        t.leaseUntil = undefined;
        t.nextPollAt = new Date(Date.now() + 5000).toISOString();
      }
      await taskSave(sql, t);
      return result;
    });
  }
}
