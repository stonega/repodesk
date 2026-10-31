import {
  browserDeliveryAllowed,
  browserReadAllowed,
} from "../browser/privacy.ts";
import { taskGet } from "../coding/task-store.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { type Delivery, requireThat, type Workspace } from "../domain.ts";
import { repositoryDeliveryAllowed } from "../github/repository-context.ts";
import { googleDeliveryAllowed, googleReadAllowed } from "../google/policy.ts";
import { taskReference } from "../miniapp/auth.ts";
import { searchConsoleReadAllowed } from "../search-console/policy.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "../telegram/client.ts";
import { telegramMarkdown, telegramRichMessage } from "../telegram/format.ts";
import { reactionDeliveryAllowed } from "../telegram/reactions.ts";
import {
  cleanupTaskButtons,
  confirmTaskMessage,
  developmentMessageTask,
  latestTaskMessage,
  sameTaskAudience,
  withoutTaskControls,
} from "../telegram/task-control-messages.ts";
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
    if (d.browserRequest?.taskId) {
      try {
        const task = await taskGet(sql, w.id, d.browserRequest.taskId);
        if (
          task.cancelRequested ||
          task.state !== "working" ||
          task.actor !== d.actor ||
          task.chatId !== d.chatId ||
          task.browserWait?.id !== d.browserRequest.id ||
          d.browserRequest.expiresAt <= Date.now()
        )
          return false;
      } catch {
        return false;
      }
    } else if (
      d.browserRequest &&
      (!d.runId ||
        d.browserRequest.expiresAt <= Date.now() ||
        !w.runs.some(
          (run) =>
            run.id === d.runId &&
            run.browserWait?.id === d.browserRequest?.id &&
            run.actor === d.actor &&
            run.chatId === d.chatId &&
            !run.cancelled &&
            ["running", "awaiting_approval"].includes(run.status),
        ))
    )
      return false;
    if (
      d.browserRead &&
      !browserDeliveryAllowed(w, d, (await this.store.deployment(sql)).bot?.id)
    )
      return false;
    if (d.reaction) {
      const deployment = await this.store.deployment(sql);
      if (
        !deployment.active ||
        deployment.paused ||
        !reactionDeliveryAllowed(w, d, deployment.bot?.id)
      )
        return false;
    }
    if (
      d.googleControl &&
      !googleDeliveryAllowed(w, d, (await this.store.deployment(sql)).bot?.id)
    )
      return false;
    if (d.runId) {
      const run = w.runs.find((r) => r.id === d.runId);
      const botId = (await this.store.deployment(sql)).bot?.id;
      if (
        run &&
        (!browserReadAllowed(w, run, botId) ||
          !googleReadAllowed(w, run, botId) ||
          !searchConsoleReadAllowed(w, run, botId))
      )
        return false;
    }
    if (!repositoryDeliveryAllowed(w, d)) return false;
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
    // Old queued chat notices must also stay silent after an upgrade.
    if (d.feedback?.owner === "run") return false;
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
    return true;
  }
  async send(workspaceId: string, id: string) {
    const deployment = await this.store.deployment();
    if (deployment.paused) return;
    const intent = await this.store.change(workspaceId, async (w, sql) => {
      const d = w.deliveries.find((d) => d.id === id);
      if (!d || !["pending", "sending"].includes(d.state)) return;
      if (
        d.state === "pending" &&
        d.browserRequest &&
        !d.browserRequest.taskId &&
        w.runs.some(
          (run) =>
            run.id === d.runId &&
            run.browserWait?.id === d.browserRequest?.id &&
            run.status === "running",
        )
      )
        return;
      if (d.state === "sending") {
        if (Date.parse(d.startedAt ?? "") + 30000 < Date.now()) {
          // Edits and setting the same reaction can be replayed after a worker crash.
          if (d.reaction) d.state = d.attempts >= 5 ? "failed" : "pending";
          else
            d.state =
              d.editOf || d.taskControlsCleanup
                ? "pending"
                : "delivery_unknown";
        }
        return;
      }
      if (!(await this.feedbackAllowed(w, d, sql))) {
        d.state = "cancelled";
        return;
      }
      if (d.repositoryMenu && d.botId !== deployment.bot?.id) {
        d.state = "cancelled";
        return;
      }
      if (d.taskControlsCleanup && d.botId !== deployment.bot?.id) {
        d.state = "cancelled";
        return;
      }
      const taskId = developmentMessageTask(d);
      if (
        taskId &&
        w.deliveries.some(
          (other) =>
            other.id !== d.id &&
            other.state === "sending" &&
            Date.parse(other.startedAt ?? "1970-01-01") > Date.now() - 30000 &&
            sameTaskAudience(other, { ...d, botId: deployment.bot?.id }),
        )
      )
        return;
      if (taskId) {
        try {
          const task = await taskGet(sql, workspaceId, taskId);
          requireThat(
            task.botId === deployment.bot?.id,
            "delivery_revoked",
            403,
          );
          checkDevelopment(
            w,
            task,
            d.actor,
            d.id.includes(":cancel:") ||
              (!!d.taskControlsCleanup &&
                task.cancelRequested &&
                task.actor === d.actor),
            d.id.includes(":status:") || !!d.taskControlsCleanup,
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
      if (d.taskControlsCleanup) {
        const buttons = cleanupTaskButtons(w, d);
        if (buttons === undefined) {
          d.state = "cancelled";
          return;
        }
        d.buttons = buttons;
      }
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
      if (intent.repositoryMenu)
        requireThat(
          intent.botId === (await this.store.deployment()).bot?.id,
          "delivery_revoked",
          403,
        );
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
      if (intent.reaction) {
        await (await this.setup.client(deployment)).call<boolean>(
          "setMessageReaction",
          {
            chat_id: intent.chatId,
            message_id: intent.reaction.messageId,
            reaction: [{ type: "emoji", emoji: intent.reaction.emoji }],
            is_big: false,
          },
        );
        await this.finish(workspaceId, intent, (d) => {
          d.state = "sent";
        });
        this.store.log.write("delivery_sent", {
          workspaceId,
          runId: intent.runId,
        });
        return;
      }
      const taskId = developmentMessageTask(intent);
      if (taskId) {
        const task = await taskGet(this.store.pool, workspaceId, taskId);
        requireThat(
          task.botId === deployment.bot?.id &&
            (await this.store.deployment()).bot?.id === intent.botId,
          "delivery_revoked",
          403,
        );
        checkDevelopment(
          current,
          task,
          intent.actor,
          intent.id.includes(":cancel:") ||
            (!!intent.taskControlsCleanup &&
              task.cancelRequested &&
              task.actor === intent.actor),
          intent.id.includes(":status:") || !!intent.taskControlsCleanup,
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
      let buttons = intent.buttons;
      if (intent.taskControlsCleanup) {
        buttons = cleanupTaskButtons(current, intent);
        if (buttons === undefined) {
          await this.finish(workspaceId, intent, (d) => {
            d.state = "cancelled";
          });
          return;
        }
      } else if (taskId && intent.editOf) {
        const latest = latestTaskMessage(current, intent);
        if (latest && latest.remoteId !== intent.remoteId)
          buttons = withoutTaskControls(buttons, taskId);
      }
      const developmentId = /^development:([0-9a-f-]{36}):/.exec(
        intent.id,
      )?.[1];
      if (developmentId && deployment.bot?.username) {
        buttons = [
          ...(buttons ?? []),
          [
            {
              text: "View conversation",
              url: `https://t.me/${deployment.bot.username}?startapp=${taskReference(workspaceId, developmentId)}`,
            },
          ],
        ];
      }
      intent.buttons = buttons;
      const sent = await (await this.setup.client()).call<{
        message_id: number;
      }>(
        intent.taskControlsCleanup
          ? "editMessageReplyMarkup"
          : intent.editOf
            ? "editMessageText"
            : intent.format === "rich"
              ? "sendRichMessage"
              : "sendMessage",
        intent.taskControlsCleanup
          ? {
              chat_id: intent.chatId,
              message_id: intent.remoteId,
              reply_markup: { inline_keyboard: buttons ?? [] },
            }
          : {
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
                buttons || intent.editOf
                  ? { inline_keyboard: buttons ?? [] }
                  : undefined,
              ...(intent.format === "rich"
                ? {}
                : { link_preview_options: { is_disabled: true } }),
            },
      );
      await this.finish(workspaceId, intent, (d) => {
        d.state = "sent";
        d.remoteId =
          intent.editOf || intent.taskControlsCleanup
            ? intent.remoteId
            : sent.message_id;
      });
      this.store.log.write("delivery_sent", {
        workspaceId,
        runId: intent.runId,
      });
    } catch (error) {
      const unchanged =
        (intent.editOf || intent.taskControlsCleanup) &&
        error instanceof TelegramError &&
        error.code === "telegram_message_not_modified";
      this.store.log.write(unchanged ? "delivery_sent" : "delivery_failed", {
        ...(unchanged ? {} : { error }),
        workspaceId,
        runId: intent.runId,
      });
      await this.finish(workspaceId, intent, (d, w) => {
        if (
          (intent.editOf || intent.taskControlsCleanup) &&
          error instanceof TelegramError &&
          error.code === "telegram_message_not_modified"
        ) {
          d.state = "sent";
        } else if (
          intent.taskControlsCleanup &&
          error instanceof TelegramError &&
          error.code === "telegram_message_uneditable"
        ) {
          d.state = "failed";
          for (const old of w.deliveries)
            if (
              sameTaskAudience(old, intent) &&
              old.remoteId === intent.remoteId
            )
              old.editUnavailable = true;
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
            ((intent.editOf || intent.taskControlsCleanup || intent.reaction) &&
              error.disposition === "unknown")) &&
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
        else d.state = intent.reaction ? "failed" : "delivery_unknown";
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
      if (d?.state === "sending" && d.attempts === intent.attempts) {
        action(d, w);
        confirmTaskMessage(w, d, intent.buttons);
      }
    });
  }
}
