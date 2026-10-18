import { z } from "zod";

export const transcriptEntry = z.object({
  id: z.string().min(1).max(400),
  at: z.iso.datetime(),
  role: z.enum(["codex", "activity"]),
  text: z.string().max(12000),
  title: z.string().max(200).optional(),
  truncated: z.boolean().optional(),
  sequence: z.number().int().nonnegative().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntry>;
export const transcriptPage = z.object({
  entries: z.array(transcriptEntry).max(64),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/** Defense in depth: credentials are never deliberately collected as transcript data. */
export function transcriptText(value: string, secrets: string[] = []) {
  let text = value;
  for (const secret of secrets.filter((s) => s.length >= 8))
    text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(
      /\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,})\b/g,
      "[redacted]",
    )
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[redacted]")
    .replace(
      /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|client[_-]?secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    );
}

/** Only public assistant messages and an explicit activity allowlist leave app-server. */
export function codexTranscript(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  secrets: string[] = [],
): TranscriptEntry | undefined {
  if (typeof item.id !== "string") return;
  let text = "";
  let title: string | undefined;
  const role = item.type === "agentMessage" ? "codex" : "activity";
  if (item.type === "agentMessage" && typeof item.text === "string") {
    text = item.text;
    try {
      const result = JSON.parse(text);
      if (
        ["intent", "needs_input", "completed", "analysis"].includes(
          result?.status,
        ) &&
        typeof result.summary === "string"
      ) {
        text =
          result.summary +
          (typeof result.question === "string" && result.question
            ? `\n\n${result.question}`
            : "");
        title = "Task result";
      }
    } catch {
      /* Ordinary assistant text remains verbatim. */
    }
  } else if (item.type === "commandExecution") {
    title = `Command · ${String(item.status ?? "completed")}`;
    text = `${String(item.command ?? "")}\n${String(item.aggregatedOutput ?? "")}`;
  } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
    title = "File changes";
    text = item.changes
      .map((c) => (typeof c?.path === "string" ? c.path : ""))
      .join("\n");
  } else if (item.type === "mcpToolCall") {
    title = "Tool activity";
    text = `${String(item.server ?? "")}/${String(item.tool ?? "")} · ${String(item.status ?? "completed")}`;
  } else return;
  text = transcriptText(text, secrets);
  if (!text.trim()) return;
  return transcriptEntry.parse({
    id: `${threadId}:${turnId}:${item.id}`.slice(0, 400),
    at: new Date().toISOString(),
    role,
    text: text.slice(0, 12000),
    title,
    truncated: text.length > 12000 || undefined,
  });
}
