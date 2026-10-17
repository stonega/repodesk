import type { Run } from "../domain.ts";

export function runMessageEntries(
  run: Pick<Run, "task" | "transcript" | "result">,
) {
  const checkpoints = run.transcript.map((value) => {
    const message =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part?.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    const calls = content
      .filter(
        (part): part is { type: "toolCall"; name: string } =>
          part?.type === "toolCall" && typeof part.name === "string",
      )
      .map((part) => part.name);
    return {
      label:
        message.role === "assistant"
          ? "Assistant"
          : message.role === "toolResult"
            ? `Tool · ${typeof message.toolName === "string" ? message.toolName : "Result"}`
            : message.role === "user"
              ? "User"
              : "Checkpoint",
      text,
      calls,
    };
  });
  const entries = [
    { label: "Request", text: run.task, calls: [] },
    ...checkpoints,
  ];
  const lastAssistant = checkpoints.findLast(
    (entry) => entry.label === "Assistant" && entry.text,
  );
  if (run.result && run.result.trim() !== lastAssistant?.text.trim())
    entries.push({ label: "Final answer", text: run.result, calls: [] });
  return entries;
}

export function summarizeRun(
  run: Pick<Run, "task" | "transcript" | "result" | "tools" | "attempts">,
) {
  // The transcript also contains extension calls and calls blocked before execution.
  // Merge durable tool records by ID so checkpointed calls are counted only once.
  const toolIds = new Set(Object.keys(run.tools ?? {}));
  let anonymousCalls = 0;
  for (const value of run.transcript) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const part of message.content) {
      if (part?.type !== "toolCall") continue;
      if (typeof part.id === "string" && part.id) toolIds.add(part.id);
      else anonymousCalls++;
    }
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let tokenAttempts = 0;
  let costAttempts = 0;
  let cost = 0;
  for (const attempt of run.attempts) {
    if (attempt.tokens) {
      tokenAttempts++;
      tokens.input += attempt.tokens.input;
      tokens.output += attempt.tokens.output;
      tokens.cacheRead += attempt.tokens.cacheRead;
      tokens.cacheWrite += attempt.tokens.cacheWrite;
    }
    if (attempt.actual !== undefined) {
      costAttempts++;
      cost += attempt.actual;
    }
  }
  // Pi usage separates uncached input, cache reads and cache writes.
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return {
    messages: runMessageEntries(run).length,
    toolCalls: toolIds.size + anonymousCalls,
    attempts: run.attempts.length,
    tokenAttempts,
    costAttempts,
    tokens: tokenAttempts || !run.attempts.length ? tokens : undefined,
    input,
    totalTokens: input + tokens.output,
    cacheHitRate: input > 0 ? tokens.cacheRead / input : undefined,
    cost: costAttempts || !run.attempts.length ? cost : undefined,
  };
}
