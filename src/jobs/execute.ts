import { createHash, randomInt, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactTopic } from "../agent/compaction.ts";
import { buildContext, validateSources } from "../agent/context.ts";
import { extensionToolExecution } from "../agent/extension-execution.ts";
import { classifyFollowup } from "../agent/followup.ts";
import { remainingBudgets } from "../agent/limits.ts";
import { DEFAULT_MODEL_BASE_URL } from "../agent/model-settings.ts";
import {
  type AgentInput,
  type AgentRunner,
  modelCapabilities,
  PiRunner,
  type RunnerProvider,
  selectedModel,
} from "../agent/runtime.ts";
import { applicationTools } from "../agent/tools.ts";
import { DEFAULT_RUN_TIMEOUT_SECONDS } from "../config.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat } from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { attachmentErrors, loadAttachments } from "../telegram/attachments.ts";
import { TelegramDraft } from "../telegram/draft.ts";
import {
  clearProgress,
  notifyRunFailure,
  requestFailureMessage,
} from "../telegram/feedback.ts";
import { discardFollowup } from "../telegram/followup.ts";
import { commitDiscussions } from "../workspaces/conversation-memory.ts";
import { audit, runAllowed } from "../workspaces/policy.ts";
import { confirmRunStopped, deliver } from "../workspaces/service.ts";
import {
  recordThreadAnswer,
  refreshThreadContext,
} from "../workspaces/threads.ts";
export class Executor {
  constructor(
    private store: Store,
    private setup: SetupService,
    private runner: AgentRunner | RunnerProvider = new PiRunner(),
    private timeoutMs = DEFAULT_RUN_TIMEOUT_SECONDS * 1000,
  ) {}
  async execute(workspaceId: string, runId: string, shutdown?: AbortSignal) {
    const deployment = await this.store.deployment();
    if (!deployment.active || deployment.paused) return;
    const extensionWorkspace = await this.store.read(workspaceId);
    const pluginRevision = extensionWorkspace.plugins?.revision ?? 0;
    const codingRevision = extensionWorkspace.coding?.revision ?? 0;
    let runner: AgentRunner;
    let chatModel: Awaited<ReturnType<SetupService["models"]["chat"]>>;
    try {
      chatModel = await this.setup.models.chat(extensionWorkspace);
      runner =
        typeof this.runner === "function"
          ? await this.runner(deployment, workspaceId)
          : this.runner;
    } catch (error) {
      await this.store.change(workspaceId, (w) => {
        const run = w.runs.find((r) => r.id === runId);
        if (run?.status === "queued") {
          run.status = "failed";
          run.error =
            error instanceof Fault
              ? error.code
              : "extension_configuration_invalid";
          run.finishedAt = new Date().toISOString();
          discardFollowup(w, run);
          notifyRunFailure(w, run);
        }
      });
      return;
    }
    const claimed = await this.store.change(workspaceId, (w) => {
      const r = w.runs.find((r) => r.id === runId);
      if (!r || !["queued", "running"].includes(r.status)) return;
      if (!runAllowed(w, r)) {
        r.status = "cancelled";
        r.cancelled = true;
        discardFollowup(w, r);
        return;
      }
      if (r.status === "running" && Date.parse(r.leaseUntil ?? "") > Date.now())
        throw new Fault("run_busy", 409);
      if (
        w.runs.some(
          (other) =>
            other.id !== r.id &&
            other.conversation === r.conversation &&
            other.status === "running" &&
            Date.parse(other.leaseUntil ?? "") > Date.now(),
        )
      )
        if (r.threadId) return;
        else throw new Fault("conversation_busy", 409);
      // A waiting job completes cheaply; recovery redispatches it without spending
      // queue retries. Insertion order is durable even for equal timestamps.
      if (
        r.threadId &&
        w.runs
          .slice(0, w.runs.indexOf(r))
          .some(
            (other) =>
              other.threadId === r.threadId &&
              ["queued", "running"].includes(other.status),
          )
      )
        return;
      if (r.attempts.some((a) => a.status !== "settled")) {
        r.status = "failed";
        r.error = "provider_outcome_unknown";
        r.finishedAt = new Date().toISOString();
        for (const a of r.attempts)
          if (a.status === "reserved") a.status = "unknown";
        discardFollowup(w, r);
        audit(w, r.actor, "run.recovery_required", r.id);
        notifyRunFailure(w, r);
        return;
      }
      if (chatModel && !r.modelProvider && !r.attempts.length) {
        r.model = chatModel.model;
        r.modelOptions = chatModel.options;
        r.modelProvider = chatModel.provider;
      }
      r.modelOptions ??= {
        modelBaseUrl: deployment.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL,
        thinkingLevel: deployment.thinkingLevel ?? "off",
        modelPricing: deployment.modelPricing,
        modelLimits: modelCapabilities(r.model, deployment)?.limits,
      };
      if (r.extensionVersion === undefined && !r.transcript.length)
        r.extensionVersion = runner.extensionVersion ?? "none";
      if (
        (r.extensionVersion ?? "none") !== (runner.extensionVersion ?? "none")
      ) {
        r.status = "failed";
        r.error = "extension_configuration_changed";
        r.finishedAt = new Date().toISOString();
        discardFollowup(w, r);
        notifyRunFailure(w, r);
        return;
      }
      refreshThreadContext(w, r);
      r.status = "running";
      clearProgress(w, "run", r.id);
      r.fence++;
      r.telegramDraft =
        r.chatId === r.actor && !r.workflowId && deployment.bot
          ? {
              id: randomInt(1, 2 ** 48 - 1),
              botId: deployment.bot.id,
              fence: r.fence,
            }
          : undefined;
      r.leaseUntil = new Date(Date.now() + 120000).toISOString();
      return structuredClone(r);
    });
    if (!claimed) return;
    const fence = claimed.fence;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([
      controller.signal,
      deadline,
      ...(shutdown ? [shutdown] : []),
    ]);
    let handedOff = !!claimed.codingTaskId;
    const guard = async () => {
      signal.throwIfAborted();
      const d = await this.store.deployment();
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      if (claimed.modelProvider) {
        await this.setup.models.modelKey(
          claimed.modelProvider.operatorId,
          claimed.modelProvider.id,
          claimed.modelProvider.version,
        );
      } else {
        requireThat(
          (d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL) ===
            claimed.modelOptions?.modelBaseUrl,
          "model_endpoint_changed",
          409,
        );
      }
      await this.store.change(workspaceId, (w) => {
        if (claimed.modelProvider)
          requireThat(
            w.operatorId === claimed.modelProvider.operatorId &&
              w.chatModel?.selection.providerId === claimed.modelProvider.id &&
              (claimed.modelProvider.chatRevision === undefined ||
                w.chatModel?.revision === claimed.modelProvider.chatRevision),
            "model_configuration_changed",
            409,
          );
        requireThat(
          (w.plugins?.revision ?? 0) === pluginRevision &&
            (w.coding?.revision ?? 0) === codingRevision,
          "extension_configuration_changed",
          409,
        );
        const r = w.runs.find((r) => r.id === runId);
        requireThat(
          r && r.fence === fence && r.status === "running" && runAllowed(w, r),
          "run_revoked",
          409,
        );
        handedOff = !!r.codingTaskId;
        r.leaseUntil = new Date(Date.now() + 120000).toISOString();
      });
    };
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      guard()
        .catch((error) => controller.abort(error))
        .finally(() => {
          polling = false;
        });
    }, 1000);
    poll.unref();
    let compacting = false;
    let classifying = false;
    const checkpoint = async (message: AgentMessage, attemptId?: string) => {
      await this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        requireThat(r && r.fence === fence, "lease_lost", 409);
        // Usage must settle even when cancellation arrived during the provider request.
        if (message.role === "assistant" && attemptId) {
          const a = r.attempts.find((a) => a.id === attemptId);
          if (a) {
            if (["error", "aborted"].includes(message.stopReason))
              a.status = "unknown";
            else {
              a.status = "settled";
              a.actual = Math.max(0, message.usage.cost.total);
              a.tokens = {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
              };
            }
          }
        }
        if (!w.deletion && runAllowed(w, r)) {
          if (classifying) r.followup?.transcript.push(message);
          else if (compacting) r.compaction?.transcript.push(message);
          else r.transcript.push(message);
        }
      });
    };
    this.store.log.write("run_started", { workspaceId, runId });
    const draft = claimed.telegramDraft
      ? new TelegramDraft(
          { ...claimed, draftId: claimed.telegramDraft.id },
          () => this.setup.client(deployment),
          async () => {
            await guard();
            requireThat(
              (await this.store.deployment()).credentials.bot ===
                deployment.credentials.bot,
              "run_revoked",
              409,
            );
          },
          (text) => validateSources(text, claimed),
          signal,
          Date.now,
          (event, error) =>
            this.store.log.write(event, { error, workspaceId, runId }),
        )
      : undefined;
    try {
      await guard();
      const w = await this.store.read(workspaceId);
      let context = buildContext(w, claimed);
      const transcript = claimed.transcript as AgentMessage[];
      // Restore only complete transcript boundaries. Tool effects and outcomes are committed atomically.
      const tail = transcript.at(-1);
      const assistantIndex = transcript.findLastIndex(
        (m) => m.role === "assistant",
      );
      const assistant = transcript[assistantIndex];
      if (
        assistant?.role === "assistant" &&
        assistant.stopReason === "toolUse"
      ) {
        const results = new Set(
          transcript
            .slice(assistantIndex + 1)
            .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
        );
        for (const call of assistant.content)
          if (call.type === "toolCall" && !results.has(call.id)) {
            const outcome = claimed.tools[call.id];
            requireThat(
              outcome?.state === "done",
              "incomplete_tool_checkpoint",
              409,
            );
            const result = outcome.result as {
              content: { type: "text"; text: string }[];
            };
            const message: AgentMessage = {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content,
              isError: false,
              timestamp: Date.now(),
            };
            transcript.push(message);
            await checkpoint(message);
          }
      }
      const completed =
        tail?.role === "assistant" && tail.stopReason === "stop";
      requireThat(
        completed || claimed.attempts.length < claimed.settings.maxTurns,
        "turn_limit",
        409,
      );
      if (!completed) await draft?.start();
      const input: AgentInput = {
        cacheKey: claimed.threadId
          ? createHash("sha256")
              .update(`${workspaceId}:${claimed.threadId}`)
              .digest("hex")
          : undefined,
        workspaceId,
        actor: claimed.actor,
        runId,
        model: selectedModel(claimed.model, claimed.modelOptions),
        apiKey: claimed.modelProvider
          ? await this.setup.models.modelKey(
              claimed.modelProvider.operatorId,
              claimed.modelProvider.id,
              claimed.modelProvider.version,
            )
          : await this.setup.modelKey(claimed.modelOptions?.modelBaseUrl),
        thinkingLevel: claimed.modelOptions?.thinkingLevel,
        system: context.system,
        prompt: context.prompt,
        transcript,
        tools: applicationTools(this.store, workspaceId, runId, fence),
        extensionTool: extensionToolExecution(
          this.store,
          workspaceId,
          runId,
          fence,
          signal,
        ),
        maxTurns: Math.max(
          1,
          claimed.settings.maxTurns - claimed.attempts.length,
        ),
        remainingBudget: async () => {
          const w = await this.store.read(workspaceId);
          const r = w.runs.find((r) => r.id === runId);
          requireThat(
            r && r.fence === fence && runAllowed(w, r),
            "run_revoked",
            409,
          );
          return remainingBudgets(w, r);
        },
        signal,
        guard,
        reserve: async (amount) =>
          this.store.change(workspaceId, (w) => {
            const r = w.runs.find((r) => r.id === runId);
            requireThat(
              r && r.fence === fence && runAllowed(w, r),
              "run_revoked",
              409,
            );
            const budgets = remainingBudgets(w, r);
            requireThat(
              Number.isFinite(amount) && amount >= 0 && amount <= budgets.run,
              "run_budget_exhausted",
              409,
            );
            requireThat(
              amount <= budgets.workspace,
              "workspace_budget_exhausted",
              409,
            );
            const id = randomUUID();
            r.attempts.push({
              id,
              purpose: classifying
                ? "followup"
                : compacting
                  ? "compaction"
                  : undefined,
              reserved: amount,
              status: "reserved",
              at: new Date().toISOString(),
            });
            return id;
          }),
        shouldPause: async () =>
          (await this.store.read(workspaceId)).approvals.some(
            (a) => a.runId === runId && !a.decision,
          ),
        checkpoint,
        preview: draft
          ? async (text) => {
              if (handedOff) return;
              await draft.update(text);
            }
          : undefined,
      };
      if (claimed.followup && claimed.followup.decision !== "reply") {
        classifying = true;
        try {
          const checked = await classifyFollowup(
            this.store,
            workspaceId,
            runId,
            fence,
            runner,
            input,
          );
          Object.assign(claimed, checked);
          if (checked.followup?.decision !== "reply") return;
        } finally {
          classifying = false;
        }
      }
      if (!completed && !transcript.length) {
        compacting = true;
        try {
          Object.assign(
            claimed,
            await compactTopic(
              this.store,
              workspaceId,
              runId,
              fence,
              runner,
              input,
            ),
          );
        } finally {
          compacting = false;
        }
        context = buildContext(await this.store.read(workspaceId), claimed);
        input.system = context.system;
        input.prompt = context.prompt;
        input.maxTurns = Math.max(
          1,
          claimed.settings.maxTurns - claimed.attempts.length,
        );
      }
      if (!completed && !transcript.length) {
        const attachments = await loadAttachments(
          claimed,
          deployment.bot?.id,
          () => this.setup.client(deployment),
          async () => {
            await guard();
            const current = await this.store.deployment();
            requireThat(
              current.bot?.id === deployment.bot?.id &&
                current.credentials.bot === deployment.credentials.bot,
              "run_revoked",
              409,
            );
          },
          signal,
        );
        if (attachments.images.length)
          requireThat(
            input.model.input.includes("image"),
            "model_images_unsupported",
          );
        input.images = attachments.images;
        input.prompt += attachments.prompt;
      }
      const result = completed
        ? {
            text: tail.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
            status: "succeeded" as const,
          }
        : await runner.run(input);
      await guard();

      await this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        requireThat(
          r && r.fence === fence && runAllowed(w, r),
          "run_revoked",
          409,
        );
        if (result.text) validateSources(result.text, r);
        const proposals = w.approvals.some(
          (a) =>
            !a.decision &&
            a.runId === r.id &&
            Date.parse(a.expiresAt) > Date.now(),
        );
        const handoff = !!r.codingTaskId;
        const text = handoff
          ? "Your coding request has been queued for Codex. Task updates will appear in this conversation."
          : result.text.trim()
            ? result.text
            : "";
        r.status = proposals
          ? "awaiting_approval"
          : handoff
            ? "succeeded"
            : text
              ? result.status
              : "partial";
        r.error =
          proposals || handoff
            ? undefined
            : "reason" in result
              ? result.reason
              : undefined;
        if (!proposals && !text) r.error ??= "empty_response";
        r.result = text;
        r.finishedAt = new Date().toISOString();
        r.leaseUntil = undefined;
        recordThreadAnswer(w, r);
        if (text) commitDiscussions(w, r);
        else delete r.discussionUpdates;
        if (!handoff && (text || !proposals)) {
          const response = text
            ? `${text.slice(0, 2700)}${result.status === "partial" ? `\n\n${requestFailureMessage(r.error ?? "incomplete_response")}` : ""}`
            : requestFailureMessage(r.error ?? "empty_response");
          deliver(
            w,
            r.actor,
            r.chatId,
            `${r.threadNotice ? `${r.threadNotice}\n\n` : ""}${response}`,
            {
              topicId: r.topicId,
              replyTo: r.replyTo,
              runId: r.id,
              id: `run:${r.id}:result`,
              format: "rich",
            },
          );
        }
        audit(w, r.actor, `run.${r.status}`, r.id);
      });
      this.store.log.write("run_completed", { workspaceId, runId });
    } catch (error) {
      // AbortSignal.any preserves the first reason, even if another source aborts later.
      const failure = signal.aborted
        ? deadline.aborted && signal.reason === deadline.reason
          ? new Fault("run_timeout", 504)
          : shutdown?.aborted && signal.reason === shutdown.reason
            ? new Fault("worker_shutdown", 503)
            : signal.reason instanceof Fault
              ? signal.reason
              : new Fault("cancelled", 409)
        : error;
      const timedOut =
        failure instanceof Fault && failure.code === "run_timeout";
      this.store.log.write("run_failed", {
        error: failure,
        workspaceId,
        runId,
      });
      await this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        if (!r || r.fence !== fence) return;
        for (const a of r.attempts)
          if (a.status === "reserved") a.status = "unknown";
        r.status =
          r.cancelled || (signal.aborted && !timedOut) ? "cancelled" : "failed";
        r.error = r.cancelled
          ? "cancelled"
          : failure instanceof Fault
            ? failure.code
            : "execution_failed";
        r.finishedAt = new Date().toISOString();
        r.leaseUntil = undefined;
        delete r.discussionUpdates;
        const unaddressed = r.followup && r.followup.decision !== "reply";
        discardFollowup(w, r);
        if (r.cancelled) confirmRunStopped(w, r);
        else if (!unaddressed)
          notifyRunFailure(
            w,
            r,
            r.codingTaskId
              ? "Your coding request was handed to Codex, but the chat response could not finish. Use /status in this conversation to check the task’s current outcome."
              : (attachmentErrors[r.error ?? ""] ??
                  requestFailureMessage(r.error ?? "")),
          );
        audit(w, r.actor, `run.${r.status}`, r.id);
      });
    } finally {
      clearInterval(poll);
    }
  }
}
