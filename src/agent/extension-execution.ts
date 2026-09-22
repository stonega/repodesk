import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { runAllowed } from "../workspaces/policy.ts";
import { inputByteLimit } from "./limits.ts";
import { type AgentInput, selectedModel } from "./runtime.ts";

/** Reserve before execution; an unknown outcome is never automatically replayed. */
export function extensionToolExecution(
  store: Store,
  workspaceId: string,
  runId: string,
  fence: number,
  signal: AbortSignal,
): NonNullable<AgentInput["extensionTool"]> {
  return async (name, callId, execute) => {
    signal.throwIfAborted();
    const prior = await store.change(workspaceId, (w) => {
      const run = w.runs.find((r) => r.id === runId);
      requireThat(
        run &&
          run.fence === fence &&
          run.status === "running" &&
          runAllowed(w, run),
        "tool_policy_denied",
        403,
      );
      const saved = Object.hasOwn(run.tools, callId)
        ? run.tools[callId]
        : undefined;
      if (saved) {
        requireThat(
          saved.name === name && saved.state === "done",
          "extension_tool_outcome_unknown",
          409,
        );
        return saved.result as AgentToolResult<unknown>;
      }
      Object.defineProperty(run.tools, callId, {
        value: { name, state: "started" },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    if (prior) return prior;
    const result = await execute();
    signal.throwIfAborted();
    await store.change(workspaceId, (w) => {
      const run = w.runs.find((r) => r.id === runId);
      requireThat(
        run &&
          run.fence === fence &&
          run.status === "running" &&
          runAllowed(w, run),
        "tool_policy_denied",
        403,
      );
      const model = selectedModel(run.model, run.modelOptions);
      requireThat(
        Buffer.byteLength(JSON.stringify(result)) <=
          inputByteLimit(
            {},
            {
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxTokens,
            },
          ),
        "extension_result_too_large",
        409,
      );
      run.tools[callId] = { name, state: "done", result };
    });
    return result;
  };
}
