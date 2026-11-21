import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Fault, requireThat } from "../domain.ts";
import { researchSubagentSystemPrompt } from "./routing-prompt.ts";
import type { AgentInput, AgentResult } from "./runtime.ts";
import {
  type ConcurrencyLimiter,
  isSubagentSafeTool,
  wrapToolWithConcurrencyLimit,
} from "./tool-metadata.ts";

export const RESEARCH_SUBAGENT_TOOL = "delegate_research";
export const MAX_RESEARCH_TASKS = 3;
export const MAX_RESEARCH_TURNS = 6;
export const MAX_RESEARCH_TOOLS = 12;
export const MAX_RESEARCH_FINDINGS_CHARS = 6000;

export const researchParameters = Type.Object(
  {
    tasks: Type.Array(
      Type.Object(
        {
          id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          focus: Type.String({ minLength: 1, maxLength: 300 }),
          question: Type.String({ minLength: 1, maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_RESEARCH_TASKS },
    ),
  },
  { additionalProperties: false },
);

export interface ResearchTaskRequest {
  id?: string;
  focus: string;
  question: string;
}

export interface ResearchTaskOutcome {
  id: string;
  focus: string;
  status: "succeeded" | "partial" | "failed";
  findings: string;
  turns: number;
  tools: number;
  truncated: boolean;
  error?: string;
}

export interface ResearchSubagentContext {
  parentInput: AgentInput;
  availableTools: AgentTool[];
  runSubagent: (input: AgentInput) => Promise<AgentResult>;
  limiter: ConcurrencyLimiter;
}

const FATAL_SUBAGENT_CODES = new Set([
  "cancelled",
  "run_revoked",
  "lease_lost",
  "deployment_paused",
  "workspace_budget_exhausted",
  "run_budget_exhausted",
  "model_configuration_changed",
  "model_endpoint_changed",
  "extension_configuration_changed",
]);

/**
 * Creates the bounded depth-1 read-only `delegate_research` tool.
 * Only exposed on top-level runs (never inside another subagent or internal pass).
 */
export function createResearchSubagentTool(
  ctx: ResearchSubagentContext,
): AgentTool {
  const safeTools = ctx.availableTools
    .filter(
      (tool) =>
        tool.name !== RESEARCH_SUBAGENT_TOOL &&
        tool.executionMode === "parallel" &&
        isSubagentSafeTool(tool.name),
    )
    .map((tool) => wrapToolWithConcurrencyLimit(tool, ctx.limiter));

  return {
    name: RESEARCH_SUBAGENT_TOOL,
    label: "Delegate read-only research",
    executionMode: "sequential",
    description:
      "Run 1 to 3 bounded, read-only research subagents concurrently in isolated contexts to gather verified evidence across repositories, docs, web pages, chat history, or analytics without bloating the main conversation. Subagents inherit current tenant, actor and repository permissions, have read-only tools only (no writes, no coding dispatch, no nested subagents), and return structured untrusted reference findings with provenance.",
    parameters: researchParameters,
    execute: async (
      callId,
      rawArgs,
      signal,
    ): Promise<AgentToolResult<unknown>> => {
      const execute = async (): Promise<AgentToolResult<unknown>> => {
        const effectiveSignal = signal
          ? AbortSignal.any([ctx.parentInput.signal, signal])
          : ctx.parentInput.signal;
        effectiveSignal.throwIfAborted();
        await ctx.parentInput.guard();
        const parsed = rawArgs as { tasks?: ResearchTaskRequest[] };
        requireThat(
          Array.isArray(parsed.tasks) &&
            parsed.tasks.length >= 1 &&
            parsed.tasks.length <= MAX_RESEARCH_TASKS,
          "invalid_research_tasks",
        );

        const system = researchSubagentSystemPrompt();
        const tasks = parsed.tasks.map((task, idx) => ({
          id: task.id?.trim() || `research-${idx + 1}`,
          focus: task.focus.trim(),
          question: task.question.trim(),
        }));

        const results: ResearchTaskOutcome[] = await Promise.all(
          tasks.map(async (task): Promise<ResearchTaskOutcome> => {
            effectiveSignal.throwIfAborted();
            await ctx.parentInput.guard();
            const subInput: AgentInput = {
              purpose: "research_subagent",
              workspaceId: ctx.parentInput.workspaceId,
              actor: ctx.parentInput.actor,
              runId: ctx.parentInput.runId,
              model: ctx.parentInput.model,
              apiKey: ctx.parentInput.apiKey,
              thinkingLevel: ctx.parentInput.thinkingLevel,
              system,
              prompt: JSON.stringify({
                subtaskId: task.id,
                focus: task.focus,
                question: task.question,
                availableTools: safeTools.map((t) => t.name),
                note: "Read-only research pass. Return verified findings with exact provenance and explicit unknowns.",
              }),
              transcript: [],
              tools: safeTools,
              maxTurns: MAX_RESEARCH_TURNS,
              maxTools: MAX_RESEARCH_TOOLS,
              remainingBudget: ctx.parentInput.remainingBudget,
              signal: effectiveSignal,
              guard: ctx.parentInput.guard,
              reserve: (amount) =>
                ctx.parentInput.reserve(amount, "research_subagent"),
              checkpoint: (message, attemptId) =>
                ctx.parentInput.checkpoint(
                  message,
                  attemptId,
                  "research_subagent",
                ),
            };
            try {
              const out = await ctx.runSubagent(subInput);
              const rawText = out.text.trim();
              const truncated = rawText.length > MAX_RESEARCH_FINDINGS_CHARS;
              return {
                id: task.id,
                focus: task.focus,
                status: out.status,
                findings: truncated
                  ? rawText.slice(0, MAX_RESEARCH_FINDINGS_CHARS)
                  : rawText,
                turns: out.turns,
                tools: out.tools,
                truncated,
                ...(out.reason ? { error: out.reason } : {}),
              };
            } catch (error) {
              if (
                effectiveSignal.aborted ||
                (error instanceof Fault && FATAL_SUBAGENT_CODES.has(error.code))
              ) {
                throw error;
              }
              return {
                id: task.id,
                focus: task.focus,
                status: "failed",
                findings: "",
                turns: 0,
                tools: 0,
                truncated: false,
                error:
                  error instanceof Fault
                    ? error.code
                    : "research_subagent_failed",
              };
            }
          }),
        );

        effectiveSignal.throwIfAborted();
        await ctx.parentInput.guard();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                untrustedReferenceData: true,
                results,
              }),
            },
          ],
          details: {},
        };
      };

      return ctx.parentInput.extensionTool
        ? ctx.parentInput.extensionTool(RESEARCH_SUBAGENT_TOOL, callId, execute)
        : execute();
    },
  };
}
