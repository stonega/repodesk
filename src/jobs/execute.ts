import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildContext, validateSources } from "../agent/context.ts";
import { extensionToolExecution } from "../agent/extension-execution.ts";
import { DEFAULT_MODEL_BASE_URL } from "../agent/model-settings.ts";
import {
  type AgentRunner,
  PiRunner,
  type RunnerProvider,
  selectedModel,
} from "../agent/runtime.ts";
import { applicationTools } from "../agent/tools.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat } from "../domain.ts";
import type { SetupService } from "../setup/service.ts";
import { audit, runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
export class Executor {
  constructor(
    private store: Store,
    private setup: SetupService,
    private runner: AgentRunner | RunnerProvider = new PiRunner(),
  ) {}
  async execute(workspaceId: string, runId: string, shutdown?: AbortSignal) {
    const deployment = await this.store.deployment();
    if (!deployment.active || deployment.paused) return;
    const pluginRevision =
      (await this.store.read(workspaceId)).plugins?.revision ?? 0;
    let runner: AgentRunner;
    try {
      runner =
        typeof this.runner === "function"
          ? await this.runner(deployment, workspaceId)
          : this.runner;
    } catch {
      await this.store.change(workspaceId, (w) => {
        const run = w.runs.find((r) => r.id === runId);
        if (run?.status === "queued") {
          run.status = "failed";
          run.error = "extension_configuration_invalid";
          run.finishedAt = new Date().toISOString();
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
        throw new Fault("conversation_busy", 409);
      if (r.attempts.some((a) => a.status !== "settled")) {
        r.status = "failed";
        r.error = "provider_outcome_unknown";
        r.finishedAt = new Date().toISOString();
        for (const a of r.attempts)
          if (a.status === "reserved") a.status = "unknown";
        audit(w, r.actor, "run.recovery_required", r.id);
        return;
      }
      r.modelOptions ??= {
        modelBaseUrl: deployment.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL,
        thinkingLevel: deployment.thinkingLevel ?? "off",
        modelPricing: deployment.modelPricing,
      };
      if (r.extensionVersion === undefined && !r.transcript.length)
        r.extensionVersion = runner.extensionVersion ?? "none";
      if (
        (r.extensionVersion ?? "none") !== (runner.extensionVersion ?? "none")
      ) {
        r.status = "failed";
        r.error = "extension_configuration_changed";
        r.finishedAt = new Date().toISOString();
        return;
      }
      r.status = "running";
      r.fence++;
      r.leaseUntil = new Date(Date.now() + 120000).toISOString();
      return structuredClone(r);
    });
    if (!claimed) return;
    const fence = claimed.fence;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(90000);
    const signal = AbortSignal.any([
      controller.signal,
      deadline,
      ...(shutdown ? [shutdown] : []),
    ]);
    const guard = async () => {
      signal.throwIfAborted();
      const d = await this.store.deployment();
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      requireThat(
        (d.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL) ===
          claimed.modelOptions?.modelBaseUrl,
        "model_endpoint_changed",
        409,
      );
      await this.store.change(workspaceId, (w) => {
        requireThat(
          (w.plugins?.revision ?? 0) === pluginRevision,
          "extension_configuration_changed",
          409,
        );
        const r = w.runs.find((r) => r.id === runId);
        requireThat(
          r && r.fence === fence && r.status === "running" && runAllowed(w, r),
          "run_revoked",
          409,
        );
        r.leaseUntil = new Date(Date.now() + 120000).toISOString();
      });
    };
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      guard()
        .catch(() => controller.abort())
        .finally(() => {
          polling = false;
        });
    }, 1000);
    poll.unref();
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
            }
          }
        }
        if (!w.deletion && runAllowed(w, r)) r.transcript.push(message);
      });
    };
    this.store.log.write("run_started", { workspaceId, runId });
    try {
      await guard();
      const w = await this.store.read(workspaceId);
      const context = buildContext(w, claimed);
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
      const result = completed
        ? {
            text: tail.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
            status: "succeeded" as const,
          }
        : await runner.run({
            workspaceId,
            actor: claimed.actor,
            runId,
            model: selectedModel(claimed.model, claimed.modelOptions),
            apiKey: await this.setup.modelKey(
              claimed.modelOptions?.modelBaseUrl,
            ),
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
            maxTools: 8,
            maxInputChars: claimed.settings.maxInputChars,
            maxOutputTokens: claimed.settings.maxOutputTokens,
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
                const own = r.attempts.reduce(
                  (n, a) => n + (a.actual ?? a.reserved),
                  0,
                );
                requireThat(
                  amount > 0 &&
                    own + amount <=
                      Math.min(
                        r.settings.runBudgetUsd,
                        w.settings.runBudgetUsd,
                      ),
                  "run_budget_exhausted",
                  409,
                );
                const month = new Date();
                month.setUTCDate(1);
                month.setUTCHours(0, 0, 0, 0);
                const total = w.runs
                  .flatMap((r) => r.attempts)
                  .filter((a) => Date.parse(a.at) >= month.getTime())
                  .reduce((n, a) => n + (a.actual ?? a.reserved), 0);
                requireThat(
                  total + amount <= w.settings.monthlyBudgetUsd,
                  "workspace_budget_exhausted",
                  409,
                );
                const id = randomUUID();
                r.attempts.push({
                  id,
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
          });
      await guard();
      if (result.text) validateSources(result.text, claimed);
      await this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        requireThat(
          r && r.fence === fence && runAllowed(w, r),
          "run_revoked",
          409,
        );
        const proposals = w.approvals.some(
          (a) =>
            !a.decision &&
            a.runId === r.id &&
            Date.parse(a.expiresAt) > Date.now(),
        );
        r.status = proposals ? "awaiting_approval" : result.status;
        r.result = result.text;
        r.finishedAt = new Date().toISOString();
        r.leaseUntil = undefined;
        if (result.text)
          deliver(
            w,
            r.actor,
            r.chatId,
            `${result.text.slice(0, 2700)}\n\n${r.coverage.slice(0, 600)}\nRun ${r.id}${result.status === "partial" ? " · Partial: execution limit reached" : ""}`,
            {
              topicId: r.topicId,
              replyTo: r.replyTo,
              runId: r.id,
              id: `run:${r.id}:result`,
              format: "markdown",
            },
          );
        audit(w, r.actor, `run.${r.status}`, r.id);
      });
      this.store.log.write("run_completed", { workspaceId, runId });
    } catch (error) {
      this.store.log.write("run_failed", { error, workspaceId, runId });
      await this.store.change(workspaceId, (w) => {
        const r = w.runs.find((r) => r.id === runId);
        if (!r || r.fence !== fence) return;
        for (const a of r.attempts)
          if (a.status === "reserved") a.status = "unknown";
        r.status = r.cancelled || signal.aborted ? "cancelled" : "failed";
        r.error =
          error instanceof Fault
            ? error.code
            : signal.aborted
              ? "cancelled"
              : "execution_failed";
        r.finishedAt = new Date().toISOString();
        r.leaseUntil = undefined;
        if (runAllowed(w, r))
          deliver(
            w,
            r.actor,
            r.chatId,
            `Run ${r.id}: ${r.status} (${r.error}). Inspect the run in the panel; unknown provider charges remain reserved.`,
            { topicId: r.topicId, id: `run:${r.id}:failure` },
          );
        audit(w, r.actor, `run.${r.status}`, r.id);
      });
    } finally {
      clearInterval(poll);
    }
  }
}
