import { Hono } from "hono";
import { z } from "zod";
import type { DevelopmentTask } from "../coding/development.ts";
import { codingStatusLabel } from "../coding/feedback.ts";
import { taskGet, taskInputs } from "../coding/task-store.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import { transcriptText } from "../coding/transcript.ts";
import type { Store } from "../db/repositories.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { decrypt } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import { retainedSource } from "../workspaces/threads.ts";
import { resolveTaskReference, telegramIdentity } from "./auth.ts";

export interface HistoryItem {
  id: string;
  at: string;
  role: "user" | "chat_agent" | "codex" | "activity";
  text: string;
  title?: string;
  truncated?: boolean;
  state?: string;
  author?: string;
}
export interface TaskHistory {
  task: {
    title: string;
    repository: string;
    status: string;
    state: string;
    prUrl?: string;
  };
  items: HistoryItem[];
  before?: string;
  after?: string;
  hasMore: boolean;
  recordingAvailable: boolean;
}
const cursor = z.tuple([z.iso.datetime(), z.string().min(1).max(500)]);
const encodeCursor = (value: [string, string]) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const encode = (item: HistoryItem) => encodeCursor([item.at, item.id]);
function decode(value?: string) {
  if (!value) return undefined;
  try {
    return cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    requireThat(false, "miniapp_cursor_invalid", 400);
  }
}
export function historyAudience(
  w: Workspace,
  task: DevelopmentTask,
  actor: string,
  botId?: string,
) {
  requireThat(
    !task.contentRemoved && task.botId === botId,
    "miniapp_task_unavailable",
    404,
  );
  requireThat(
    task.chatId !== task.actor || task.actor === actor,
    "access_denied",
    403,
  );
  checkDevelopment(w, task, actor, false, true);
}

