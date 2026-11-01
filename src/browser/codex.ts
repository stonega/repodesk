import { z } from "zod";
import { deploymentOrigin } from "../admin/site.ts";
import { taskGet, taskSave } from "../coding/task-store.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { deliver } from "../workspaces/service.ts";
import { browserAccessRequest } from "./access.ts";
import {
  type BrowserCapability,
  signBrowserCapability,
  verifyBrowserCapability,
} from "./capability.ts";
import {
  type BrowserController,
  type BrowserOwner,
  browserEnabled,
  browserGeneration,
} from "./config.ts";
import { authorizeBrowserOwner } from "./policy.ts";
import { browserEpoch } from "./privacy.ts";
import type { BrowserConsumer, BrowserService } from "./service.ts";

const invocation = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("invoke"),
      callId: z.string().min(1).max(200),
      tool: z.enum(["browser_action", "browser_session"]),
      input: z.unknown(),
    })
    .strict(),
  z.object({ command: z.literal("poll"), id: z.uuid() }).strict(),
]);
/** The runner receives a single-attempt capability, never a host key or profile socket. */
export class CodexBrowsers {
  constructor(
    private store: Store,
    private browser: BrowserService,
    private key: string,
    private origin: string,
    private internalOrigin?: string,
  ) {
    browser.registerConsumer(
      "codex",
      (owner, controller, configuration, epoch) =>
        this.consumer(owner, controller, configuration, epoch),
    );
  }
  async capability(workspaceId: string, taskId: string) {
    if (!this.browser.configured) return;
    const w = await this.store.read(workspaceId),
      task = await taskGet(this.store.pool, workspaceId, taskId),
      d = await this.store.deployment();
    if (
      !browserEnabled(w) ||
      task.chatId !== task.actor ||
      !task.attemptId ||
      !d.bot ||
      task.state !== "working"
    )
      return;
    checkDevelopment(w, task);
    const proposed: BrowserCapability = {
      workspaceId,
      actor: task.actor,
      taskId: task.id,
      attemptId: task.attemptId,
      fence: task.fence,
      configuration: browserGeneration(w),
      epoch: browserEpoch(w, task.actor),
      botId: d.bot.id,
      expiresAt: Date.now() + 4 * 3600_000,
    };
    const origin = this.internalOrigin
      ? new URL(this.internalOrigin).origin
      : deploymentOrigin(d, this.origin);
    // Keep the exact start payload stable across an uncertain runner acknowledgement.
    const input = await this.store.change(workspaceId, async (current, sql) => {
      const saved = await taskGet(sql, workspaceId, taskId);
      requireThat(
        saved.attemptId === task.attemptId && saved.fence === task.fence,
        "browser_control_expired",
        409,
      );
      checkDevelopment(current, saved);
      if (
        saved.browserCapability &&
        saved.browserCapability.attemptId === saved.attemptId
      )
        return {
          capability: saved.browserCapability,
          origin: saved.browserBridgeOrigin ?? origin,
        };
      saved.browserCapability = proposed;
      saved.browserBridgeOrigin = origin;
      await taskSave(sql, saved);
      return { capability: proposed, origin };
    });
    return {
      url: `${input.origin}/browser-api/codex`,
      token: signBrowserCapability(this.key, input.capability),
    };
  }
  async title(owner: BrowserOwner, taskId: string) {
    const w = await this.store.read(owner.workspaceId),
      task = await taskGet(this.store.pool, owner.workspaceId, taskId);
    checkDevelopment(w, task, owner.actor, false, true);
    requireThat(
      task.actor === owner.actor && task.chatId === owner.actor,
      "browser_private_task_required",
      403,
    );
    return task.payload.title.slice(0, 240);
  }
  private async consumer(
    owner: BrowserOwner,
    controller: BrowserController,
    configuration: number,
    epoch: number,
  ): Promise<BrowserConsumer> {
    let botId = (await this.store.deployment()).bot?.id;
    requireThat(botId, "browser_consumer_unavailable", 503);
    const guard = async (phase: "active" | "waiting") => {
      const w = await this.store.read(owner.workspaceId),
        task = await taskGet(this.store.pool, owner.workspaceId, controller.id),
        d = await this.store.deployment();
      authorizeBrowserOwner(w, owner.actor);
      checkDevelopment(w, task);
      requireThat(
        controller.kind === "codex" &&
          task.actor === owner.actor &&
          task.chatId === owner.actor &&
          !task.contentRemoved &&
          !task.cancelRequested &&
          task.state === "working" &&
          task.fence === controller.fence &&
          task.attemptId &&
          d.active &&
          !d.paused &&
          d.bot?.id === task.botId,
        "browser_consumer_unavailable",
        403,
      );
      requireThat(
        browserGeneration(w) === configuration &&
          browserEpoch(w, owner.actor) === epoch,
        "browser_configuration_changed",
        409,
      );
      if (phase === "waiting")
        requireThat(task.browserWait, "browser_task_not_waiting", 409);
      botId = task.botId;
    };
    const consumer: BrowserConsumer = {
      owner,
      controller,
      configuration,
      epoch,
      botId,
      guard,
      waiting: async (id) => {
        await guard("waiting");
        requireThat(
          (await taskGet(this.store.pool, owner.workspaceId, controller.id))
            .browserWait?.id === id,
          "browser_request_unavailable",
          409,
        );
      },
      markPrivate: async () => {
        await guard("active");
        await this.store.change(owner.workspaceId, async (w, sql) => {
          const t = await taskGet(sql, w.id, controller.id);
          requireThat(
            t.fence === controller.fence &&
              t.state === "working" &&
              !t.cancelRequested,
            "browser_control_expired",
            409,
          );
          t.browserRead = {
            owner: owner.actor,
            generation: configuration,
            epoch,
            botId: t.botId,
          };
          await taskSave(sql, t);
        });
      },
      pause: async (request, callId) => {
        await guard("active");
        await this.store.change(owner.workspaceId, async (w, sql) => {
          const t = await taskGet(sql, w.id, controller.id);
          requireThat(
            t.fence === controller.fence &&
              t.state === "working" &&
              !t.cancelRequested,
            "browser_control_expired",
            409,
          );
          t.browserWait = { ...request, callId };
          await taskSave(sql, t);
          const d = await this.store.deployment(sql);
          if (d.bot?.username) {
            const id = deliver(
              w,
              owner.actor,
              owner.actor,
              "Codex needs browser input or approval. Open Browser to continue.",
              {
                id: `browser:${request.id}`,
                buttons: [
                  [
                    {
                      text: "Open Browser",
                      url: `https://t.me/${d.bot.username}?startapp=browser_${owner.workspaceId.replaceAll("-", "")}`,
                    },
                  ],
                ],
              },
            );
            const notification = w.deliveries.find((item) => item.id === id);
            if (notification) {
              notification.browserRead = t.browserRead;
              notification.browserRequest = {
                id: request.id,
                expiresAt: request.expiresAt,
                taskId: t.id,
              };
            }
          }
        });
      },
      complete: async (callId, id, result) => {
        const t = await taskGet(
          this.store.pool,
          owner.workspaceId,
          controller.id,
        );
        if (t.browserResumed?.includes(id)) return true;
        await consumer.waiting(id);
        await this.browser.saveReceipt(
          consumer,
          id,
          callId,
          browserAccessRequest.shape.result.unwrap().parse(result),
        );
        await this.store.change(owner.workspaceId, async (w, sql) => {
          const current = await taskGet(sql, w.id, controller.id);
          requireThat(
            current.fence === controller.fence &&
              current.browserWait?.id === id,
            "browser_control_expired",
            409,
          );
          delete current.browserWait;
          current.browserResumed = [
            ...(current.browserResumed ?? []),
            id,
          ].slice(-256);
          await taskSave(sql, current);
        });
        return true;
      },
    };
    return consumer;
  }
  async invoke(token: string, value: unknown, signal?: AbortSignal) {
    const cap = verifyBrowserCapability(this.key, token),
      input = invocation.parse(value);
    const task = await taskGet(this.store.pool, cap.workspaceId, cap.taskId);
    requireThat(
      task.attemptId === cap.attemptId &&
        task.fence === cap.fence &&
        task.actor === cap.actor &&
        task.botId === cap.botId,
      "browser_control_expired",
      403,
    );
    const consumer = await this.consumer(
      { workspaceId: cap.workspaceId, actor: cap.actor },
      { kind: "codex", id: cap.taskId, fence: cap.fence },
      cap.configuration,
      cap.epoch,
    );
    await consumer.guard("active");
    if (input.command === "poll") {
      const result = await this.browser.receipt(consumer, input.id);
      if (result) return result;
      await consumer.waiting(input.id);
      return { status: "waiting", requestId: input.id };
    }
    if (task.browserWait) {
      requireThat(
        task.browserWait.callId === input.callId,
        "browser_input_pending",
        409,
      );
      return { status: "waiting", requestId: task.browserWait.id };
    }
    return this.browser.consume(
      consumer,
      input.tool,
      input.input,
      input.callId,
      signal,
    );
  }
}
