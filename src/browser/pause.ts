import type {
  AgentMessage,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { Run } from "../domain.ts";
import { browserTools } from "./config.ts";

/** A persisted wait proves only a waiting intent, never a successful website effect. */
export function restoreBrowserPause(run: Run) {
  const wait = run.browserWait;
  if (!wait) return false;
  const transcript = run.transcript as AgentMessage[];
  const assistant = transcript.findLast(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "toolCall" && part.id === wait.callId,
      ),
  );
  if (assistant?.role !== "assistant") return false;
  const calls = assistant.content.filter((part) => part.type === "toolCall");
  const index = calls.findIndex((call) => call.id === wait.callId);
  const call = calls[index],
    saved = run.tools[wait.callId];
  if (
    !call ||
    !saved ||
    saved.name !== call.name ||
    (!(browserTools as readonly string[]).includes(call.name) &&
      wait.toolName !== call.name)
  )
    return false;
  const receipt = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "waiting",
          kind: wait.kind,
          requestId: wait.id,
          expiresAt: wait.expiresAt,
        }),
      },
    ],
    details: {},
  };
  const missing: AgentMessage[] = [];
  for (const [position, tool] of calls.entries()) {
    if (
      transcript.some(
        (message) =>
          message.role === "toolResult" && message.toolCallId === tool.id,
      )
    )
      continue;
    const prior = run.tools[tool.id];
    if (position < index && prior?.state !== "done") return false;
    const result: AgentToolResult<unknown> =
      tool.id === wait.callId
        ? receipt
        : prior?.state === "done"
          ? (prior.result as AgentToolResult<unknown>)
          : {
              content: [{ type: "text", text: "browser_waiting" }],
              details: {},
            };
    missing.push({
      role: "toolResult",
      toolCallId: tool.id,
      toolName: tool.name,
      ...result,
      isError: tool.id !== wait.callId && prior?.state !== "done",
      timestamp: Date.now(),
    });
  }
  saved.state = "done";
  saved.result = receipt;
  run.transcript.push(...missing);
  run.status = "awaiting_approval";
  delete run.leaseUntil;
  delete run.result;
  return true;
}
