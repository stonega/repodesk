import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { Fault } from "../../domain.ts";
import {
  type DevelopmentMedia,
  type DevelopmentResult,
  developmentOutputSchema,
  developmentResultByteLimit,
} from "../development.ts";
import {
  parseDevelopmentResult,
  type ResultIssues,
} from "../result-validation.ts";
import {
  type TranscriptEntry,
  transcriptEntry,
  transcriptText,
} from "../transcript.ts";
import { CodexAuthError } from "./auth-failure.ts";
import {
  CodexConversationError,
  type conversationFailureCodes,
} from "./conversation-failure.ts";
import type { JobTaskChannel } from "./job-channel.ts";

type FailureCode = (typeof conversationFailureCodes)[number];

/** Classifies Antigravity CLI / Google OAuth authentication failures. */
export function antigravityAuthFailure(message?: string): boolean {
  if (!message) return false;
  return /authentication required|authentication failed|not logged into antigravity|sign in again|re-authenticate|invalid_grant|token expired|refresh token|unauthenticated|401 unauthorized|api key not valid|api_key_invalid/i.test(
    message,
  );
}

/** Maps Antigravity CLI headless error strings into safe Telo failure codes. */
export function antigravityFailureCode(message?: string): FailureCode {
  if (!message) return "coding_conversation_failed";
  if (
    /context(?:_|\s+)(?:window|length|limit)|too many tokens|maximum context/i.test(
      message,
    )
  )
    return "coding_context_exceeded";
  if (/rate limit|too many requests|\b429\b|resource_exhausted/i.test(message))
    return "coding_provider_rate_limited";
  if (/quota|usage limit|credit|billing|exhausted/i.test(message))
    return "coding_provider_usage_limit";
  if (
    /invalid model|not recognized as a known model|invalid argument|\b400\b/i.test(
      message,
    )
  )
    return "coding_provider_request_invalid";
  if (/sandbox|permission denied/i.test(message))
    return "coding_sandbox_failed";
  if (/connect|network|timeout|unavailable|\b50[234]\b|eof/i.test(message))
    return "coding_provider_unavailable";
  return "coding_conversation_failed";
}

function isSessionMissing(message?: string): boolean {
  if (!message) return false;
  return /conversation.*(?:not found|does not exist)|session.*(?:not found|missing)/i.test(
    message,
  );
}

/** Converts completed Antigravity CLI `step_update` events into safe transcript entries. */
export function antigravityTranscript(
  threadId: string,
  turnIndex: number,
  step: Record<string, unknown>,
  secrets: string[] = [],
): TranscriptEntry | undefined {
  if (step.state !== "DONE") return;
  const stepIndex = typeof step.step_index === "number" ? step.step_index : 0;
  const stepType = typeof step.step_type === "string" ? step.step_type : "";
  let role: "codex" | "activity" = "activity";
  let title: string | undefined;
  let text = "";

  if (stepType === "agent_response") {
    const raw = typeof step.text_delta === "string" ? step.text_delta : "";
    if (!raw.trim()) return;
    role = "codex";
    text = raw;
    try {
      const parsed = JSON.parse(raw);
      if (
        ["intent", "needs_input", "completed", "analysis"].includes(
          parsed?.status,
        ) &&
        typeof parsed.summary === "string"
      ) {
        text =
          parsed.summary +
          (typeof parsed.question === "string" && parsed.question
            ? `\n\n${parsed.question}`
            : "");
        title = "Task result";
      }
    } catch {}
  } else if (stepType === "tool") {
    const info =
      step.tool_info && typeof step.tool_info === "object"
        ? (step.tool_info as Record<string, unknown>)
        : {};
    const toolName =
      typeof step.tool_name === "string"
        ? step.tool_name
        : typeof info.name === "string"
          ? info.name
          : "tool";
    title = `Tool · ${toolName}`;
    const parts: string[] = [];
    if (info.parameters && typeof info.parameters === "object") {
      const params = info.parameters as Record<string, unknown>;
      if (typeof params.CommandLine === "string")
        parts.push(params.CommandLine);
      else if (typeof params.Path === "string") parts.push(params.Path);
    }
    if (typeof info.output === "string" && info.output.trim())
      parts.push(info.output);
    if (info.error && typeof info.error === "object") {
      const err = info.error as Record<string, unknown>;
      if (typeof err.message === "string") parts.push(`Error: ${err.message}`);
    }
    text = parts.join("\n").trim() || `${toolName} completed`;
  } else {
    return;
  }

  text = transcriptText(text, secrets);
  if (!text.trim()) return;
  return transcriptEntry.parse({
    id: `${threadId}:t${turnIndex}:s${stepIndex}`.slice(0, 400),
    at: new Date().toISOString(),
    role,
    text: text.slice(0, 12000),
    title,
    truncated: text.length > 12000 || undefined,
  });
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}

const agyUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  thinking_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

const agyResultSchema = z.object({
  conversation_id: z.string().optional(),
  status: z.string(),
  response: z.string().optional(),
  structured_output: z.unknown().optional(),
  error: z.string().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  usage: agyUsageSchema.optional(),
});

