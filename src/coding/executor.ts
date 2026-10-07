import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Deployment,
  Fault,
  requireThat,
  type Workspace,
} from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { decrypt, fingerprint } from "../setup/credentials.ts";
import { loadSourceAttachments } from "../telegram/attachments.ts";
import { type Telegram, TelegramClient } from "../telegram/client.ts";
import { clearProgress, recordProgress } from "../telegram/feedback.ts";
import {
  type DevelopmentRun,
  type DevelopmentTask,
  developmentEvidence,
  developmentMedia,
  developmentStopped,
} from "./development.ts";
import { codingFailureMessage } from "./failure-messages.ts";
import {
  markRunnerUnavailable,
  publicationUnknown,
  runnerStage,
  taskUnknown,
} from "./feedback.ts";
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
    private telegram?: (deployment: Deployment) => Promise<Telegram>,
  ) {}
  async tick(workspaceId: string) {
    for (const task of await taskList(this.store.pool, workspaceId)) {
      if (
        developmentStopped(task.state) &&
        !task.contentRemoved &&
        !task.cleanupAttemptId
      )
        continue;
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
              (!i.hasAttachments || !!s.attachments?.length) &&
              s.chatId === task.chatId &&
              s.topicId === task.topicId &&
              Date.parse(s.expiresAt) > Date.now(),
          ),
        ),
      "coding_source_expired",
      409,
    );
    return deployment;
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
    return { token, app };
  }
  async advance(workspaceId: string, id: string) {
    const lease = randomUUID();
    const task = await this.store.change(workspaceId, async (w, sql) => {
      const t = await taskGet(sql, workspaceId, id);
      if (
        (developmentStopped(t.state) &&
          !t.contentRemoved &&
          !t.cleanupAttemptId) ||
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
      if (
        t.cancelRequested &&
        !t.attemptId &&
        !t.contentRemoved &&
        !t.cleanupAttemptId
      ) {
        t.state = "cancelled";
        clearProgress(w, "development", t.id);
        notifyDevelopment(w, t, "Your task has stopped.", "cancel:stopped");
        await taskSave(sql, t);
        return;
      }
      if (
        !t.cancelRequested &&
        !t.cleanupAttemptId &&
        ["review", "waiting"].includes(t.state)
      )
        return;
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
      if (task.cleanupAttemptId) {
        await this.releaseCheckpoint(task, lease, task.cleanupAttemptId);
        return;
      }
      if (task.cancelRequested) {
        let stopConfirmed = true;
        if (task.attemptId)
          await this.runner.cancel(workspaceId, task.attemptId).catch((e) => {
            if (!(e instanceof Fault) || e.code !== "coding_task_not_found")
              throw e;
            stopConfirmed = false;
          });
        await this.update(task, lease, async (_w, sql, t) => {
          const publishing = t.state === "publishing";
          t.state = publishing || !stopConfirmed ? "unknown" : "cancelled";
          await finishAttempt(
            sql,
            t,
            t.state === "unknown" ? "unknown" : "done",
          );
          await this.notice(
            _w,
            t,
            t.state === "unknown"
              ? publishing
                ? publicationUnknown
                : taskUnknown
              : "Your task has stopped. Messages already sent cannot be undone.",
            "cancel:stopped",
          );
        });
        return;
      }
      if (task.state === "auth_required" && !task.attemptId) {
        if (await this.deviceConnected(workspaceId))
          await this.update(task, lease, async (w, sql, t) => {
            await this.allowed(w, sql, t);
            t.state = "queued";
            t.error = undefined;
            await this.notice(
              w,
              t,
              "Codex account connected. Your task will continue automatically.",
              `auth-resumed:${t.authPauses}`,
            );
          });
        else await this.update(task, lease, async () => {});
        return;
      }
      if (task.state === "queued") {
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
            const deployment = await this.allowed(w, sql, t);
            t.pr = pr;
            t.fence++;
            t.attempts++;
            t.attemptId = randomUUID();
            t.authWaitMs = 0;
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
                }),
              ],
            );
            const sourceIds = new Set([
              ...inputs.map((input) => input.sourceId),
              ...(events?.sources ?? []).map(
                (source: { id: string }) => source.id,
              ),
            ]);
            return {
              attemptId: t.attemptId,
              run,
              deployment,
              sources: w.messages.filter((source) => sourceIds.has(source.id)),
            };
          },
          false,
        );
        if (!reserved) return;
        const guard = async () => {
          const checked = await this.update(
            task,
            lease,
            async (w, sql, t) => {
              requireThat(
                t.attemptId === reserved.attemptId &&
                  !t.cancelRequested &&
                  Date.parse(t.leaseUntil ?? "") > Date.now(),
                "coding_task_stopped",
                409,
              );
              const deployment = await this.allowed(w, sql, t);
              requireThat(
                deployment.bot?.id === reserved.deployment.bot?.id &&
                  deployment.credentials.bot ===
                    reserved.deployment.credentials.bot,
                "coding_bot_changed",
                409,
              );
              requireThat(
                reserved.sources.every((source) => {
                  const retained = w.messages.find((s) => s.id === source.id);
                  return (
                    retained &&
                    retained.text === source.text &&
                    fingerprint(retained.attachments ?? []) ===
                      fingerprint(source.attachments ?? [])
                  );
                }),
                "coding_source_changed",
                409,
              );
              return true;
            },
            false,
          );
          requireThat(checked, "coding_task_stopped", 409);
        };
        if (reserved.sources.some((source) => source.attachments?.length)) {
          const currentId = reserved.run.inputs.find(
            (input) => input.revision === reserved.run.revision,
          )?.sourceId;
          reserved.run.media = developmentMedia.parse(
            await loadSourceAttachments(
              reserved.sources,
              (source) => source.id === currentId,
              task.botId,
              async () => {
                if (this.telegram) return this.telegram(reserved.deployment);
                requireThat(
                  this.key && reserved.deployment.credentials.bot,
                  "bot_not_configured",
                  409,
                );
                return new TelegramClient(
                  decrypt(this.key, "bot", reserved.deployment.credentials.bot),
                );
              },
              guard,
              AbortSignal.timeout(60000),
            ),
          );
        }
        await guard();
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
      if (status.state === "auth_required") {
        requireThat(
          task.payload.authMode === "device_code" &&
            task.state !== "publishing",
          "coding_result_invalid",
          409,
        );
        if (task.state !== "auth_required") {
          await this.pauseAuth(task, lease);
        } else if (await this.deviceConnected(workspaceId)) {
          requireThat(
            this.runner.resumeAuth,
            "coding_runner_not_configured",
            409,
          );
          await this.token(task, "contents"); // Recheck live private visibility before any resumed code.
          const authorized = await this.update(
            task,
            lease,
            async (w, sql, t) => {
              await this.allowed(w, sql, t);
              return true;
            },
            false,
          );
          if (!authorized) return;
          await this.runner.resumeAuth(workspaceId, task.attemptId);
          await this.resumeAuthState(task, lease);
        } else await this.update(task, lease, async () => {});
        return;
      }
      if (task.state === "auth_required")
        await this.resumeAuthState(
          task,
          lease,
          false,
          ["preparing", "running", "ready", "succeeded"].includes(status.state),
        );
      if (["preparing", "running", "publishing"].includes(status.state)) {
        await this.update(task, lease, async (w, sql, t) => {
          await this.allowed(w, sql, t);
          t.error = undefined;
          recordProgress(
            w,
            t,
            "development",
            runnerStage(status, t.phase),
            `${t.fence}:${t.consumedRevision}:${status.repairCount ?? 0}`,
          );
        });
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
          await this.notice(w, t, publicationUnknown, `stopped:${t.fence}`);
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
              `${t.question.text}\nReply here to continue.`,
              `question:${t.question.id}`,
            );
          } else if (t.phase === "intake") {
            const input = developmentEvidence({
              inputs: await taskInputs(sql, t),
              revision: t.consumedRevision,
            });
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
                `${t.question.text}\nReply here to continue.`,
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
            `${t.state === "unknown" ? (t.progress?.stage === "publish" ? publicationUnknown : taskUnknown) : t.state === "cancelled" ? "Your task has stopped." : codingFailureMessage(t.error)}${t.pr ? `\n${t.pr.url}` : ""}`,
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
        code === "coding_device_auth_required" &&
        task.payload.authMode === "device_code" &&
        task.state !== "publishing"
      ) {
        await this.pauseAuth(task, lease, dispatched);
        return;
      }
      if (
        task.state === "auth_required" &&
        [
          "coding_runner_busy",
          "coding_runner_unavailable",
          "coding_outcome_unknown",
        ].includes(code)
      ) {
        await this.update(task, lease, async () => {});
        return;
      }
      if (
        !dispatched &&
        (task.attemptId || task.state === "queued") &&
        ["coding_runner_unavailable", "coding_runner_request_failed"].includes(
          code,
        )
      ) {
        await this.update(task, lease, async (w, _sql, t) => {
          markRunnerUnavailable(t);
          clearProgress(w, "development", t.id);
        });
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
            t.cancelRequested && !dispatched
              ? "cancelled"
              : dispatched ||
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
            `${t.state === "unknown" ? (t.progress?.stage === "publish" ? publicationUnknown : taskUnknown) : codingFailureMessage(code)}${t.pr ? `\n${t.pr.url}` : ""}`,
            `stopped:${t.fence}`,
          );
        }
      });
    }
  }
  private async deviceConnected(workspaceId: string) {
    const device = this.runner as LocalRunner & Partial<LocalDeviceAuth>;
    requireThat(device.deviceStatus, "coding_runner_not_configured", 409);
    return (await device.deviceStatus(workspaceId)).state === "connected";
  }
  private async pauseAuth(
    task: DevelopmentTask,
    lease: string,
    rejectedStart = false,
  ) {
    await this.update(task, lease, async (w, sql, t) => {
      if (rejectedStart) {
        await finishAttempt(sql, t);
        t.attemptId = undefined;
        t.attempts--;
      }
      if (t.state !== "auth_required") {
        t.authPauses = (t.authPauses ?? 0) + 1;
        t.authPausedAt = t.attemptId ? new Date().toISOString() : undefined;
        await this.notice(
          w,
          t,
          codingFailureMessage("coding_device_auth_required"),
          `auth-required:${t.authPauses}`,
        );
      }
      t.state = "auth_required";
      t.error = "coding_device_auth_required";
    });
  }
  private async resumeAuthState(
    task: DevelopmentTask,
    lease: string,
    release = true,
    announce = true,
  ) {
    await this.update(
      task,
      lease,
      async (w, sql, t) => {
        await this.allowed(w, sql, t);
        t.authWaitMs =
          (t.authWaitMs ?? 0) +
          Math.max(
            0,
            Date.now() - Date.parse(t.authPausedAt ?? new Date().toISOString()),
          );
        t.authPausedAt = undefined;
        t.state = "working";
        t.error = undefined;
        if (announce)
          await this.notice(
            w,
            t,
            "Codex account connected. Continuing your task from its saved checkout.",
            `auth-resumed:${t.authPauses}`,
          );
      },
      release,
    );
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
          t.cleanupAttemptId = t.attemptId;
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
          recordProgress(
            w,
            t,
            "development",
            "publish",
            `${t.fence}:${t.consumedRevision}`,
          );
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
      await this.releaseCheckpoint(task, lease, task.attemptId);
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
  private async releaseCheckpoint(
    task: DevelopmentTask,
    lease: string,
    attemptId: string,
  ) {
    requireThat(this.runner, "coding_runner_not_configured", 409);
    try {
      // A completed attempt releases its slot idempotently, even after a lost ACK.
      await this.runner.cancel(task.workspaceId, attemptId);
    } catch (error) {
      const code = reason(error);
      if (code !== "coding_task_not_found") {
        if (
          ![
            "coding_runner_unavailable",
            "coding_runner_request_failed",
            "coding_outcome_unknown",
          ].includes(code)
        )
          throw error;
        await this.update(task, lease, async (w, _sql, t) => {
          markRunnerUnavailable(t);
          clearProgress(w, "development", t.id);
        });
        return;
      }
    }
    await this.update(task, lease, async (_w, _sql, t) => {
      if (t.cleanupAttemptId === attemptId) t.cleanupAttemptId = undefined;
      if (t.progress) t.progress.unavailable = false;
    });
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
      Date.now() - (row?.data.startedAt ?? Date.now()) - (task.authWaitMs ?? 0),
    );
    task.tokens += status.tokens ?? 0;
    task.usageUnknown ||= status.usageUnknown || status.tokens === undefined;
    task.threadId = status.threadId;
    task.previousAttemptId = task.attemptId;
    await finishAttempt(
      sql,
      task,
      status.state === "unknown" ? "unknown" : "done",
      {
        endedAt: Date.now(),
        tokens: status.tokens,
        usageUnknown: status.usageUnknown || status.tokens === undefined,
        checkPassed: status.checkPassed,
        resultIssues: status.resultIssues,
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
      if (!["working", "publishing"].includes(t.state))
        clearProgress(w, "development", t.id);
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
