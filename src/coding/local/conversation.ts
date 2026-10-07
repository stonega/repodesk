import { spawn } from "node:child_process";
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
import { CodexAuthError, codexAuthFailure } from "./auth-failure.ts";
import {
  CodexConversationError,
  conversationFailureCode,
  conversationFailureCodes,
} from "./conversation-failure.ts";

/** Private JSONL client. Only completed turns cross the durable application boundary. */
export async function runConversation(options: {
  binary?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  images?: DevelopmentMedia["images"];
  threadId?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: typeof developmentOutputSchema;
}): Promise<{
  threadId: string;
  turnId: string;
  result: DevelopmentResult;
  tokens: number;
  usageUnknown: boolean;
  reconstructed: boolean;
  resultIssues?: ResultIssues;
}> {
  const child = spawn(
    options.binary ?? "codex",
    options.args ?? ["app-server"],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let sequence = 0,
    buffer = "",
    final = "",
    threadId = "",
    turnId = "";
  let priorTokens = 0,
    priorUsageUnknown = false;
  let validationIssues: ResultIssues | undefined;
  let settled = false,
    reconstructed = false;
  let turnStarted = false;
  let authFailed = false;
  let modelActivity = false;
  let turnError: unknown;
  const authFailure = () =>
    new CodexAuthError(
      threadId || undefined,
      usageSummary(!modelActivity).tokens,
      usageSummary(!modelActivity).usageUnknown,
    );
  const usageByTurn = new Map<string, { tokens: number; total: number }>();
  const usageSummary = (deniedBeforeActivity = false) => {
    const current =
      usageByTurn.get(turnId)?.tokens ?? (deniedBeforeActivity ? 0 : undefined);
    return {
      tokens:
        current !== undefined || priorTokens > 0
          ? priorTokens + (current ?? 0)
          : undefined,
      usageUnknown: priorUsageUnknown || current === undefined,
    };
  };
  const decoder = new StringDecoder("utf8");
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
    }
  >();
  let complete!: () => void, fail!: (e: Error) => void;
  let completion = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // Observe early failures even while the handshake awaits its response.
  void completion.catch(() => {});
  const failure = (
    code: (typeof conversationFailureCodes)[number] = "coding_conversation_failed",
  ) =>
    new CodexConversationError(
      code,
      threadId || undefined,
      usageSummary().tokens,
      validationIssues,
      usageSummary().usageUnknown,
    );
  const stop = (error: Error) => {
    if (settled) return;
    settled = true;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    fail(error);
    child.kill("SIGKILL");
  };
  const write = (value: unknown) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (settled) {
        reject(failure());
        return;
      }
      const id = ++sequence;
      pending.set(id, { method, resolve, reject });
      write({ id, method, params });
    });
  child.stdin.on("error", () => stop(failure()));
  child.on("error", () => stop(failure()));
  child.on("close", () => {
    if (!settled) stop(failure());
  });
  child.stdout.on("data", (bytes: Buffer) => {
    buffer += decoder.write(bytes);
    if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) {
      stop(failure());
      return;
    }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (typeof message.id === "number" && pending.has(message.id)) {
          const p = pending.get(message.id);
          if (!p) continue;
          // Bind the turn before draining notifications in this same stdout chunk.
          // Resolving the promise alone defers the awaiting caller until after them.
          if (!message.error && p.method === "turn/start")
            turnId = z
              .object({ turn: z.object({ id: z.string() }) })
              .parse(message.result).turn.id;
          pending.delete(message.id);
          if (message.error)
            p.reject(
              codexAuthFailure(message.error) ||
                codexAuthFailure(message.error.data)
                ? authFailure()
                : new Fault(
                    message.error.code === -32600 &&
                      /not found|does not exist|no rollout/i.test(
                        String(message.error.message),
                      )
                      ? "coding_session_missing"
                      : conversationFailureCode(
                          message.error.data ?? message.error,
                        ),
                    503,
                  ),
            );
          else p.resolve(message.result);
          continue;
        }
        if (message.id !== undefined && message.method) {
          // No implicit approval or connection-local user wait. Questions use completed-turn envelopes.
          write({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Use completed-turn task results; this request is unsupported.",
            },
          });
          continue;
        }
        const p = message.params;
        if (p?.threadId && threadId && p.threadId !== threadId) continue;
        if (p?.turnId && turnId && p.turnId !== turnId) continue;
        if (
          (message.method === "item/started" ||
            message.method === "item/completed") &&
          p?.item?.type &&
          p.item.type !== "userMessage"
        )
          modelActivity = true;
        if (message.method === "error" && p?.willRetry !== true) {
          authFailed = codexAuthFailure(p?.error);
          turnError = p?.error;
        }
        if (
          message.method === "item/completed" &&
          p?.item?.type === "agentMessage" &&
          (!p.item.phase || p.item.phase === "final_answer")
        ) {
          final = String(p.item.text);
          if (Buffer.byteLength(final) > developmentResultByteLimit)
            stop(failure());
        }
        if (
          message.method === "thread/tokenUsage/updated" &&
          turnStarted &&
          typeof p?.turnId === "string"
        ) {
          const usage = p.tokenUsage?.last;
          const total = p.tokenUsage?.total?.totalTokens;
          if (
            Number.isSafeInteger(total) &&
            total >= 0 &&
            Number.isSafeInteger(usage?.totalTokens) &&
            usage.totalTokens >= 0
          ) {
            const prior = usageByTurn.get(p.turnId);
            usageByTurn.set(p.turnId, {
              tokens:
                (prior?.tokens ?? 0) +
                (prior ? Math.max(0, total - prior.total) : usage.totalTokens),
              total,
            });
          }
        }
        if (message.method === "turn/started" && turnStarted)
          turnId = p?.turn?.id ?? turnId;
        if (
          message.method === "turn/completed" &&
          turnStarted &&
          (!turnId || p?.turn?.id === turnId)
        ) {
          if (p?.turn?.status !== "completed") {
            stop(
              codexAuthFailure(p.turn.error) || authFailed
                ? authFailure()
                : failure(conversationFailureCode(p.turn.error ?? turnError)),
            );
            return;
          }
          turnId = p.turn.id;
          complete();
        }
      } catch {
        stop(failure());
        return;
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
  try {
    if (options.signal?.aborted) throw new Fault("coding_cancelled", 409);
    await request("initialize", {
      clientInfo: { name: "repodesk", version: "1" },
      capabilities: { experimentalApi: false },
    });
    write({ method: "initialized" });
    const config = {
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: options.readOnly ? "read-only" : "danger-full-access",
    };
    let started: unknown;
    if (options.threadId) {
      try {
        started = await request("thread/resume", {
          ...config,
          threadId: options.threadId,
        });
      } catch (error) {
        if (
          !(error instanceof Fault) ||
          error.code !== "coding_session_missing"
        )
          throw error;
        reconstructed = true;
        started = await request("thread/start", config);
      }
    } else started = await request("thread/start", config);
    threadId = z.object({ thread: z.object({ id: z.string() }) }).parse(started)
      .thread.id;
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(threadId)) throw failure();
    let prompt = options.prompt;
    // One result-only correction stays in this thread/checkout. This does not
    // retry failed execution, authentication, verification or external writes.
    for (let correction = 0; correction <= 1; correction++) {
      final = "";
      turnId = "";
      authFailed = false;
      turnError = undefined;
      modelActivity = false;
      completion = new Promise<void>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      void completion.catch(() => {});
      turnStarted = true;
      const begun = await request("turn/start", {
        threadId,
        input: [
          { type: "text", text: prompt, text_elements: [] },
          ...(correction === 0 ? (options.images ?? []) : []).map((image) => ({
            type: "image",
            url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
        ...(correction ? { sandboxPolicy: { type: "readOnly" } } : {}),
        outputSchema: options.outputSchema ?? developmentOutputSchema,
      });
      turnId = z.object({ turn: z.object({ id: z.string() }) }).parse(begun)
        .turn.id;
      await completion;
      const parsed = parseDevelopmentResult(final);
      if (parsed.success) {
        const usage = usageSummary();
        settled = true;
        return {
          threadId,
          turnId,
          result: parsed.result,
          tokens: usage.tokens ?? 0,
          usageUnknown: usage.usageUnknown,
          reconstructed,
          resultIssues: validationIssues,
        };
      }
      validationIssues = parsed.issues;
      if (correction) throw failure(parsed.code);
      priorTokens += usageByTurn.get(turnId)?.tokens ?? 0;
      priorUsageUnknown ||= !usageByTurn.has(turnId);
      prompt = `Your previous turn completed, but its task result failed local validation. Correct only the final JSON using the same thread and existing checkout. Do not redo implementation, run commands, modify files, publish, or weaken any fixed verification plan. Preserve original authorization and schema-pinned evidence. For completed, return one to eight nonblank verification commands including necessary preparation. For needs_input, return a nonblank question. Follow the supplied schema's field bounds. Safe validation issues: ${JSON.stringify(validationIssues)}. Return only the corrected JSON.`;
    }
    throw failure();
  } catch (error) {
    if (
      error instanceof CodexAuthError ||
      error instanceof CodexConversationError
    )
      throw error;
    if (
      error instanceof Fault &&
      conversationFailureCodes.some((code) => code === error.code)
    )
      throw failure(error.code as (typeof conversationFailureCodes)[number]);
    throw failure();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    settled = true;
    for (const p of pending.values()) p.reject(failure());
    pending.clear();
    child.stdin.end();
    child.kill("SIGKILL");
  }
}
