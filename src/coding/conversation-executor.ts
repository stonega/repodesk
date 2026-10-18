import { randomUUID } from "node:crypto";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { ModelProviders } from "../models/service.ts";
import { decrypt, fingerprint } from "../setup/credentials.ts";
import type { TaskExchange } from "./conversation.ts";
import {
  exchangeSourcesPresent,
  saveExchange,
  taskExchanges,
} from "./conversation-store.ts";
import { type DevelopmentTask, developmentStopped } from "./development.ts";
import type { LocalRunner, LocalStart, LocalStatus } from "./local/protocol.ts";
import { taskGet, taskInputs, taskSave } from "./task-store.ts";
import { checkDevelopment, notifyDevelopment } from "./tasks.ts";
import { captureRunnerStatus } from "./transcript-store.ts";

const finished = (message: TaskExchange) =>
  ["answered", "unknown", "cancelled"].includes(message.state);
const code = (error: unknown) =>
  error instanceof Fault ? error.code : "coding_runner_unavailable";

/** Exchanges have their own receipts; asking a question never advances requirements. */
export class TaskConversationExecutor {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private runner?: LocalRunner,
    private key = "",
  ) {}
  private async allowed(
    w: Workspace,
    task: DevelopmentTask,
    message: TaskExchange,
  ) {
    checkDevelopment(w, task, message.actor);
    requireThat(
      !task.contentRemoved && exchangeSourcesPresent(w, message),
      "coding_source_expired",
      409,
    );
    const inputs = await taskInputs(this.store.pool, task);
    const references =
      (
        await this.store.pool.query(
          "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
          [task.workspaceId, task.id],
        )
      ).rows[0]?.data?.sources ?? [];
    requireThat(
      references.every((reference: { id: string }) =>
        w.messages.some(
          (s) => s.id === reference.id && Date.parse(s.expiresAt) > Date.now(),
        ),
      ),
      "coding_source_expired",
      409,
    );
    requireThat(
      inputs.length &&
        inputs.every((input) =>
          w.messages.some(
            (s) =>
              s.id === input.sourceId && Date.parse(s.expiresAt) > Date.now(),
          ),
        ),
      "coding_source_expired",
      409,
    );
    for (const actor of new Set(inputs.map((input) => input.actor)))
      checkDevelopment(w, task, actor);
    const deployment = await this.store.deployment();
    requireThat(
      deployment.active &&
        !deployment.paused &&
        !w.settings.paused &&
        deployment.bot?.id === task.botId,
      "coding_task_stopped",
      409,
    );
  }
  async advance(workspaceId: string, taskId: string) {
    const messages = await taskExchanges(
      this.store.pool,
      {
        workspaceId,
        id: taskId,
      },
      true,
    );
    if (!messages.length) return;
    for (const message of messages
      .filter((m) => !finished(m) || m.cleanup)
      .slice(0, 8))
      await this.advanceMessage(workspaceId, taskId, message.id);
    if (messages.length)
      await this.store.change(workspaceId, async (_w, sql) => {
        const task = await taskGet(sql, workspaceId, taskId);
        if (
          !(await taskExchanges(sql, task)).some(
            (m) => !finished(m) || m.cleanup,
          )
        ) {
          task.conversationPending = false;
          await taskSave(sql, task);
        }
      });
  }
  private async advanceMessage(
    workspaceId: string,
    taskId: string,
    messageId: string,
  ) {
    const lease = randomUUID();
    const claimed = await this.store.change(workspaceId, async (_w, sql) => {
      const task = await taskGet(sql, workspaceId, taskId);
      const message = (await taskExchanges(sql, task)).find(
        (m) => m.id === messageId,
      );
      if (
        !message ||
        (finished(message) && !message.cleanup) ||
        Date.parse(message.leaseUntil ?? "1970-01-01") > Date.now()
      )
        return;
      message.lease = lease;
      message.leaseUntil = new Date(Date.now() + 120000).toISOString();
      await saveExchange(sql, task, message);
      return { task: structuredClone(task), message: structuredClone(message) };
    });
    if (!claimed) return;
    const { task, message } = claimed;
    const update = async (
      action: (
        w: Workspace,
        task: DevelopmentTask,
        message: TaskExchange,
      ) => Promise<void> | void,
    ) =>
      this.store.change(workspaceId, async (w, sql) => {
        const t = await taskGet(sql, workspaceId, taskId);
        const m = (await taskExchanges(sql, t)).find((m) => m.id === messageId);
        if (!m || m.lease !== lease) return;
        await action(w, t, m);
        await saveExchange(sql, t, m);
        await taskSave(sql, t);
      });
    const finish = async (
      state: TaskExchange["state"],
      answer?: string,
      error?: string,
    ) =>
      update(async (w, t, m) => {
        if (!t.cancelRequested && !t.contentRemoved)
          await this.allowed(w, t, m);
        m.state = state;
        m.answer = answer;
        if (answer) m.answeredAt ??= new Date().toISOString();
        m.error = error;
        m.cleanup = m.route === "readonly";
        if (answer && !t.cancelRequested)
          notifyDevelopment(
            w,
            t,
            `Codex: ${answer}`,
            `conversation:${m.id}:answer`,
            m.actor,
          );
        else if (state === "unknown" && !t.cancelRequested)
          notifyDevelopment(
            w,
            t,
            "Codex could not confirm an answer to your task question. The implementation task keeps its own status; no question was automatically replayed.",
            `conversation:${m.id}:unknown`,
            m.actor,
          );
      });
    try {
      requireThat(this.runner, "coding_runner_not_configured", 409);
      if (message.cleanup) {
        await this.cleanup(task, message, update);
        return;
      }
      const w = await this.store.read(workspaceId);
      if (
        task.cancelRequested ||
        task.contentRemoved ||
        developmentStopped(task.state)
      ) {
        if (message.route === "readonly" && message.attemptId)
          await this.runner.cancel(workspaceId, message.attemptId);
        await finish("cancelled");
        return;
      }
      await this.allowed(w, task, message);
      if (!message.attemptId) {
        if (task.state === "working" && task.attemptId && this.runner.message) {
          message.attemptId = task.attemptId;
          message.route = "active";
          await update((_w, _t, m) => {
            m.attemptId = message.attemptId;
            m.route = message.route;
          });
        } else if (
          ["review", "waiting"].includes(task.state) &&
          !task.attemptId &&
          !task.cleanupAttemptId &&
          !task.conversationAttemptId
        ) {
          await this.startReadonly(task, message, lease);
          return;
        } else return;
      }
      let status: LocalStatus;
      try {
        status = await captureRunnerStatus(
          this.store,
          this.runner,
          task,
          message.attemptId as string,
        );
      } catch (error) {
        if (
          code(error) !== "coding_task_not_found" ||
          message.route !== "readonly" ||
          !message.start
        )
          throw error;
        await this.retryStart(task, message);
        return;
      }
      const receipt = status.conversation?.messages.find(
        (m) => m.id === message.id,
      );
      if (receipt?.state === "answered") {
        if (
          message.route === "readonly" &&
          ["preparing", "running"].includes(status.state)
        ) {
          await update((_w, _t, m) => {
            m.state = "read";
          });
          return;
        }
        if (message.route === "readonly")
          await this.settle(task, message, status);
        await finish("answered", receipt.answer);
        return;
      }
      if (message.route === "readonly") {
        if (status.state === "auth_required") {
          const device = this.runner as LocalRunner & {
            deviceStatus?: (id: string) => Promise<{ state: string }>;
          };
          if (
            (await device.deviceStatus?.(workspaceId))?.state === "connected"
          ) {
            await this.allowed(
              await this.store.read(workspaceId),
              await taskGet(this.store.pool, workspaceId, taskId),
              message,
            );
            await this.runner.resumeAuth?.(
              workspaceId,
              message.attemptId as string,
            );
          }
          await update((_w, _t, m) => {
            m.error = "coding_device_auth_required";
          });
          return;
        }
        if (status.state === "succeeded") {
          await this.settle(task, message, status);
          await finish(
            "answered",
            status.result?.question ||
              status.result?.summary ||
              "Codex returned no answer.",
          );
          return;
        }
        if (["failed", "cancelled", "unknown"].includes(status.state)) {
          await this.settle(task, message, status);
          await finish(
            status.state === "cancelled" ? "cancelled" : "unknown",
            undefined,
            status.error,
          );
          return;
        }
      }
      if (
        receipt?.state === "queued" &&
        !["preparing", "running"].includes(status.state)
      ) {
        // No claim was ever made; a completed execution cannot later consume it.
        await update((_w, _t, m) => {
          m.attemptId = undefined;
          m.route = undefined;
          m.state = "queued";
        });
        return;
      }
      if (
        !receipt &&
        message.route === "active" &&
        ["preparing", "running"].includes(status.state)
      ) {
        await this.allowed(
          await this.store.read(workspaceId),
          await taskGet(this.store.pool, workspaceId, taskId),
          message,
        );
        try {
          await this.runner.message?.(
            workspaceId,
            message.attemptId as string,
            { id: message.id, question: message.question },
          );
          await update((_w, _t, m) => {
            m.state = "received";
            m.error = undefined;
          });
        } catch (error) {
          if (code(error) !== "coding_message_closed") throw error;
          await update((_w, _t, m) => {
            m.attemptId = undefined;
            m.route = undefined;
          });
        }
        return;
      }
      if (
        !receipt &&
        message.route === "active" &&
        !["preparing", "running"].includes(status.state)
      ) {
        await update((_w, _t, m) => {
          m.attemptId = undefined;
          m.route = undefined;
          m.state = "queued";
        });
        return;
      }
      if (receipt && ["unknown", "cancelled"].includes(receipt.state)) {
        await finish(receipt.state === "cancelled" ? "cancelled" : "unknown");
        return;
      }
      await update((_w, _t, m) => {
        m.state = receipt?.state === "read" ? "read" : "received";
        m.error = undefined;
      });
    } catch (error) {
      const failure = code(error);
      if (
        [
          "coding_runner_busy",
          "coding_runner_unavailable",
          "coding_outcome_unknown",
          "github_user_access_unavailable",
        ].includes(failure)
      ) {
        await update((_w, _t, m) => {
          m.error = failure;
        });
      } else {
        if (message.route === "readonly" && message.attemptId)
          await this.runner
            ?.cancel(workspaceId, message.attemptId)
            .catch(() => {});
        await update((_w, _t, m) => {
          m.state = "cancelled";
          m.error = failure;
          m.cleanup = m.route === "readonly";
          if (failure === "coding_source_expired") {
            m.question = "[removed]";
            m.answer = undefined;
          }
        });
      }
    } finally {
      await update((_w, _t, m) => {
        m.lease = undefined;
        m.leaseUntil = undefined;
      });
    }
  }
  private async startReadonly(
    task: DevelopmentTask,
    message: TaskExchange,
    lease: string,
  ) {
    requireThat(this.runner?.erase, "coding_runner_cleanup_required", 503);
    const w = await this.store.read(task.workspaceId);
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const token = (
      await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        "coding_read",
      )
    ).token;
    await this.allowed(
      await this.store.read(task.workspaceId),
      await taskGet(this.store.pool, task.workspaceId, task.id),
      message,
    );
    const pr = task.pr
      ? await app.codingPull(token, task.payload.repository, task.pr.number)
      : undefined;
    const shared =
      task.payload.authMode === "provider_key"
        ? await new ModelProviders(this.store, this.key).runner(
            w,
            w.coding?.settings.model,
          )
        : {};
    const input = await this.store.change(
      task.workspaceId,
      async (current, sql) => {
        const t = await taskGet(sql, task.workspaceId, task.id);
        const m = (await taskExchanges(sql, t)).find(
          (m) => m.id === message.id,
        );
        if (
          !m ||
          m.lease !== lease ||
          t.attemptId ||
          t.cleanupAttemptId ||
          t.conversationAttemptId ||
          !["waiting", "review"].includes(t.state)
        )
          return;
        await this.allowed(current, t, m);
        t.conversationAttemptId = randomUUID();
        t.fence++;
        const start: LocalStart = {
          workspaceId: t.workspaceId,
          taskId: t.conversationAttemptId,
          payload: t.payload,
          readToken: token,
          ...shared,
          providerApiKey:
            shared.providerApiKey ??
            (current.coding?.providerApiKey
              ? decrypt(
                  this.key,
                  `coding-provider:${current.id}`,
                  current.coding.providerApiKey,
                )
              : undefined),
          messages: [{ id: m.id, question: m.question }],
          development: {
            taskId: t.id,
            revision: t.revision,
            mode: "analysis",
            inputs: await taskInputs(sql, t),
            pr,
            previousAttemptId: t.previousAttemptId,
            context: JSON.stringify({
              taskResult: t.result,
              conversationQuestion: { id: m.id, question: m.question },
              pendingQuestion: t.question,
              messages: (await taskExchanges(sql, t))
                .filter((m) => m.state === "answered")
                .slice(-8)
                .map((m) => ({ question: m.question, answer: m.answer })),
              purpose:
                "Answer the task conversation question read-only. Do not change the implementation, answer a product decision for the user or publish.",
            }).slice(0, 40000),
          },
        };
        m.attemptId = start.taskId;
        m.route = "readonly";
        m.state = "received";
        const {
          readToken: _readToken,
          providerApiKey: _providerApiKey,
          ...safe
        } = start;
        m.start = safe;
        await sql.query(
          "INSERT INTO coding_task_attempts(workspace_id,id,task_id,fence,state,data) VALUES($1,$2,$3,$4,'reserved',$5)",
          [
            t.workspaceId,
            start.taskId,
            t.id,
            t.fence,
            JSON.stringify({
              conversationMessageId: m.id,
              startedAt: Date.now(),
            }),
          ],
        );
        await saveExchange(sql, t, m);
        await taskSave(sql, t);
        return start;
      },
    );
    if (!input) return;
    // A start with an uncertain acknowledgement is inspected by ID on later ticks.
    await this.allowed(
      await this.store.read(task.workspaceId),
      await taskGet(this.store.pool, task.workspaceId, task.id),
      message,
    );
    await this.runner.start(input);
  }
  private async retryStart(task: DevelopmentTask, message: TaskExchange) {
    requireThat(this.runner && message.start, "coding_message_invalid", 409);
    const w = await this.store.read(task.workspaceId);
    await this.allowed(
      w,
      await taskGet(this.store.pool, task.workspaceId, task.id),
      message,
    );
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const token = (
      await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        "coding_read",
      )
    ).token;
    const shared =
      task.payload.authMode === "provider_key"
        ? await new ModelProviders(this.store, this.key).runner(
            w,
            w.coding?.settings.model,
          )
        : {};
    requireThat(
      fingerprint(shared.modelProvider ?? null) ===
        fingerprint(message.start.modelProvider ?? null),
      "coding_configuration_changed",
      409,
    );
    await this.allowed(
      await this.store.read(task.workspaceId),
      await taskGet(this.store.pool, task.workspaceId, task.id),
      message,
    );
    await this.runner.start({
      ...message.start,
      readToken: token,
      providerApiKey:
        shared.providerApiKey ??
        (w.coding?.providerApiKey
          ? decrypt(
              this.key,
              `coding-provider:${w.id}`,
              w.coding.providerApiKey,
            )
          : undefined),
    });
  }
  private async settle(
    task: DevelopmentTask,
    message: TaskExchange,
    status: LocalStatus,
  ) {
    await this.store.change(task.workspaceId, async (_w, sql) => {
      const t = await taskGet(sql, task.workspaceId, task.id);
      const row = await sql.query(
        "UPDATE coding_task_attempts SET state='done',data=data || $3::jsonb WHERE workspace_id=$1 AND id=$2 AND state<>'done' RETURNING id",
        [
          t.workspaceId,
          message.attemptId,
          JSON.stringify({
            tokens: status.tokens,
            usageUnknown: status.usageUnknown || status.tokens === undefined,
          }),
        ],
      );
      if (row.rowCount) {
        t.tokens += status.tokens ?? 0;
        t.usageUnknown ||= status.usageUnknown || status.tokens === undefined;
        await taskSave(sql, t);
      }
    });
  }
  private async cleanup(
    task: DevelopmentTask,
    message: TaskExchange,
    update: (
      action: (
        w: Workspace,
        t: DevelopmentTask,
        m: TaskExchange,
      ) => Promise<void> | void,
    ) => Promise<unknown>,
  ) {
    requireThat(
      this.runner?.erase && message.attemptId,
      "coding_runner_cleanup_required",
      503,
    );
    await this.runner.erase(task.workspaceId, message.attemptId);
    await this.store.change(task.workspaceId, async (_w, sql) => {
      const t = await taskGet(sql, task.workspaceId, task.id);
      await sql.query(
        "UPDATE coding_task_attempts SET state='done' WHERE workspace_id=$1 AND id=$2",
        [t.workspaceId, message.attemptId],
      );
      if (t.conversationAttemptId === message.attemptId)
        t.conversationAttemptId = undefined;
      await taskSave(sql, t);
    });
    await update((_w, _t, m) => {
      m.cleanup = undefined;
      m.start = undefined;
    });
  }
}
