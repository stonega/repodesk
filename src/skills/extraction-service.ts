import { randomUUID } from "node:crypto";
import { remainingBudgets } from "../agent/limits.ts";
import { DEFAULT_MODEL_BASE_URL } from "../agent/model-settings.ts";
import {
  type AgentInput,
  type AgentRunner,
  PiRunner,
  selectedModel,
} from "../agent/runtime.ts";
import type { DevelopmentTask } from "../coding/development.ts";
import { taskList } from "../coding/task-store.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Deployment,
  Fault,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { redactMemoryValue } from "../memory/state.ts";
import { missionGet, missionList } from "../orchestration/store.ts";
import type { Mission } from "../orchestration/types.ts";
import type { SetupService } from "../setup/service.ts";
import {
  type ModelUsageEvent,
  resolveProviderLabel,
  upsertModelUsageEvents,
} from "../usage/model-usage.ts";
import { eligible } from "../workspaces/policy.ts";
import { isPresetSkill } from "./catalog.ts";
import {
  claimSkillExtractionJob,
  SKILL_EXTRACT_IDLE_MS,
  SKILL_EXTRACT_LEASE_MS,
} from "./extraction-planner.ts";
import {
  applyExtractedSkill,
  buildExtractionSystemPrompt,
  parseExtractionJson,
} from "./extractor.ts";
import {
  normalizeSkillScope,
  skillAudience,
  skillExtractionEnabled,
  skillExtractionState,
} from "./scope.ts";
import type { SkillExtractionJob } from "./types.ts";

/**
 * Durable, fenced background service that autonomously extracts and evolves
 * Global and Project-scoped skills from completed coding tasks, Missions,
 * and high-signal conversations without requiring manual review clicks.
 */
export class SkillExtractionService {
  constructor(
    private store: Store,
    private setup: SetupService,
    private runner: AgentRunner = new PiRunner(),
    private idleMs = SKILL_EXTRACT_IDLE_MS,
  ) {}

  private async resolveModelCredentials(
    w: Workspace,
    d: Deployment,
    parent?: Run,
  ) {
    if (parent?.modelProvider) {
      const apiKey = await this.setup.models.modelKey(
        parent.modelProvider.operatorId,
        parent.modelProvider.id,
        parent.modelProvider.version,
      );
      const provider = d.modelProviders?.find(
        (p) => p.id === parent.modelProvider?.id,
      );
      return {
        modelId: parent.model,
        model: selectedModel(parent.model, parent.modelOptions),
        apiKey,
        providerId: parent.modelProvider.id,
        providerName: resolveProviderLabel(
          provider?.name,
          parent.modelOptions?.modelBaseUrl,
        ),
      };
    }

    if (w.chatModel?.selection) {
      const provider = d.modelProviders?.find(
        (p) => p.id === w.chatModel?.selection.providerId,
      );
      if (provider) {
        const apiKey = await this.setup.models.modelKey(
          w.operatorId,
          provider.id,
          provider.version,
        );
        const options = {
          modelBaseUrl: provider.baseUrl,
          modelLimits: w.chatModel.selection.modelLimits ?? undefined,
          modelPricing: w.chatModel.selection.modelPricing,
          modelPriceTier: w.chatModel.selection.modelPriceTier,
        };
        return {
          modelId: w.chatModel.selection.model,
          model: selectedModel(w.chatModel.selection.model, options),
          apiKey,
          providerId: provider.id,
          providerName: resolveProviderLabel(provider.name, provider.baseUrl),
        };
      }
    }

    const baseUrl =
      parent?.modelOptions?.modelBaseUrl ??
      d.modelBaseUrl ??
      DEFAULT_MODEL_BASE_URL;
    const modelId = parent?.model ?? d.model;
    const apiKey = await this.setup.modelKey(baseUrl);
    return {
      modelId,
      model: selectedModel(modelId, parent?.modelOptions ?? d),
      apiKey,
      providerId: undefined,
      providerName: resolveProviderLabel(undefined, baseUrl),
    };
  }

