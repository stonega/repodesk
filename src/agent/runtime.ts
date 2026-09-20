import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  createModels,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  ContextEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type Deployment, Fault, requireThat } from "../domain.ts";
import type { ExtensionCatalog, ExtensionHost } from "./extensions.ts";
import {
  DEFAULT_MODEL_BASE_URL,
  type ModelOptions,
  type ThinkingLevel,
} from "./model-settings.ts";
export const models = createModels();
models.setProvider(openaiProvider());
export function selectedModel(
  id: string,
  options: ModelOptions = {},
): Model<"openai-completions"> {
  const catalog = models.getModel("openai", id);
  const pricing = options.modelPricing;
  const cost = pricing
    ? { ...pricing, cacheRead: pricing.input, cacheWrite: pricing.input }
    : catalog?.cost;
  requireThat(cost, "custom_model_pricing_required");
  return {
    id,
    name: catalog?.name ?? id,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: options.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL,
    reasoning:
      options.thinkingLevel !== undefined && options.thinkingLevel !== "off",
    input: ["text"],
    cost,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    contextWindow: catalog?.contextWindow ?? 128000,
    maxTokens: catalog?.maxTokens ?? 16384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: "openai",
      maxTokensField: "max_completion_tokens",
    },
  };
}
export interface AgentInput {
  workspaceId?: string;
  actor: string;
  runId: string;
  model: Model<Api>;
  apiKey: string;
  thinkingLevel?: ThinkingLevel;
  system: string;
  prompt: string;
  transcript: AgentMessage[];
  tools: AgentTool[];
  maxTurns: number;
  maxTools: number;
  maxInputChars: number;
  maxOutputTokens: number;
  signal: AbortSignal;
  guard: () => Promise<void>;
  shouldPause?: () => Promise<boolean>;
  reserve: (amount: number) => Promise<string>;
  checkpoint: (message: AgentMessage, attemptId?: string) => Promise<void>;
  events?: (type: string) => void;
  extensionTool?: (
    name: string,
    callId: string,
    execute: () => Promise<AgentToolResult<unknown>>,
  ) => Promise<AgentToolResult<unknown>>;
}
export interface AgentResult {
  text: string;
  status: "succeeded" | "partial";
  turns: number;
  tools: number;
  transcript: AgentMessage[];
}
export type RunnerProvider = (
  deployment: Deployment,
  workspaceId: string,
) => Promise<AgentRunner>;
export interface AgentRunner {
  readonly extensionVersion?: string;
  run(input: AgentInput): Promise<AgentResult>;
}
export function sanitizeMessage(message: AgentMessage): AgentMessage {
  if (message.role === "assistant")
    return {
      ...message,
      content: message.content
        .filter((c) => c.type !== "thinking")
        .map((c) =>
          c.type === "text" ? { type: "text" as const, text: c.text } : c,
        ),
      errorMessage: message.errorMessage ? "provider_failed" : undefined,
    };
  return structuredClone(message);
}
export function failedStream(
  model: Model<Api>,
  reason: string,
  aborted = false,
) {
  const stream = new AssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: reason,
    timestamp: Date.now(),
  };
  stream.push({
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: message,
  });
  stream.end(message);
  return stream;
}
export class PiRunner implements AgentRunner {
  constructor(
    private stream: StreamFn = (model, context, options) =>
      model.api === "openai-completions"
        ? streamCompletions(
            model as Model<"openai-completions">,
            context,
            options,
          )
        : models.streamSimple(model, context, options),
    private extensions?: ExtensionCatalog,
  ) {}
  get extensionVersion() {
    return this.extensions?.version;
  }
  async run(input: AgentInput): Promise<AgentResult> {
    const extensions = await this.extensions?.open(input);
    try {
      return await this.execute(input, extensions);
    } finally {
      await extensions?.close();
    }
  }
  private async execute(
    input: AgentInput,
    extensions?: ExtensionHost,
  ): Promise<AgentResult> {
    let turns = 0;
    let toolCount = 0;
    let attemptId: string | undefined;
    let blocked: string | undefined;
    const streamFn: StreamFn = async (model, context, options) => {
      try {
        input.signal.throwIfAborted();
        await input.guard();
        if (extensions) {
          const event: ContextEvent = {
            type: "context",
            messages: structuredClone(context.messages),
          };
          await extensions.emit(event, (value) => {
            const result = value as { messages?: AgentMessage[] } | undefined;
            if (result?.messages) event.messages = result.messages;
          });
          context = {
            ...context,
            messages: event.messages.map((message) => {
              if (
                message.role === "user" ||
                message.role === "assistant" ||
                message.role === "toolResult"
              )
                return message;
              throw new Fault("extension_api_unsupported", 409);
            }),
          };
          input.signal.throwIfAborted();
          await input.guard();
        }
        requireThat(turns < input.maxTurns, "turn_limit");
        const bytes = Buffer.byteLength(JSON.stringify(context));
        requireThat(bytes <= input.maxInputChars, "input_budget_exceeded");
        // A byte per token is deliberately conservative; include all serialized tools/context.
        const reserve =
          (bytes * model.cost.input +
            input.maxOutputTokens * model.cost.output) /
          1_000_000;
        attemptId = await input.reserve(reserve);
        turns++;
        return this.stream(model, context, {
          ...options,
          apiKey: input.apiKey,
          maxTokens: input.maxOutputTokens,
          maxRetryDelayMs: 0,
          maxRetries: 0,
          signal: input.signal,
          onPayload: (payload) =>
            typeof payload === "object" && payload
              ? { ...payload, store: false }
              : payload,
        });
      } catch (error) {
        blocked =
          error instanceof Fault
            ? error.code
            : input.signal.aborted
              ? "cancelled"
              : "execution_blocked";
        return failedStream(model, blocked, input.signal.aborted);
      }
    };
    const agent = new Agent({
      initialState: {
        model: input.model,
        systemPrompt: extensions ? await extensions.start() : input.system,
        messages: input.transcript,
        tools: [...input.tools, ...(extensions?.tools ?? [])],
        thinkingLevel: input.thinkingLevel ?? "off",
      },
      streamFn,
      toolExecution: "sequential",
      sessionId: input.runId,
      beforeToolCall: async ({ toolCall, args }) => {
        try {
          input.signal.throwIfAborted();
          await input.guard();
          if (await input.shouldPause?.())
            return {
              block: true,
              reason: "awaiting_approval",
              terminate: true,
            };
          requireThat(++toolCount <= input.maxTools, "tool_limit");
          if (extensions) {
            const event = {
              type: "tool_call" as const,
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              input: structuredClone(args) as Record<string, unknown>,
            };
            const original = JSON.stringify(event.input);
            const results = await extensions.emit(event);
            // Hook input mutation is unsupported; application schemas remain authoritative.
            requireThat(
              JSON.stringify(event.input) === original,
              "extension_api_unsupported",
              409,
            );
            input.signal.throwIfAborted();
            await input.guard();
            const denied = results.find(
              (result) => (result as ToolCallEventResult | undefined)?.block,
            ) as ToolCallEventResult | undefined;
            if (denied)
              return {
                block: true,
                reason: denied.reason ?? "extension_blocked",
                terminate: denied.terminate,
              };
          }
          return undefined;
        } catch (error) {
          blocked = error instanceof Fault ? error.code : "tool_policy_blocked";
          return { block: true, reason: blocked, terminate: true };
        }
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        if (!extensions || blocked) return undefined;
        try {
          const event: ToolResultEvent = {
            type: "tool_result",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: structuredClone(args) as Record<string, unknown>,
            ...structuredClone(result),
            isError,
          };
          const original = JSON.stringify(event);
          const results = await extensions.emit(event);
          requireThat(
            results.every((value) => value === undefined) &&
              JSON.stringify(event) === original,
            "extension_api_unsupported",
            409,
          );
          return undefined;
        } catch {
          blocked = "extension_hook_failed";
          return {
            content: [{ type: "text", text: blocked }],
            isError: true,
            terminate: true,
          };
        }
      },
      shouldStopAfterTurn: async () =>
        turns >= input.maxTurns ||
        !!blocked ||
        input.signal.aborted ||
        !!(await input.shouldPause?.()),
    });
    agent.subscribe(async (event) => {
      input.events?.(event.type);
      if (event.type === "message_end") {
        await input.checkpoint(
          sanitizeMessage(event.message),
          event.message.role === "assistant" ? attemptId : undefined,
        );
        if (event.message.role === "assistant") attemptId = undefined;
      }
      if (
        extensions &&
        (event.type === "agent_start" || event.type === "agent_end")
      )
        await extensions.emit(
          event.type === "agent_end"
            ? { ...event, messages: event.messages.map(sanitizeMessage) }
            : event,
        );
    });
    const abort = () => agent.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      input.signal.throwIfAborted();
      if (input.transcript.length) await agent.continue();
      else await agent.prompt(input.prompt);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
    if (blocked) throw new Fault(blocked, 409);
    if (input.signal.aborted) throw new Fault("cancelled", 409);
    const last = agent.state.messages.findLast(
      (m): m is AssistantMessage => m.role === "assistant",
    );
    requireThat(
      last && !["error", "aborted"].includes(last.stopReason),
      "provider_failed",
      502,
    );
    const text = last.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return {
      text,
      status: last.stopReason === "stop" ? "succeeded" : "partial",
      turns,
      tools: toolCount,
      transcript: agent.state.messages.map(sanitizeMessage),
    };
  }
}
