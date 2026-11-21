import type { AgentTool } from "@earendil-works/pi-agent-core";

export const DEFAULT_PARALLEL_TOOL_CONCURRENCY = 4;

/**
 * Idempotent read-only built-in tools safe for bounded parallel execution.
 * Any mutating, approval-creating, browser-controlling, or external-dispatch
 * tool MUST remain omitted so it executes sequentially as a barrier.
 */
export const PARALLEL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Application read-only tools
  "query_memories",
  "query_discussions",
  "query_chat_history",
  "query_model_cost",
  "query_work_handoff",
  "read_chat_context",
  "read_instructions",
  "load_skill",
  "read_skill_source",
  "read_web",
  "search_tool",
  "inspect_missions",
  // Built-in GitHub read-only tools
  "find_connected_repository",
  "query_github_metadata",
  "query_github_pull_request",
  // Built-in Code Truth read-only tools
  "list_code_targets",
  "search_code",
  "search_code_batch",
  "get_code_context",
  "get_symbol_source",
  "get_file_excerpt",
  "get_dependency_manifests",
  "get_file_tree",
  // Built-in Obsidian read-only tools
  "obsidian_query",
  "obsidian_read",
  // Built-in Google & Search Console read-only tools
  "query_google_docs",
  "query_google_sheets",
  "query_google_drive",
  "query_gmail",
  "query_search_console",
  // Built-in Cloudflare read-only tool
  "query_cloudflare",
  // Built-in Nowledge Mem read-only tool
  "query_nowledge_mem",
  // Built-in coding status read-only tools
  "development_task_status",
  "development_task_conversation",
]);

/**
 * Read-only tools allowed inside a bounded depth-1 research subagent.
 * Explicitly excludes delegate_research, mission mutations, coding dispatch,
 * scheduling, approvals, browser control, and Telegram delivery tools.
 */
export const SUBAGENT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  ...PARALLEL_READ_ONLY_TOOLS,
]);

export function isParallelReadOnlyTool(name: string): boolean {
  return PARALLEL_READ_ONLY_TOOLS.has(name);
}

export function isSubagentSafeTool(name: string): boolean {
  return SUBAGENT_SAFE_TOOLS.has(name);
}

export function toolExecutionMode(
  name: string,
  builtin = true,
): "parallel" | "sequential" {
  return builtin && PARALLEL_READ_ONLY_TOOLS.has(name)
    ? "parallel"
    : "sequential";
}

export type ConcurrencyLimiter = <T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export function createConcurrencyLimiter(
  maxConcurrent = DEFAULT_PARALLEL_TOOL_CONCURRENCY,
): ConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const waiters: Array<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  const release = () => {
    active--;
    while (waiters.length > 0 && active < limit) {
      const next = waiters.shift();
      if (!next) break;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(next.signal.reason ?? new Error("Operation aborted"));
        continue;
      }
      active++;
      next.resolve();
    }
  };

  return async <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    if (active < limit) {
      active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const entry: (typeof waiters)[number] = {
          resolve,
          reject,
          signal,
        };
        if (signal) {
          const onAbort = () => {
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
            reject(signal.reason ?? new Error("Operation aborted"));
          };
          entry.onAbort = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        waiters.push(entry);
      });
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  };
}

export function wrapToolWithConcurrencyLimit(
  tool: AgentTool,
  runLimited: ConcurrencyLimiter,
): AgentTool {
  if (tool.executionMode !== "parallel") return tool;
  return {
    ...tool,
    execute: (callId, args, signal, onUpdate) =>
      runLimited(() => tool.execute(callId, args, signal, onUpdate), signal),
  };
}