  private async buildPromptPayload(
    w: Workspace,
    job: SkillExtractionJob,
    codingTask?: DevelopmentTask,
    mission?: Mission,
  ) {
    const existingSkills = w.skills
      .filter((s) => !s.archived)
      .slice(-60)
      .map((s) => ({
        slug: s.draft.slug,
        name: s.draft.name,
        description: s.draft.description,
        scope: normalizeSkillScope(s.draft),
        audience: skillAudience(s.draft),
        enabled: s.enabled,
        editable: !isPresetSkill(w, s) && !s.githubSource,
      }));

    const suppressedTopics = (w.skillExtraction?.suppressed ?? []).map((s) => ({
      slug: s.slug,
      name: s.name,
      scopeKey: s.scopeKey,
      reason: s.reason,
    }));

    const base = {
      sourceKind: job.sourceKind,
      repository: job.repositoryId
        ? { id: job.repositoryId, full_name: job.repository }
        : undefined,
      connectedRepositories: (w.github?.repositories ?? [])
        .filter((r) => !r.archived && !r.disabled)
        .map((r) => ({ id: r.id, full_name: r.full_name })),
      existingSkills,
      suppressedTopics,
    };

    if (job.sourceKind === "coding_task" && codingTask) {
      const decisions = (
        await this.store.pool.query(
          "SELECT id, data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND (id LIKE 'question:%' OR id LIKE 'answer:%') ORDER BY created_at, id LIMIT 40",
          [w.id, codingTask.id],
        )
      ).rows;
      return redactMemoryValue({
        ...base,
        codingTask: {
          id: codingTask.id,
          repositoryId: codingTask.payload.repositoryId,
          repository: codingTask.payload.repository,
          objective: codingTask.objective?.kind ?? "development",
          title: codingTask.payload.title,
          request: codingTask.payload.body.slice(0, 3000),
          attempts: codingTask.attempts,
          state: codingTask.state,
          result: codingTask.result
            ? {
                status: codingTask.result.status,
                summary: codingTask.result.summary.slice(0, 4000),
                evidence: codingTask.result.evidence.slice(0, 4000),
                verificationCommands: codingTask.result.verificationCommands,
              }
            : undefined,
          decisions: decisions.slice(0, 20),
        },
      });
    }

    if (job.sourceKind === "mission" && mission) {
      const missionRuns = w.runs
        .filter((r) => r.missionId === mission.id)
        .slice(-10)
        .map((r) => ({
          id: r.id,
          task: r.task.slice(0, 800),
          status: r.status,
          toolsUsed: Object.values(r.tools ?? {}).map((t) => t.name),
          result: r.result?.slice(0, 1200),
        }));
      return redactMemoryValue({
        ...base,
        mission: {
          id: mission.id,
          goal: mission.goal,
          summary: mission.summary,
          repositoryId: mission.repositoryId,
          artifacts: mission.artifacts.map((a) => ({
            kind: a.kind,
            label: a.label,
            value: a.value.slice(0, 500),
            repository: a.repository,
          })),
          childTaskIds: mission.childTaskIds,
          runs: missionRuns,
        },
      });
    }

    const threadRuns = w.runs
      .filter((r) => r.threadId === job.sourceId)
      .slice(-12);
    const messages = w.messages
      .filter(
        (m) =>
          m.threadId === job.sourceId &&
          Date.parse(m.expiresAt) > Date.now() &&
          !w.runs.find((r) => r.id === m.runId)?.memoryMutation,
      )
      .slice(-24)
      .map((m) => ({
        role: m.role,
        author: m.author,
        at: m.at,
        text: m.text.slice(0, 1500),
      }));
    const toolsUsed = [
      ...new Set(
        threadRuns.flatMap((r) =>
          Object.values(r.tools ?? {}).map((t) => t.name),
        ),
      ),
    ];

    return redactMemoryValue({
      ...base,
      conversation: {
        threadId: job.sourceId,
        toolsUsed,
        messages,
      },
    });
  }