export function miniAppRoutes(
  store: Store,
  setup: SetupService,
  encryptionKey: string,
) {
  const app = new Hono();
  app.post("/history", async (c) => {
    c.header("Cache-Control", "no-store");
    const input = z
      .object({
        initData: z.string().max(16384),
        reference: z.string().max(100),
        before: z.string().max(1500).optional(),
        after: z.string().max(1500).optional(),
      })
      .strict()
      .parse(await c.req.json());
    requireThat(!(input.before && input.after), "miniapp_cursor_invalid", 400);
    const deployment = await store.deployment();
    requireThat(
      deployment.credentials.bot && deployment.bot,
      "miniapp_unavailable",
      503,
    );
    const { actor } = telegramIdentity(
      input.initData,
      decrypt(encryptionKey, "bot", deployment.credentials.bot),
    );
    const { workspaceId, taskId } = resolveTaskReference(input.reference);
    let w = await store.read(workspaceId);
    let task = await taskGet(store.pool, workspaceId, taskId);
    historyAudience(w, task, actor, deployment.bot.id);
    if (task.chatId !== task.actor) {
      const member = await (await setup.client()).call<{
        status: string;
        is_member?: boolean;
      }>("getChatMember", { chat_id: task.chatId, user_id: actor });
      requireThat(
        ["creator", "administrator", "member"].includes(member.status) ||
          (member.status === "restricted" && member.is_member === true),
        "access_denied",
        403,
      );
      w = await store.read(workspaceId);
      task = await taskGet(store.pool, workspaceId, taskId);
      historyAudience(w, task, actor, (await store.deployment()).bot?.id);
    }
    const inputs = await taskInputs(store.pool, task);
    const refs =
      (
        await store.pool.query(
          "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id='context'",
          [workspaceId, taskId],
        )
      ).rows[0]?.data?.sources ?? [];
    const exchanges = await store.pool.query(
      "SELECT data FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:message:%'",
      [workspaceId, taskId],
    );
    requireThat(
      inputs.length &&
        [
          ...inputs.map((i) => i.sourceId),
          ...refs.map((r: { id: string }) => r.id),
          ...exchanges.rows.flatMap((row) => row.data.sourceIds ?? []),
        ].every((id) =>
          w.messages.some(
            (s) =>
              s.id === id &&
              retainedSource(w, s) &&
              (task.chatId === task.actor ||
                (s.chatId === task.chatId && s.topicId === task.topicId)),
          ),
        ),
      "miniapp_history_expired",
      410,
    );
    const bound = decode(input.before ?? input.after);
    const direction = input.after ? "ASC" : "DESC";
    const rows = await store.pool.query(
      `
      WITH timeline AS (
        SELECT 'native:'||coalesce(data->>'attemptId','')||':'||lpad(coalesce(data->>'sequence','0'),20,'0')||':'||id AS id, data->>'at' AS at, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at, data FROM coding_task_events
        WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'transcript:item:%'
        UNION ALL
        SELECT 'input:'||revision, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          jsonb_build_object('role','user','actor',data->>'actor','text',data->>'text','state',CASE WHEN revision<=$5 THEN 'read' WHEN revision<=$6 THEN 'accepted' ELSE 'queued' END)
        FROM coding_task_inputs WHERE workspace_id=$1 AND task_id=$2
        UNION ALL
        SELECT id||':question', data->>'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),jsonb_build_object('role','chat_agent','text',data->>'question','state',data->>'state')
        FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:message:%'
        UNION ALL
        SELECT id||':answer', coalesce(data->>'answeredAt',data->>'createdAt'),to_char(coalesce(data->>'answerRecordedAt',data->>'answeredAt',data->>'createdAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),jsonb_build_object('role','codex','text',data->>'answer')
        FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:message:%' AND data->>'answer' IS NOT NULL
        UNION ALL
        SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),jsonb_build_object('role','codex','title','Reported progress','text',data->>'text')
        FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'conversation:progress:%'
      ) SELECT *, (SELECT jsonb_build_array(received_at,id) FROM timeline ORDER BY received_at DESC,id DESC LIMIT 1) AS highwater FROM timeline WHERE ($3::text IS NULL OR (${input.after ? "received_at" : "at"},id) ${input.after ? ">" : "<"} ($3,$4)) ORDER BY ${input.after ? "received_at" : "at"} ${direction},id ${direction} LIMIT 51`,
      [
        workspaceId,
        taskId,
        bound?.[0] ?? null,
        bound?.[1] ?? null,
        task.readRevision ?? 0,
        task.consumedRevision,
      ],
    );
    const items: HistoryItem[] = rows.rows.slice(0, 50).map((r) => ({
      ...r.data,
      id: r.id,
      at: r.at,
      text: transcriptText(String(r.data.text ?? "")),
      author:
        r.data.role === "user"
          ? r.data.actor === actor
            ? "You"
            : (w.members.find((member) => member.id === r.data.actor)?.name ??
              `User ${r.data.actor}`)
          : undefined,
    }));
    if (!input.after) items.reverse();
    const recordingAvailable = !!(
      await store.pool.query(
        "SELECT 1 FROM coding_task_events WHERE workspace_id=$1 AND task_id=$2 AND id LIKE 'transcript:cursor:%' LIMIT 1",
        [workspaceId, taskId],
      )
    ).rowCount;
    const lastArrival = rows.rows.slice(0, 50).at(-1);
    const result: TaskHistory = {
      task: {
        title: transcriptText(task.payload.title),
        repository: task.payload.repository,
        status: codingStatusLabel(task),
        state: task.state,
        prUrl: task.pr?.url,
      },
      items,
      before: items[0] ? encode(items[0]) : input.before,
      after: input.after
        ? lastArrival
          ? encodeCursor([lastArrival.received_at, lastArrival.id])
          : input.after
        : rows.rows[0]?.highwater
          ? encodeCursor(rows.rows[0].highwater)
          : undefined,
      hasMore: rows.rows.length > 50,
      recordingAvailable,
    };
    return c.json(result);
  });
  return app;
}
