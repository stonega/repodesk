import type { Store } from "../db/repositories.ts";
import {
  type Delivery,
  type Deployment,
  requireThat,
  type Workspace,
} from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { TelegramError } from "../telegram/client.ts";
import { telegramMarkdown, telegramRichMessage } from "../telegram/format.ts";
import {
  privateTopicFallback,
  privateTopicFallbackText,
} from "../telegram/topic-fallback.ts";
import { eligible, runAllowed } from "../workspaces/policy.ts";
import {
  type DeliveryPolicyRegistry,
  defaultDeliveryPolicies,
} from "./delivery-policies.ts";

export class DeliveryWorker {
  constructor(
    private store: Store,
    private setup: SetupService,
    private policies: DeliveryPolicyRegistry = defaultDeliveryPolicies(),
  ) {}

  private browserStatusBeforeSend(
    workspaceId: string,
    intent: Delivery,
    bot: Deployment["bot"],
  ) {
    return this.store.change(workspaceId, async (w, sql) => {
      const d = w.deliveries.find((d) => d.id === intent.id);
      if (
        d?.state !== "sending" ||
        d.attempts !== intent.attempts ||
        d.actor !== intent.actor ||
        d.chatId !== intent.chatId ||
        d.topicId !== intent.topicId ||
        d.runId !== intent.runId ||
        d.botId !== intent.botId ||
        !d.browserTaskState?.refresh
      )
        return;
      this.policies.hooks.refreshBeforeClaim(w, d, bot);
      if (!(await this.policies.allowed(this.store, w, d, sql))) {
        d.state = "cancelled";
        return;
      }
      const fresh = structuredClone(d);
      intent.text = fresh.text;
      intent.buttons = fresh.buttons;
      intent.browserTaskState = fresh.browserTaskState;
      return structuredClone(w);
    });
  }

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