  async tick(workspaceId: string, shutdown?: AbortSignal) {
    const deployment = await this.store.deployment();
    if (!deployment.active || deployment.paused || shutdown?.aborted) return;

    const preview = await this.store.read(workspaceId);
    if (
      preview.deletion ||
      preview.settings.paused ||
      !skillExtractionEnabled(preview)
    ) {
      return;
    }

    const [codingTasks, missionsResult] = await Promise.all([
      taskList(this.store.pool, workspaceId).catch(
        () => [] as DevelopmentTask[],
      ),
      missionList(this.store.pool, workspaceId, { limit: 30 }).catch(() => ({
        items: [] as Mission[],
        total: 0,
      })),
    ]);

    const job = await this.store.change(workspaceId, (w) =>
      claimSkillExtractionJob(w, {
        codingTasks,
        missions: missionsResult.items,
        now: Date.now(),
        idleMs: this.idleMs,
      }),
    );
    if (!job) return;

    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(90_000),
      ...(shutdown ? [shutdown] : []),
    ]);

    const current = (w: Workspace) => {
      const saved = w.skillExtraction?.jobs.find((j) => j.id === job.id);
      requireThat(
        saved?.token === job.token &&
          saved.status === "running" &&
          skillExtractionEnabled(w) &&
          !w.deletion &&
          !w.settings.paused &&
          eligible(w, job.actor),
        "skill_extract_job_revoked",
        409,
      );
      saved.leaseUntil = new Date(
        Date.now() + SKILL_EXTRACT_LEASE_MS,
      ).toISOString();
      const parent = job.runId
        ? w.runs.find((r) => r.id === job.runId)
        : undefined;
      return { saved, parent };
    };

    const guard = async () => {
      signal.throwIfAborted();
      const d = await this.store.deployment();
      requireThat(d.active && !d.paused, "skill_extract_job_revoked", 409);
      await this.store.change(workspaceId, (w) => {
        current(w);
      });
    };

    const timer = setInterval(() => {
      void guard().catch((error) => controller.abort(error));
    }, 10_000);
    timer.unref();

    try {
      await guard();
      const w = await this.store.read(workspaceId);
      const d = await this.store.deployment();
      const parent = job.runId
        ? w.runs.find((r) => r.id === job.runId)
        : undefined;

      const codingTask =
        job.sourceKind === "coding_task"
          ? codingTasks.find((t: DevelopmentTask) => t.id === job.sourceId)
          : undefined;
      const mission =
        job.sourceKind === "mission"
          ? await missionGet(this.store.pool, workspaceId, job.sourceId)
          : undefined;

      const creds = await this.resolveModelCredentials(w, d, parent);
      const promptPayload = await this.buildPromptPayload(
        w,
        job,
        codingTask,
        mission,
      );

      let standaloneAttemptId: string | undefined;
      let standaloneUsageEvent: ModelUsageEvent | undefined;

      const input: AgentInput = {
        purpose: "skill_extract",
        workspaceId,
        actor: job.actor,
        runId: parent?.id ?? `skill-extract:${job.id}`,
        model: creds.model,
        apiKey: creds.apiKey,
        thinkingLevel: "off",
        system: buildExtractionSystemPrompt(),
        prompt: JSON.stringify(promptPayload),
        transcript: [],
        tools: [],
        maxTurns: 1,
        maxTools: 0,
        maxOutputTokens: Math.min(2048, creds.model.maxTokens),
        signal,
        guard,
        remainingBudget: async () =>
          this.store.change(workspaceId, (w) => {
            const { parent } = current(w);
            if (parent) return remainingBudgets(w, parent);
            const synthetic = {
              settings: w.settings,
              attempts: [],
            } as unknown as Run;
            return remainingBudgets(w, synthetic);
          }),
        reserve: async (amount, _purpose, meta) =>
          this.store.change(workspaceId, (w) => {
            const { saved, parent } = current(w);
            const budgets = parent
              ? remainingBudgets(w, parent)
              : remainingBudgets(w, {
                  settings: w.settings,
                  attempts: [],
                } as unknown as Run);
            requireThat(
              Number.isFinite(amount) &&
                amount >= 0 &&
                amount <= Math.min(budgets.run, budgets.workspace),
              "skill_extract_budget_exhausted",
              409,
            );
            const id = randomUUID();
            if (parent) {
              parent.attempts.push({
                id,
                model: meta?.model ?? creds.modelId,
                providerId: creds.providerId,
                providerName: creds.providerName,
                ...(meta?.estimatedInputTokens !== undefined
                  ? { estimatedInputTokens: meta.estimatedInputTokens }
                  : {}),
                ...(meta?.pricingUnknown ? { pricingUnknown: true } : {}),
                purpose: "skill_extract",
                reserved: amount,
                status: "reserved",
                at: new Date().toISOString(),
              });
            } else {
              standaloneAttemptId = id;
              standaloneUsageEvent = {
                workspaceId,
                id: `skill_extract:${job.id}:${id}`,
                recordedAt: new Date().toISOString(),
                sourceKind: "skill_extract",
                sourceId: job.sourceId,
                sourceLabel: `Skill extraction · ${job.sourceKind}`,
                sourcePath: "/admin/skills",
                actor: job.actor,
                providerId: creds.providerId,
                providerName: creds.providerName,
                model: meta?.model ?? creds.modelId,
                status: "reserved",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
                estimatedInputTokens: meta?.estimatedInputTokens,
                tokenBreakdownKnown: false,
                reservedUsd: amount,
                accountedUsd: meta?.pricingUnknown ? 0 : amount,
                pricingUnknown: !!meta?.pricingUnknown,
                toolCalls: 0,
                metadata: {
                  jobId: job.id,
                  sourceKind: job.sourceKind,
                  sourceId: job.sourceId,
                  ...(job.repository ? { repository: job.repository } : {}),
                },
              };
            }
            saved.attemptIds.push(id);
            return id;
          }),
        checkpoint: async (message, attemptId, _purpose, meta) => {
          await this.store.change(workspaceId, (w) => {
            const parent = job.runId
              ? w.runs.find((r) => r.id === job.runId)
              : undefined;
            const a = parent?.attempts.find((a) => a.id === attemptId);
            if (message.role === "assistant" && a) {
              if (meta?.model) a.model = meta.model;
              if (meta?.estimatedInputTokens !== undefined)
                a.estimatedInputTokens = meta.estimatedInputTokens;
              if (meta?.latencyMs !== undefined) a.latencyMs = meta.latencyMs;
              if (meta?.stopReason) a.stopReason = meta.stopReason;
              if (meta?.toolCalls !== undefined) a.toolCalls = meta.toolCalls;
              if (meta?.pricingUnknown) a.pricingUnknown = true;
              a.status = ["error", "aborted"].includes(message.stopReason)
                ? "unknown"
                : "settled";
              if (a.status === "settled")
                a.actual = Math.max(0, message.usage.cost.total);
              a.tokens = {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
              };
            }
          });
          if (
            message.role === "assistant" &&
            standaloneUsageEvent &&
            attemptId === standaloneAttemptId
          ) {
            const settled = !["error", "aborted"].includes(message.stopReason);
            const actual = settled
              ? Math.max(0, message.usage.cost.total)
              : undefined;
            const inputTokens = Math.max(0, Math.trunc(message.usage.input));
            const outputTokens = Math.max(0, Math.trunc(message.usage.output));
            const cacheReadTokens = Math.max(
              0,
              Math.trunc(message.usage.cacheRead),
            );
            const cacheWriteTokens = Math.max(
              0,
              Math.trunc(message.usage.cacheWrite),
            );
            standaloneUsageEvent = {
              ...standaloneUsageEvent,
              model: meta?.model ?? standaloneUsageEvent.model,
              status: settled ? "settled" : "unknown",
              stopReason: meta?.stopReason ?? message.stopReason,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              totalTokens:
                inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
              tokenBreakdownKnown: true,
              actualUsd: actual,
              accountedUsd:
                actual ??
                (meta?.pricingUnknown ? 0 : standaloneUsageEvent.reservedUsd),
              pricingUnknown:
                !!meta?.pricingUnknown || standaloneUsageEvent.pricingUnknown,
              latencyMs: meta?.latencyMs,
              toolCalls: meta?.toolCalls ?? 0,
            };
            await upsertModelUsageEvents(this.store.pool, [
              standaloneUsageEvent,
            ]);
          }
        },
      };

      const result = await this.runner.run(input);
      requireThat(
        result.status === "succeeded" && !!result.text.trim(),
        "skill_extract_invalid_output",
        502,
      );
      const decision = parseExtractionJson(result.text);
      await guard();

      await this.store.change(workspaceId, (w) => {
        const { saved } = current(w);
        const state = skillExtractionState(w);
        applyExtractedSkill(w, decision, {
          sourceKind: job.sourceKind,
          sourceId: job.sourceId,
          actor: job.actor,
          repositoryId: job.repositoryId,
          repository: job.repository,
        });
        state.checkpoints = [
          ...state.checkpoints.filter((c) => c.key !== job.checkpointKey),
          {
            key: job.checkpointKey,
            hash: job.inputHash,
            at: new Date().toISOString(),
          },
        ].slice(-256);
        saved.status = "done";
        delete saved.error;
      });
    } catch (error) {
      await this.store.change(workspaceId, (w) => {
        const saved = w.skillExtraction?.jobs.find((j) => j.id === job.id);
        if (!saved || saved.token !== job.token) return;
        const parent = job.runId
          ? w.runs.find((r) => r.id === job.runId)
          : undefined;
        for (const a of parent?.attempts ?? []) {
          if (saved.attemptIds.includes(a.id) && a.status === "reserved") {
            a.status = "unknown";
          }
        }
        const ambiguous = parent?.attempts.some(
          (a) => saved.attemptIds.includes(a.id) && a.status === "unknown",
        );
        saved.status = ambiguous || saved.tries >= 3 ? "failed" : "retry";
        saved.error =
          error instanceof Fault ? error.code : "skill_extraction_failed";
        saved.retryAt = new Date(Date.now() + 3_600_000).toISOString();
        if (saved.status === "failed") {
          const state = skillExtractionState(w);
          state.checkpoints = [
            ...state.checkpoints.filter((c) => c.key !== saved.checkpointKey),
            {
              key: saved.checkpointKey,
              hash: saved.inputHash,
              at: new Date().toISOString(),
            },
          ].slice(-256);
        }
      });
    } finally {
      clearInterval(timer);
    }
  }
}