type ParsedAntigravityUsage = {
  tokens: number | undefined;
  tokenUsage:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning?: number;
        total?: number;
      }
    | undefined;
};

function toTokenUsage(
  usage?: z.infer<typeof agyUsageSchema>,
): ParsedAntigravityUsage {
  if (!usage) return { tokens: undefined, tokenUsage: undefined };
  const rawInput = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const reasoning = usage.thinking_tokens ?? 0;
  // In Antigravity CLI, input_tokens includes cache_read_tokens on the first turn
  // when input_tokens >= cache_read_tokens; clamp cleanly otherwise.
  const input =
    rawInput >= cacheRead ? Math.max(0, rawInput - cacheRead) : rawInput;
  const total = usage.total_tokens ?? input + cacheRead + output;
  const hasBreakdown =
    usage.input_tokens !== undefined || usage.output_tokens !== undefined;
  return {
    tokens: total,
    tokenUsage: hasBreakdown
      ? {
          input,
          output,
          cacheRead,
          cacheWrite: 0,
          reasoning,
          total,
        }
      : undefined,
  };
}

/**
 * Runs a structured development conversation against Antigravity CLI (`agy`)
 * using `--input-format stream-json --output-format stream-json`.
 */
export async function runAntigravityConversation(options: {
  binary?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  images?: DevelopmentMedia["images"];
  mediaDir?: string;
  schemaPath: string;
  model?: string;
  effort?: string;
  threadId?: string;
  readOnly?: boolean;
  protectCredentials?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: typeof developmentOutputSchema;
  channel?: JobTaskChannel;
}): Promise<{
  threadId: string;
  turnId: string;
  result: DevelopmentResult;
  tokens: number;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    total?: number;
  };
  usageUnknown: boolean;
  reconstructed: boolean;
  resultIssues?: ResultIssues;
}> {
  const schema = options.outputSchema ?? developmentOutputSchema;
  await writeFile(options.schemaPath, JSON.stringify(schema), { mode: 0o600 });

  let mediaNotice = "";
  if (options.images?.length && options.mediaDir) {
    await mkdir(options.mediaDir, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    for (let i = 0; i < options.images.length; i++) {
      const image = options.images[i];
      if (!image) continue;
      const ext = image.mimeType.split("/")[1] ?? "png";
      const file = join(options.mediaDir, `attachment-${i + 1}.${ext}`);
      await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
      paths.push(file);
    }
    if (paths.length) {
      mediaNotice = `\nAttached image files available for inspection: ${paths.join(", ")}\n`;
    }
  }

  const runSession = async (
    resumeThreadId: string | undefined,
    reconstructed: boolean,
  ) => {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--json-schema",
      options.schemaPath,
    ];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (resumeThreadId) args.push("--conversation", resumeThreadId);
    if (options.readOnly) {
      args.push("--mode", "plan");
    } else {
      args.push("--dangerously-skip-permissions");
    }

    const child = spawn(
      options.binary ?? process.env.TELO_AGY_BIN ?? "agy",
      args,
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const secretValues = Object.entries(options.env)
      .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD/.test(key))
      .map(([, value]) => value ?? "");

    let buffer = "";
    let stderrText = "";
    let threadId = resumeThreadId ?? "";
    let turnIndex = 0;
    let settled = false;
    let modelActivity = false;
    let lastUsage: ParsedAntigravityUsage = {
      tokens: undefined,
      tokenUsage: undefined,
    };
    let validationIssues: ResultIssues | undefined;

    type ResultPayload = z.infer<typeof agyResultSchema>;
    let resolveTurn: ((result: ResultPayload) => void) | undefined;
    let rejectTurn: ((error: Error) => void) | undefined;

    const decoder = new StringDecoder("utf8");

    const makeAuthError = () =>
      new CodexAuthError(
        threadId || undefined,
        lastUsage.tokens ?? (!modelActivity ? 0 : undefined),
        lastUsage.tokens === undefined && modelActivity,
      );

    const makeFailure = (code: FailureCode = "coding_conversation_failed") =>
      new CodexConversationError(
        code,
        threadId || undefined,
        lastUsage.tokens,
        validationIssues,
        lastUsage.tokens === undefined,
      );

    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectTurn?.(error);
      resolveTurn = undefined;
      rejectTurn = undefined;
      child.kill("SIGKILL");
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", () => stop(makeFailure()));
    child.on("error", () => stop(makeFailure("coding_codex_failed")));
    child.on("close", () => {
      if (!settled) {
        if (antigravityAuthFailure(stderrText)) {
          stop(makeAuthError());
        } else {
          stop(makeFailure(antigravityFailureCode(stderrText)));
        }
      }
    });

    child.stdout.on("data", (bytes: Buffer) => {
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) {
        stop(makeFailure());
        return;
      }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const eventType = parsed.event;
        if (
          eventType === "init" &&
          typeof parsed.conversation_id === "string" &&
          /^[a-zA-Z0-9-]{1,100}$/.test(parsed.conversation_id)
        ) {
          threadId = parsed.conversation_id;
          continue;
        }
        if (
          eventType === "step_update" &&
          parsed.step_update &&
          typeof parsed.step_update === "object"
        ) {
          const step = parsed.step_update as Record<string, unknown>;
          if (
            !threadId &&
            typeof step.conversation_id === "string" &&
            /^[a-zA-Z0-9-]{1,100}$/.test(step.conversation_id)
          ) {
            threadId = step.conversation_id;
          }
          if (step.step_type === "agent_response" || step.step_type === "tool")
            modelActivity = true;
          if (options.channel) {
            const entry = antigravityTranscript(
              threadId || "antigravity",
              turnIndex,
              step,
              secretValues,
            );
            if (entry) options.channel.record(entry);
          }
          continue;
        }
        if (
          eventType === "result" &&
          parsed.result &&
          typeof parsed.result === "object"
        ) {
          const checked = agyResultSchema.safeParse(parsed.result);
          if (!checked.success) {
            stop(makeFailure("coding_result_invalid"));
            return;
          }
          const result = checked.data;
          if (
            result.conversation_id &&
            /^[a-zA-Z0-9-]{1,100}$/.test(result.conversation_id)
          ) {
            threadId = result.conversation_id;
          }
          if (result.usage) {
            lastUsage = toTokenUsage(result.usage);
          }
          const finish = resolveTurn;
          resolveTurn = undefined;
          rejectTurn = undefined;
          finish?.(result);
        }
      }
    });

    const abort = () => stop(new Fault("coding_cancelled", 409));
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => stop(new Fault("coding_task_timeout", 409)),
            options.timeoutMs,
          );
    options.signal?.addEventListener("abort", abort, { once: true });

    const sendTurn = (content: string) =>
      new Promise<ResultPayload>((resolve, reject) => {
        if (settled) {
          reject(makeFailure());
          return;
        }
        resolveTurn = resolve;
        rejectTurn = reject;
        child.stdin.write(
          `${JSON.stringify({ event: "user", message: { content } })}\n`,
        );
      });

    try {
      if (options.signal?.aborted) throw new Fault("coding_cancelled", 409);

      let prompt = `${options.prompt}${mediaNotice}\nReturn ONLY valid JSON matching the supplied JSON schema.`;

      for (let correction = 0; correction <= 1; correction++) {
        turnIndex = correction;
        const result = await sendTurn(prompt);
        if (result.status !== "SUCCESS") {
          const combinedError = [result.error, stderrText]
            .filter(Boolean)
            .join("\n");
          if (
            resumeThreadId &&
            !reconstructed &&
            isSessionMissing(combinedError)
          ) {
            throw new Fault("coding_session_missing", 503);
          }
          if (antigravityAuthFailure(combinedError)) {
            throw makeAuthError();
          }
          throw makeFailure(antigravityFailureCode(combinedError));
        }

        const candidate =
          result.structured_output !== undefined &&
          result.structured_output !== null
            ? JSON.stringify(result.structured_output)
            : stripJsonCodeFence(result.response ?? "");

        if (Buffer.byteLength(candidate) > developmentResultByteLimit) {
          throw makeFailure("coding_result_invalid");
        }

        const parsed = parseDevelopmentResult(candidate);
        if (parsed.success) {
          settled = true;
          const finalThreadId =
            threadId && /^[a-zA-Z0-9-]{1,100}$/.test(threadId)
              ? threadId
              : randomUUID();
          return {
            threadId: finalThreadId,
            turnId: `turn-${result.num_turns ?? correction + 1}`,
            result: parsed.result,
            tokens: lastUsage.tokens ?? 0,
            ...(lastUsage.tokenUsage
              ? { tokenUsage: lastUsage.tokenUsage }
              : {}),
            usageUnknown: lastUsage.tokens === undefined,
            reconstructed,
            resultIssues: validationIssues,
          };
        }

        validationIssues = parsed.issues;
        if (correction) throw makeFailure(parsed.code);
        prompt = `Your previous turn completed, but its task result failed local validation. Correct only the final JSON using the same conversation and existing checkout. Do not redo implementation, run commands, modify files, publish, or weaken any fixed verification plan. Preserve original authorization and schema-pinned evidence. For completed, return one to eight nonblank verification commands including necessary preparation. For needs_input, return a nonblank question. Follow the supplied schema's field bounds. Safe validation issues: ${JSON.stringify(validationIssues)}. Return only the corrected JSON.`;
      }
      throw makeFailure();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      settled = true;
      try {
        child.stdin.end();
      } catch {}
      child.kill("SIGKILL");
      options.channel?.close();
      await options.channel?.flushTranscript();
    }
  };

  try {
    return await runSession(options.threadId, false);
  } catch (error) {
    if (
      options.threadId &&
      error instanceof Fault &&
      error.code === "coding_session_missing"
    ) {
      return await runSession(undefined, true);
    }
    throw error;
  }
}
