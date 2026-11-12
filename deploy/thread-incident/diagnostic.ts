import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { decodeBrowserWorkspace } from "../../src/browser/storage.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const workspaceId = "3b2dfe82-61c6-444e-8058-7a179f2bf27a";
const safeCode = (v: unknown) =>
  typeof v === "string" && /^[a-z][a-z0-9_]{0,90}$/.test(v) ? v : undefined;
function resultMeta(v: any): any {
  if (!v || typeof v !== "object") return { type: typeof v };
  return {
    keys: Object.keys(v),
    code: safeCode(v.code ?? v.error),
    status: safeCode(v.status),
    isError: v.isError,
    content: Array.isArray(v.content)
      ? v.content.map((p: any) => {
          if (p.type !== "text") return { type: p.type };
          try {
            return resultMeta(JSON.parse(p.text));
          } catch {
            return { type: "text", length: p.text?.length };
          }
        })
      : undefined,
  };
}
try {
  await pool.query("BEGIN READ ONLY");
  const { rows } = await pool.query("SELECT data FROM workspaces WHERE id=$1", [
    workspaceId,
  ]);
  const raw = rows[0]?.data;
  if (!raw) throw new Error("workspace_missing");
  const runs = raw.runs.filter(
    (r: any) =>
      r.actor === "105761681" &&
      r.topicId === 1996398 &&
      r.at >= "2026-11-05T00:00:00",
  );
  const ids = new Set(runs.map((r: any) => r.id));
  const key =
    process.env.ENCRYPTION_KEY ||
    readFileSync(process.env.ENCRYPTION_KEY_FILE!, "utf8").trim();
  const w = decodeBrowserWorkspace(
    {
      ...raw,
      runs,
      messages: [],
      threads: [],
      approvals: [],
      deliveries: raw.deliveries.filter((d: any) =>
        ids.has(d.runId ?? d.cancellationRunId),
      ),
    },
    key,
  );
  console.log(
    JSON.stringify({
      runs: w.runs.map((r) => ({
        id: r.id,
        threadId: r.threadId,
        at: r.at,
        finishedAt: r.finishedAt,
        status: r.status,
        error: r.error,
        cancelled: r.cancelled,
        browserWait: r.browserWait,
        browserResumed: r.browserResumed,
        resultLength: r.result?.length,
        attempts: r.attempts,
        tools: Object.entries(r.tools).map(([id, t]) => ({
          id,
          name: t.name,
          state: t.state,
          action: t.arguments?.action,
          result: resultMeta(t.result),
        })),
        transcript: r.transcript.map((m: any) => ({
          role: m.role,
          stopReason: m.stopReason,
          error: safeCode(m.errorMessage),
          toolName: m.toolName,
          isError: m.isError,
          content: m.content?.map((p: any) => ({
            type: p.type,
            name: p.name,
            textLength: p.text?.length,
            result:
              p.type === "text" && m.role === "toolResult"
                ? (() => {
                    try {
                      return resultMeta(JSON.parse(p.text));
                    } catch {
                      return undefined;
                    }
                  })()
                : undefined,
          })),
        })),
      })),
      deliveries: w.deliveries.map((d) => ({
        id: d.id,
        runId: d.runId,
        state: d.state,
        kind: d.kind,
        error: d.error,
        remoteId: d.remoteId,
        browserRequest: d.browserRequest,
        browserResume: d.browserResume,
        textLength: d.text?.length,
      })),
    }),
  );
  const { rows: logs } = await pool.query(
    "SELECT at,event,code,run_id FROM runtime_logs WHERE workspace_id=$1 AND run_id::text=ANY($2::text[]) ORDER BY at LIMIT 120",
    [workspaceId, [...ids]],
  );
  console.log(JSON.stringify({ logs }));
  await pool.query("ROLLBACK");
} catch {
  console.log(JSON.stringify({ diagnosticCode: "thread_inspection_failed" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
