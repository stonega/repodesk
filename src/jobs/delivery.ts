import { checkCodingPayload } from "../coding/policy.ts";
import { taskGet } from "../coding/task-store.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Delivery, requireThat, type Workspace } from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "../telegram/client.ts";
import { telegramMarkdown, telegramRichMessage } from "../telegram/format.ts";
import { selectionAllowed } from "../telegram/task-controls.ts";
import { eligible, runAllowed } from "../workspaces/policy.ts";
export class DeliveryWorker {
  constructor(
    private store: Store,
    private setup: SetupService,
  ) {}
  private editTarget(w: Workspace, d: Delivery, botId?: string) {
    const target = w.deliveries.find((t) => t.id === d.editOf);
    const scope = target?.progressMessage ?? target?.feedback;
    if (
      !d.progressMessage ||
      !target ||
      target.id === d.id ||
      scope?.owner !== d.progressMessage.owner ||
      scope.id !== d.progressMessage.id ||
      target.actor !== d.actor ||
      target.chatId !== d.chatId ||
      target.topicId !== d.topicId ||
      (target.botId && target.botId !== botId)
    )
      return;
    return target;
  }
  private async feedbackAllowed(
    w: Workspace,
    d: Delivery,
    sql: Sql = this.store.pool,
  ) {
    if (!(await selectionAllowed(sql, w, d))) return false;
    if (d.cancellationRunId) {
      const r = w.runs.find((r) => r.id === d.cancellationRunId);
      if (
        !r?.cancelled ||
        r.actor !== d.actor ||
        r.chatId !== d.chatId ||
        r.topicId !== d.topicId
      )
        return false;
      if (d.id.endsWith(":requested") && r.stopConfirmed) return false;
    }
    if (d.feedback?.owner === "run")
      return w.runs.some(
        (r) => r.id === d.feedback?.id && r.status === "queued" && !r.cancelled,
      );
    if (d.feedback?.owner === "development") {
      try {
        const t = await taskGet(sql, w.id, d.feedback.id);
        return (
          !t.cancelRequested &&
          (d.feedback.key === "queued"
            ? t.state === "queued"
            : ["working", "publishing"].includes(t.state) &&
              t.progress?.key === d.feedback.key &&
              !t.progress.unavailable)
        );
      } catch {
        return false;
      }
    }
    const id = /^coding:([0-9a-f-]{36}):/.exec(d.id)?.[1];
    if (id) {
      const t = w.codingTasks?.find((t) => t.id === id);
      if (t) {
        if (!d.id.includes(":cancel:")) {
          try {
            checkCodingPayload(w, t.actor, t.payload);
            if (d.actor !== t.actor) checkCodingPayload(w, d.actor, t.payload);
          } catch {
            return false;
          }
        }
        if (d.feedback)
          return (
            !t.cancelRequested &&
            (d.feedback.key === "queued"
              ? t.state === "queued"
              : ["running", "publishing", "starting_publication"].includes(
                  t.state,
                ) &&
                t.progress?.key === d.feedback.key &&
                !t.progress.unavailable)
          );
      } else if (d.feedback) return false;
    }
    return true;
  }
  async send(workspaceId: string, id: string) {
    const deployment = await this.store.deployment();
    if (deployment.paused) return;
    const intent = await this.store.change(workspaceId, async (w, sql) => {
      const d = w.deliveries.find((d) => d.id === id);
      if (!d || !["pending", "sending"].includes(d.state)) return;
      if (d.state === "sending") {
        if (Date.parse(d.startedAt ?? "") + 30000 < Date.now())
          // Editing a known message can be replayed safely after a worker crash.
          d.state = d.editOf ? "pending" : "delivery_unknown";
        return;
      }
      if (!(await this.feedbackAllowed(w, d, sql))) {
        d.state = "cancelled";
        return;
      }
      if (
        d.id.startsWith("development:") &&
        /^development:[0-9a-f-]{36}:/.test(d.id)
      ) {
        try {
          const task = await taskGet(
            sql,
            workspaceId,
            d.id.split(":")[1] ?? "",
          );
          checkDevelopment(
            w,
            task,
            d.actor,
            d.id.includes(":cancel:"),
            d.id.includes(":status:"),
          );
        } catch {
          d.state = "cancelled";
          return;
        }
      }
      const run = d.runId ? w.runs.find((r) => r.id === d.runId) : undefined;
      if (
        w.deletion ||
        !eligible(w, d.actor) ||
        (d.runId && (!run || !runAllowed(w, run))) ||
        (d.chatId !== d.actor &&
          !w.chats.some((c) => c.id === d.chatId && c.active))
      ) {
        d.state = "cancelled";
        return;
      }
      if (d.nextAt && Date.parse(d.nextAt) > Date.now()) return;
      if (d.editOf) {
        const target = this.editTarget(w, d, deployment.bot?.id);
        if (!target || ["cancelled", "failed"].includes(target.state)) {
          d.state = "cancelled";
          return;
        }
        if (
          ["pending", "sending"].includes(target.state) ||
          w.deliveries.some(
            (other) =>
              other.id !== d.id &&
              other.editOf === d.editOf &&
              other.state === "sending",
          )
        )
          return;
        if (!target.remoteId) {
          // An uncertain original send cannot authorize a replacement message.
          d.state = "delivery_unknown";
          return;
        }
        if (target.botId !== deployment.bot?.id || target.editUnavailable) {
          d.state = "cancelled";
          return;
        }
        d.remoteId = target.remoteId;
      }
      d.state = "sending";
      d.botId = deployment.bot?.id;
      d.startedAt = new Date().toISOString();
      d.attempts++;
      return structuredClone(d);
    });
    if (!intent) return;
    try {
      // This last durable policy check precedes the external effect. In-flight revocation cannot undo a send.
      const current = await this.store.read(workspaceId);
      requireThat(
        await this.feedbackAllowed(current, intent),
        "delivery_revoked",
        403,
      );
      requireThat(
        !current.deletion &&
          eligible(current, intent.actor) &&
          (intent.chatId === intent.actor ||
            current.chats.some((c) => c.id === intent.chatId && c.active)) &&
          (!intent.runId ||
            current.runs.some(
              (r) => r.id === intent.runId && runAllowed(current, r),
            )),
        "delivery_revoked",
        403,
      );
      if (
        intent.id.startsWith("development:") &&
        /^development:[0-9a-f-]{36}:/.test(intent.id)
      ) {
        const task = await taskGet(
          this.store.pool,
          workspaceId,
          intent.id.split(":")[1] ?? "",
        );
        checkDevelopment(
          current,
          task,
          intent.actor,
          intent.id.includes(":cancel:"),
          intent.id.includes(":status:"),
        );
      }
      if (intent.editOf)
        requireThat(
          (await this.store.deployment()).bot?.id === intent.botId &&
            this.editTarget(current, intent, intent.botId)?.remoteId ===
              intent.remoteId,
          "delivery_revoked",
          403,
        );
      const sent = await (await this.setup.client()).call<{
        message_id: number;
      }>(
        intent.editOf
          ? "editMessageText"
          : intent.format === "rich"
            ? "sendRichMessage"
            : "sendMessage",
        {
          chat_id: intent.chatId,
          ...(intent.editOf ? { message_id: intent.remoteId } : {}),
          ...(intent.format === "rich"
            ? { rich_message: telegramRichMessage(intent.text) }
            : intent.format === "markdown"
              ? telegramMarkdown(intent.text)
              : { text: intent.text }),
          message_thread_id: intent.editOf
            ? undefined
            : intent.topicId || undefined,
          reply_parameters:
            !intent.editOf && intent.replyTo
              ? {
                  message_id: intent.replyTo,
                  allow_sending_without_reply: true,
                }
              : undefined,
          reply_markup:
            intent.buttons || intent.editOf
              ? { inline_keyboard: intent.buttons ?? [] }
              : undefined,
          ...(intent.format === "rich"
            ? {}
            : { link_preview_options: { is_disabled: true } }),
        },
      );
      await this.finish(workspaceId, intent, (d) => {
        d.state = "sent";
        d.remoteId = intent.editOf ? intent.remoteId : sent.message_id;
      });
      this.store.log.write("delivery_sent", {
        workspaceId,
        runId: intent.runId,
      });
    } catch (error) {
      const unchanged =
        intent.editOf &&
        error instanceof TelegramError &&
        error.code === "telegram_message_not_modified";
      this.store.log.write(unchanged ? "delivery_sent" : "delivery_failed", {
        ...(unchanged ? {} : { error }),
        workspaceId,
        runId: intent.runId,
      });
      await this.finish(workspaceId, intent, (d, w) => {
        if (
          intent.editOf &&
          error instanceof TelegramError &&
          error.code === "telegram_message_not_modified"
        ) {
          d.state = "sent";
        } else if (
          intent.editOf &&
          error instanceof TelegramError &&
          error.code === "telegram_message_uneditable"
        ) {
          const target = w.deliveries.find((t) => t.id === intent.editOf);
          if (target) target.editUnavailable = true;
          // Telegram confirmed there is no editable message: one replacement is safe.
          d.editOf = undefined;
          d.remoteId = undefined;
          d.state = "pending";
          d.attempts = 0;
        } else if (
          intent.format === "rich" &&
          error instanceof TelegramError &&
          error.code === "telegram_destination_rejected" &&
          error.disposition === "permanent"
        ) {
          // A confirmed rejection is safe to retry using the established text transport.
          // Never fall back after an ambiguous send: that could duplicate a reply.
          d.format = "markdown";
          d.state = "pending";
        } else if (
          error instanceof TelegramError &&
          (error.disposition === "retry" ||
            (intent.editOf && error.disposition === "unknown")) &&
          d.attempts < 5
        ) {
          d.state = "pending";
          d.nextAt = new Date(
            Date.now() + Math.max(error.retryAfter, 2 ** d.attempts) * 1000,
          ).toISOString();
        } else if (
          error instanceof TelegramError &&
          error.disposition === "permanent"
        )
          d.state = "failed";
        else d.state = "delivery_unknown";
      });
    }
  }
  private async finish(
    workspaceId: string,
    intent: Delivery,
    action: (d: Delivery, w: Workspace) => void,
  ) {
    await this.store.change(workspaceId, (w) => {
      const d = w.deliveries.find((d) => d.id === intent.id);
      if (d?.state === "sending" && d.attempts === intent.attempts)
        action(d, w);
    });
  }
}