  async send(workspaceId: string, id: string) {
    const deployment = await this.store.deployment();
    if (deployment.paused) return;
    const intent = await this.store.change(workspaceId, async (w, sql) => {
      const d = w.deliveries.find((d) => d.id === id);
      if (!d || !["pending", "sending"].includes(d.state)) return;
      if (d.state === "pending")
        this.policies.hooks.refreshBeforeClaim(w, d, deployment.bot);
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
      if (this.policies.hooks.shouldDeferClaim(w, d, deployment.bot?.id))
        return;
      if (!(await this.policies.allowed(this.store, w, d, sql))) {
        d.state = "cancelled";
        return;
      }
      if (
        (d.repositoryMenu || d.taskControlsCleanup) &&
        d.botId !== deployment.bot?.id
      ) {
        d.state = "cancelled";
        return;
      }
      try {
        await this.policies.hooks.validateTaskAudience(
          sql,
          w,
          d,
          deployment.bot?.id,
        );
      } catch {
        d.state = "cancelled";
        return;
      }
      const run = d.runId ? w.runs.find((r) => r.id === d.runId) : undefined;
      if (
        (d.privateTopicFallback &&
          !privateTopicFallback(w, d, deployment.bot?.id)) ||
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
        const prepared = this.policies.hooks.prepareButtons(
          workspaceId,
          w,
          d,
          deployment.bot,
        );
        if (prepared.cancelled) {
          d.state = "cancelled";
          return;
        }
        d.buttons = prepared.buttons;
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
      // Recovery uses the standard text transport verified visible in the main chat.
      // Persist this before sending, including intents queued by an older worker.
      if (d.privateTopicFallback) d.format = "markdown";
      d.state = "sending";
      d.botId = deployment.bot?.id;
      d.startedAt = new Date().toISOString();
      d.attempts++;
      return structuredClone(d);
    });
    if (!intent) return;
    try {
      // This last durable policy check precedes the external effect. In-flight revocation cannot undo a send.
      const current = intent.browserTaskState?.refresh
        ? await this.browserStatusBeforeSend(
            workspaceId,
            intent,
            deployment.bot,
          )
        : await this.store.read(workspaceId);
      if (!current) return;
      if (intent.privateTopicFallback) {
        const freshDeployment = await this.store.deployment();
        if (
          !freshDeployment.active ||
          freshDeployment.paused ||
          !privateTopicFallback(current, intent, freshDeployment.bot?.id)
        ) {
          await this.finish(workspaceId, intent, (d) => {
            d.state = "cancelled";
          });
          return;
        }
      }
      if (intent.repositoryMenu)
        requireThat(
          intent.botId === (await this.store.deployment()).bot?.id,
          "delivery_revoked",
          403,
        );
      requireThat(
        await this.policies.allowed(this.store, current, intent),
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
      if (intent.widget && !intent.widgetFallback) {
        const sent = await (await this.setup.client(deployment)).call<{
          message_id: number;
        }>("sendWidget", {
          chat_id: intent.chatId,
          message_thread_id: intent.topicId || undefined,
          html: intent.widget.html,
          caption: intent.widget.caption,
          width: intent.widget.width,
          height: intent.widget.height,
          allow_queries: false,
          is_shared: false,
          protect_content: true,
          reply_parameters: intent.replyTo
            ? { message_id: intent.replyTo, allow_sending_without_reply: true }
            : undefined,
        });
        await this.finish(workspaceId, intent, (d) => {
          d.state = "sent";
          d.remoteId = sent.message_id;
        });
        this.store.log.write("delivery_sent", {
          workspaceId,
          runId: intent.runId,
        });
        return;
      }
      await this.policies.hooks.validateTaskAudience(
        this.store.pool,
        current,
        intent,
        deployment.bot?.id,
        async () => (await this.store.deployment()).bot?.id,
      );
      if (intent.editOf)
        requireThat(
          (await this.store.deployment()).bot?.id === intent.botId &&
            this.editTarget(current, intent, intent.botId)?.remoteId ===
              intent.remoteId,
          "delivery_revoked",
          403,
        );
      const preparedButtons = this.policies.hooks.prepareButtons(
        workspaceId,
        current,
        intent,
        deployment.bot,
      );
      if (preparedButtons.cancelled) {
        await this.finish(workspaceId, intent, (d) => {
          d.state = "cancelled";
        });
        return;
      }
      const buttons = preparedButtons.buttons;
      intent.buttons = buttons;
      const text = intent.privateTopicFallback
        ? privateTopicFallbackText(intent.text)
        : intent.text;
      const sent = await (await this.setup.client(deployment)).call<{
        message_id: number;
        message_thread_id?: number;
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
                ? { rich_message: telegramRichMessage(text) }
                : intent.format === "markdown"
                  ? telegramMarkdown(text)
                  : { text }),
              message_thread_id:
                intent.editOf || intent.privateTopicFallback
                  ? undefined
                  : intent.topicId || undefined,
              reply_parameters:
                !intent.editOf && !intent.privateTopicFallback && intent.replyTo
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
        d.deliveredTopicId =
          sent.message_thread_id ??
          (intent.privateTopicFallback ? 0 : intent.topicId);
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
          error instanceof TelegramError &&
          error.code === "telegram_thread_not_found" &&
          error.disposition === "permanent"
        ) {
          const consent = privateTopicFallback(w, d, deployment.bot?.id);
          if (!d.privateTopicFallback && consent) {
            // Telegram confirmed no send occurred. Persist the changed wire destination
            // before retrying; membership and consent are checked again after restart.
            d.privateTopicFallback = consent;
            d.state = "pending";
          } else d.state = "failed";
        } else if (
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
          this.policies.hooks.markTaskUneditable(w, intent);
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
          intent.widget &&
          !intent.widgetFallback &&
          error instanceof TelegramError &&
          error.code === "telegram_destination_rejected" &&
          error.disposition === "permanent"
        ) {
          d.widgetFallback = true;
          d.state = "pending";
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
        else if (
          intent.widget &&
          error instanceof TelegramError &&
          error.disposition === "retry"
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
        this.policies.hooks.onComplete(w, d, intent.buttons);
      }
    });
  }
}
