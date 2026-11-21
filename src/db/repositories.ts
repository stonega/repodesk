import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  decodeBrowserWorkspace,
  encodeBrowserRun,
  encodeBrowserWorkspace,
} from "../browser/storage.ts";
import {
  type Audit,
  type Delivery,
  type Deployment,
  Fault,
  type Run,
  type Source,
  type Workspace,
} from "../domain.ts";
import { RuntimeLogger } from "../observability/logs.ts";
import { ensureTelegramWidgetSkill } from "../skills/telegram-widgets.ts";
import { syncWorkspaceUsageLedger } from "../usage/model-usage.ts";
import { type Sql, transaction } from "./pool.ts";

type RecordEntry = { seq: number; json: string };
interface WorkspaceSnapshot {
  coreJson: string;
  legacyInline: boolean;
  lockedSql?: Sql;
  messages: Map<string, RecordEntry>;
  runs: Map<string, RecordEntry>;
  deliveries: Map<string, RecordEntry>;
  audit: Map<string, RecordEntry>;
  queuedRunIds: Set<string>;
  pendingDeliveryIds: Set<string>;
}

const snapshots = new WeakMap<Workspace, WorkspaceSnapshot>();

function workspaceDefaults(workspace: Workspace): Workspace {
  workspace.settings.currency ??= "USD";
  workspace.messages ??= [];
  workspace.runs ??= [];
  workspace.deliveries ??= [];
  workspace.audit ??= [];
  ensureTelegramWidgetSkill(workspace);
  return workspace;
}

/** Strips high-frequency collections stored in dedicated relational tables. */
export function coreWorkspaceData(
  workspace: Workspace,
): Omit<Workspace, "messages" | "runs" | "deliveries" | "audit"> {
  const {
    messages: _messages,
    runs: _runs,
    deliveries: _deliveries,
    audit: _audit,
    ...core
  } = workspace;
  return core;
}

function indexRecords<T extends { id: string }>(
  records: T[],
): Map<string, RecordEntry> {
  const map = new Map<string, RecordEntry>();
  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    if (item) map.set(item.id, { seq: i + 1, json: JSON.stringify(item) });
  }
  return map;
}

function deduplicateById<T extends { id: string }>(
  records: T[],
): { item: T; seq: number; json: string }[] {
  const seen = new Map<string, number>();
  const out: { item: T; seq: number; json: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    if (!item) continue;
    const entry = { item, seq: i + 1, json: JSON.stringify(item) };
    const existing = seen.get(item.id);
    if (existing !== undefined) out[existing] = entry;
    else {
      seen.set(item.id, out.length);
      out.push(entry);
    }
  }
  return out;
}

function captureSnapshot(
  encoded: Workspace,
  legacyInline: boolean,
  lockedSql?: Sql,
): WorkspaceSnapshot {
  return {
    coreJson: JSON.stringify(coreWorkspaceData(encoded)),
    legacyInline,
    lockedSql,
    messages: indexRecords(encoded.messages),
    runs: indexRecords(encoded.runs),
    deliveries: indexRecords(encoded.deliveries),
    audit: indexRecords(encoded.audit),
    queuedRunIds: new Set(
      encoded.runs.filter((r) => r.status === "queued").map((r) => r.id),
    ),
    pendingDeliveryIds: new Set(
      encoded.deliveries.filter((d) => d.state === "pending").map((d) => d.id),
    ),
  };
}

function diffRecords<T extends { id: string }>(
  records: T[],
  previous?: Map<string, RecordEntry>,
) {
  const deduped = deduplicateById(records);
  if (!previous)
    return {
      replaceAll: true,
      removed: [] as string[],
      upserts: deduped,
    };
  const currentIds = new Set(deduped.map((e) => e.item.id));
  const removed: string[] = [];
  for (const id of previous.keys()) if (!currentIds.has(id)) removed.push(id);
  const upserts = deduped.filter((entry) => {
    const prev = previous.get(entry.item.id);
    return !prev || prev.seq !== entry.seq || prev.json !== entry.json;
  });
  return { replaceAll: false, removed, upserts };
}

async function syncMessages(
  sql: Sql,
  workspaceId: string,
  records: Source[],
  previous?: Map<string, RecordEntry>,
) {
  const { replaceAll, removed, upserts } = diffRecords(records, previous);
  if (replaceAll) {
    const keep = upserts.map((u) => u.item.id);
    if (keep.length)
      await sql.query(
        "DELETE FROM workspace_messages WHERE workspace_id=$1 AND NOT (id = ANY($2::text[]))",
        [workspaceId, keep],
      );
    else
      await sql.query("DELETE FROM workspace_messages WHERE workspace_id=$1", [
        workspaceId,
      ]);
  } else if (removed.length) {
    await sql.query(
      "DELETE FROM workspace_messages WHERE workspace_id=$1 AND id = ANY($2::text[])",
      [workspaceId, removed],
    );
  }
  if (!upserts.length) return;
  await sql.query(
    `INSERT INTO workspace_messages(workspace_id,id,seq,chat_id,thread_id,created_at,data)
     SELECT $1, u.id, u.seq, u.chat_id, u.thread_id, u.created_at, u.data
     FROM UNNEST($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::jsonb[])
       AS u(id,seq,chat_id,thread_id,created_at,data)
     ON CONFLICT(workspace_id,id) DO UPDATE SET
       seq=excluded.seq,
       chat_id=excluded.chat_id,
       thread_id=excluded.thread_id,
       created_at=excluded.created_at,
       data=excluded.data`,
    [
      workspaceId,
      upserts.map((u) => u.item.id),
      upserts.map((u) => u.seq),
      upserts.map((u) => u.item.chatId ?? ""),
      upserts.map((u) => u.item.threadId ?? null),
      upserts.map((u) => u.item.at ?? ""),
      upserts.map((u) => u.json),
    ],
  );
}

async function syncRuns(
  sql: Sql,
  workspaceId: string,
  records: Run[],
  previous?: Map<string, RecordEntry>,
): Promise<Run[]> {
  const { replaceAll, removed, upserts } = diffRecords(records, previous);
  if (replaceAll) {
    const keep = upserts.map((u) => u.item.id);
    if (keep.length)
      await sql.query(
        "DELETE FROM workspace_runs WHERE workspace_id=$1 AND NOT (id = ANY($2::text[]))",
        [workspaceId, keep],
      );
    else
      await sql.query("DELETE FROM workspace_runs WHERE workspace_id=$1", [
        workspaceId,
      ]);
  } else if (removed.length) {
    await sql.query(
      "DELETE FROM workspace_runs WHERE workspace_id=$1 AND id = ANY($2::text[])",
      [workspaceId, removed],
    );
  }
  if (!upserts.length) return [];
  await sql.query(
    `INSERT INTO workspace_runs(workspace_id,id,seq,status,workflow_id,thread_id,actor,chat_id,topic_id,draft_id,draft_bot_id,mission_id,created_at,data)
     SELECT $1, u.id, u.seq, u.status, u.workflow_id, u.thread_id, u.actor, u.chat_id, u.topic_id, u.draft_id, u.draft_bot_id, u.mission_id, u.created_at, u.data
     FROM UNNEST($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::bigint[],$11::text[],$12::text[],$13::text[],$14::jsonb[])
       AS u(id,seq,status,workflow_id,thread_id,actor,chat_id,topic_id,draft_id,draft_bot_id,mission_id,created_at,data)
     ON CONFLICT(workspace_id,id) DO UPDATE SET
       seq=excluded.seq,
       status=excluded.status,
       workflow_id=excluded.workflow_id,
       thread_id=excluded.thread_id,
       actor=excluded.actor,
       chat_id=excluded.chat_id,
       topic_id=excluded.topic_id,
       draft_id=excluded.draft_id,
       draft_bot_id=excluded.draft_bot_id,
       mission_id=excluded.mission_id,
       created_at=excluded.created_at,
       data=excluded.data`,
    [
      workspaceId,
      upserts.map((u) => u.item.id),
      upserts.map((u) => u.seq),
      upserts.map((u) => u.item.status ?? ""),
      upserts.map((u) => u.item.workflowId ?? null),
      upserts.map((u) => u.item.threadId ?? null),
      upserts.map((u) => u.item.actor ?? ""),
      upserts.map((u) => u.item.chatId ?? ""),
      upserts.map((u) =>
        Number.isSafeInteger(u.item.topicId) ? u.item.topicId : 0,
      ),
      upserts.map((u) =>
        Number.isSafeInteger(u.item.telegramDraft?.id)
          ? u.item.telegramDraft?.id
          : null,
      ),
      upserts.map((u) => u.item.telegramDraft?.botId ?? null),
      upserts.map((u) => u.item.missionId ?? null),
      upserts.map((u) => u.item.at ?? ""),
      upserts.map((u) => u.json),
    ],
  );
  return upserts.map((u) => u.item);
}

async function syncDeliveries(
  sql: Sql,
  workspaceId: string,
  records: Delivery[],
  previous?: Map<string, RecordEntry>,
) {
  const { replaceAll, removed, upserts } = diffRecords(records, previous);
  if (replaceAll) {
    const keep = upserts.map((u) => u.item.id);
    if (keep.length)
      await sql.query(
        "DELETE FROM workspace_deliveries WHERE workspace_id=$1 AND NOT (id = ANY($2::text[]))",
        [workspaceId, keep],
      );
    else
      await sql.query(
        "DELETE FROM workspace_deliveries WHERE workspace_id=$1",
        [workspaceId],
      );
  } else if (removed.length) {
    await sql.query(
      "DELETE FROM workspace_deliveries WHERE workspace_id=$1 AND id = ANY($2::text[])",
      [workspaceId, removed],
    );
  }
  if (!upserts.length) return;
  await sql.query(
    `INSERT INTO workspace_deliveries(workspace_id,id,seq,state,run_id,chat_id,created_at,data)
     SELECT $1, u.id, u.seq, u.state, u.run_id, u.chat_id, u.created_at, u.data
     FROM UNNEST($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::text[],$8::jsonb[])
       AS u(id,seq,state,run_id,chat_id,created_at,data)
     ON CONFLICT(workspace_id,id) DO UPDATE SET
       seq=excluded.seq,
       state=excluded.state,
       run_id=excluded.run_id,
       chat_id=excluded.chat_id,
       created_at=excluded.created_at,
       data=excluded.data`,
    [
      workspaceId,
      upserts.map((u) => u.item.id),
      upserts.map((u) => u.seq),
      upserts.map((u) => u.item.state ?? ""),
      upserts.map((u) => u.item.runId ?? null),
      upserts.map((u) => u.item.chatId ?? ""),
      upserts.map((u) => u.item.at ?? ""),
      upserts.map((u) => u.json),
    ],
  );
}

async function syncAudit(
  sql: Sql,
  workspaceId: string,
  records: Audit[],
  previous?: Map<string, RecordEntry>,
) {
  const { replaceAll, removed, upserts } = diffRecords(records, previous);
  if (replaceAll) {
    const keep = upserts.map((u) => u.item.id);
    if (keep.length)
      await sql.query(
        "DELETE FROM workspace_audit WHERE workspace_id=$1 AND NOT (id = ANY($2::text[]))",
        [workspaceId, keep],
      );
    else
      await sql.query("DELETE FROM workspace_audit WHERE workspace_id=$1", [
        workspaceId,
      ]);
  } else if (removed.length) {
    await sql.query(
      "DELETE FROM workspace_audit WHERE workspace_id=$1 AND id = ANY($2::text[])",
      [workspaceId, removed],
    );
  }
  if (!upserts.length) return;
  await sql.query(
    `INSERT INTO workspace_audit(workspace_id,id,seq,actor,action,created_at,data)
     SELECT $1, u.id, u.seq, u.actor, u.action, u.created_at, u.data
     FROM UNNEST($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::jsonb[])
       AS u(id,seq,actor,action,created_at,data)
     ON CONFLICT(workspace_id,id) DO UPDATE SET
       seq=excluded.seq,
       actor=excluded.actor,
       action=excluded.action,
       created_at=excluded.created_at,
       data=excluded.data`,
    [
      workspaceId,
      upserts.map((u) => u.item.id),
      upserts.map((u) => u.seq),
      upserts.map((u) => u.item.actor ?? ""),
      upserts.map((u) => u.item.action ?? ""),
      upserts.map((u) => u.item.at ?? ""),
      upserts.map((u) => u.json),
    ],
  );
}

function hydrateReadOnlyWorkspace(
  raw: Record<string, unknown>,
  messages: Source[],
  runs: Run[],
  privateStateKey?: string,
): Workspace {
  const assembled = {
    ...raw,
    messages: Array.isArray(raw.messages)
      ? (raw.messages as Source[])
      : messages,
    runs: Array.isArray(raw.runs) ? (raw.runs as Run[]) : runs,
    deliveries: Array.isArray(raw.deliveries)
      ? (raw.deliveries as Delivery[])
      : [],
    audit: Array.isArray(raw.audit) ? (raw.audit as Audit[]) : [],
  } as Workspace;
  const normalized = workspaceDefaults(assembled);
  return decodeBrowserWorkspace(normalized, privateStateKey);
}

function hydrateWorkspace(
  raw: Record<string, unknown>,
  messages: Source[],
  runs: Run[],
  deliveries: Delivery[],
  audit: Audit[],
  privateStateKey?: string,
  lockedSql?: Sql,
): Workspace {
  const legacyInline =
    Object.hasOwn(raw, "messages") ||
    Object.hasOwn(raw, "runs") ||
    Object.hasOwn(raw, "deliveries") ||
    Object.hasOwn(raw, "audit");
  const assembled = {
    ...raw,
    messages: Array.isArray(raw.messages)
      ? (raw.messages as Source[])
      : messages,
    runs: Array.isArray(raw.runs) ? (raw.runs as Run[]) : runs,
    deliveries: Array.isArray(raw.deliveries)
      ? (raw.deliveries as Delivery[])
      : deliveries,
    audit: Array.isArray(raw.audit) ? (raw.audit as Audit[]) : audit,
  } as Workspace;
  const normalized = workspaceDefaults(assembled);
  const snapshot = captureSnapshot(normalized, legacyInline, lockedSql);
  const decoded = decodeBrowserWorkspace(normalized, privateStateKey);
  snapshots.set(decoded, snapshot);
  return decoded;
}

export class Store {
  constructor(
    public pool: Pool,
    public log = new RuntimeLogger(),
    private privateStateKey?: string,
  ) {}
  configurePrivateState(key: string) {
    if (
      !/^[0-9a-f]{64}$/i.test(key) ||
      (this.privateStateKey && this.privateStateKey !== key)
    )
      throw new Fault("browser_private_storage_unavailable", 503);
    this.privateStateKey = key;
  }
  async deployment(sql: Sql = this.pool, lock = false): Promise<Deployment> {
    const row = (
      await sql.query(
        "SELECT data FROM deployment WHERE id=true" +
          (lock ? " FOR UPDATE" : ""),
      )
    ).rows[0];
    if (!row) throw new Fault("database_not_migrated", 503);
    return row.data;
  }
  async saveDeployment(sql: Sql, value: Deployment) {
    await sql.query("UPDATE deployment SET data=$1 WHERE id=true", [
      JSON.stringify(value),
    ]);
  }
  async read(
    id: string,
    sql: Sql = this.pool,
    lock = false,
  ): Promise<Workspace> {
    const row = (
      await sql.query(
        `SELECT data FROM workspaces WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Fault("not_found", 404);
    const raw = row.data as Record<string, unknown>;
    const loadMessages = () =>
      Array.isArray(raw.messages)
        ? Promise.resolve<Source[]>([])
        : sql
            .query<{ data: Source }>(
              "SELECT data FROM workspace_messages WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) => res.rows.map((x) => x.data));
    const loadRuns = () =>
      Array.isArray(raw.runs)
        ? Promise.resolve<Run[]>([])
        : sql
            .query<{ data: Run }>(
              "SELECT data FROM workspace_runs WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) => res.rows.map((x) => x.data));
    const loadDeliveries = () =>
      Array.isArray(raw.deliveries)
        ? Promise.resolve<Delivery[]>([])
        : sql
            .query<{ data: Delivery }>(
              "SELECT data FROM workspace_deliveries WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) => res.rows.map((x) => x.data));
    const loadAudit = () =>
      Array.isArray(raw.audit)
        ? Promise.resolve<Audit[]>([])
        : sql
            .query<{ data: Audit }>(
              "SELECT data FROM workspace_audit WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) => res.rows.map((x) => x.data));
    const [messages, runs, deliveries, audit] =
      sql === this.pool
        ? await Promise.all([
            loadMessages(),
            loadRuns(),
            loadDeliveries(),
            loadAudit(),
          ])
        : [
            await loadMessages(),
            await loadRuns(),
            await loadDeliveries(),
            await loadAudit(),
          ];
    return hydrateWorkspace(
      raw,
      messages,
      runs,
      deliveries,
      audit,
      this.privateStateKey,
      lock ? sql : undefined,
    );
  }
  /**
   * Lock-free, lightweight workspace read for run authorization guards.
   * Omits deliveries, audit logs, snapshot diffing, and heavy run transcripts/tools.
   */
  async readForGuard(id: string, sql: Sql = this.pool): Promise<Workspace> {
    const row = (
      await sql.query("SELECT data FROM workspaces WHERE id=$1", [id])
    ).rows[0];
    if (!row) throw new Fault("not_found", 404);
    const raw = row.data as Record<string, unknown>;
    const loadMessages = () =>
      Array.isArray(raw.messages)
        ? Promise.resolve<Source[]>([])
        : sql
            .query<{ data: Source }>(
              "SELECT data FROM workspace_messages WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) => res.rows.map((x) => x.data));
    const loadRuns = () =>
      Array.isArray(raw.runs)
        ? Promise.resolve<Run[]>([])
        : sql
            .query<{ data: Run }>(
              "SELECT data - 'transcript' - 'tools' AS data FROM workspace_runs WHERE workspace_id=$1 ORDER BY seq",
              [id],
            )
            .then((res) =>
              res.rows.map((x) => ({
                ...x.data,
                transcript: x.data.transcript ?? [],
                tools: x.data.tools ?? {},
              })),
            );
    const [messages, runs] =
      sql === this.pool
        ? await Promise.all([loadMessages(), loadRuns()])
        : [await loadMessages(), await loadRuns()];
    return hydrateReadOnlyWorkspace(raw, messages, runs, this.privateStateKey);
  }
  /**
   * Surgically renews a single running run's lease using a shared workspace lock
   * (`FOR SHARE`), avoiding full-workspace `FOR UPDATE` contention and table scans.
   */
  async renewRunLease(
    workspaceId: string,
    runId: string,
    fence: number,
    leaseUntil: string,
  ): Promise<void> {
    const outcome = await transaction(this.pool, async (sql) => {
      const ws = (
        await sql.query<{ legacy: boolean }>(
          "SELECT (data ? 'runs') AS legacy FROM workspaces WHERE id=$1 FOR SHARE",
          [workspaceId],
        )
      ).rows[0];
      if (!ws) throw new Fault("not_found", 404);
      if (ws.legacy) return "legacy" as const;
      const updated = await sql.query(
        `UPDATE workspace_runs
         SET data = jsonb_set(data, '{leaseUntil}', to_jsonb($4::text), true)
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'running'
           AND (data->>'fence')::int = $3
         RETURNING id`,
        [workspaceId, runId, fence, leaseUntil],
      );
      if (updated.rowCount !== 1) throw new Fault("run_revoked", 409);
      return "updated" as const;
    });
    if (outcome === "legacy") {
      await this.change(workspaceId, (w) => {
        const r = w.runs.find((item) => item.id === runId);
        if (!r || r.fence !== fence || r.status !== "running")
          throw new Fault("run_revoked", 409);
        r.leaseUntil = leaseUntil;
      });
    }
  }
  /**
   * Atomically validates and mutates a single run row under `workspaces FOR SHARE`
   * + `workspace_runs FOR UPDATE`, enabling concurrent parallel tools and concurrent
   * runs in the same workspace while staying strictly clobber-free with `Store.change`.
   */
  async mutateRunRow<T>(
    workspaceId: string,
    runId: string,
    action: (workspace: Workspace, run: Run, sql: Sql) => T | Promise<T>,
    onMissingRun: () => Fault = () => new Fault("run_revoked", 409),
  ): Promise<T> {
    const outcome = await transaction(this.pool, async (sql) => {
      const wsRow = (
        await sql.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM workspaces WHERE id=$1 FOR SHARE",
          [workspaceId],
        )
      ).rows[0];
      if (!wsRow) throw new Fault("not_found", 404);
      const raw = wsRow.data;
      if (Array.isArray(raw.runs)) return { legacy: true as const };

      const targetRow = (
        await sql.query<{ data: Run }>(
          "SELECT data FROM workspace_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspaceId, runId],
        )
      ).rows[0];
      if (!targetRow) throw onMissingRun();

      const messages = Array.isArray(raw.messages)
        ? []
        : (
            await sql.query<{ data: Source }>(
              "SELECT data FROM workspace_messages WHERE workspace_id=$1 ORDER BY seq",
              [workspaceId],
            )
          ).rows.map((x) => x.data);
      const otherRuns = (
        await sql.query<{ id: string; data: Run }>(
          "SELECT id, data - 'transcript' - 'tools' AS data FROM workspace_runs WHERE workspace_id=$1 ORDER BY seq",
          [workspaceId],
        )
      ).rows.map((x) =>
        x.id === runId
          ? targetRow.data
          : {
              ...x.data,
              transcript: x.data.transcript ?? [],
              tools: x.data.tools ?? {},
            },
      );

      const workspace = hydrateReadOnlyWorkspace(
        raw,
        messages,
        otherRuns,
        this.privateStateKey,
      );
      const run = workspace.runs.find((item) => item.id === runId);
      if (!run) throw onMissingRun();

      const beforeJson = JSON.stringify(run);
      const value = await action(workspace, run, sql);
      const afterJson = JSON.stringify(run);
      if (afterJson !== beforeJson) {
        const encoded = encodeBrowserRun(workspace, run, this.privateStateKey);
        await sql.query(
          "UPDATE workspace_runs SET status=$3, data=$4 WHERE workspace_id=$1 AND id=$2",
          [workspaceId, runId, encoded.status ?? "", JSON.stringify(encoded)],
        );
      }
      return { legacy: false as const, value };
    });

    if (outcome.legacy) {
      return this.change(workspaceId, (w, sql) => {
        const run = w.runs.find((item) => item.id === runId);
        if (!run) throw onMissingRun();
        return action(w, run, sql);
      });
    }
    return outcome.value;
  }
  async save(sql: Sql, workspace: Workspace) {
    const previous = snapshots.get(workspace);
    // Only diff against a snapshot captured under FOR UPDATE on the exact same transaction client.
    const lockedPrevious =
      previous && !previous.legacyInline && previous.lockedSql === sql
        ? previous
        : undefined;
    const encoded = encodeBrowserWorkspace(workspace, this.privateStateKey);
    const coreJson = JSON.stringify(coreWorkspaceData(encoded));
    const coreChanged = !lockedPrevious || coreJson !== lockedPrevious.coreJson;
    if (coreChanged) {
      await sql.query(
        "UPDATE workspaces SET data=$2,updated_at=now() WHERE id=$1",
        [workspace.id, coreJson],
      );
    }
    await syncMessages(
      sql,
      workspace.id,
      encoded.messages,
      lockedPrevious?.messages,
    );
    const changedRuns = await syncRuns(
      sql,
      workspace.id,
      encoded.runs,
      lockedPrevious?.runs,
    );
    await syncWorkspaceUsageLedger(sql, workspace, changedRuns, coreChanged);
    await syncDeliveries(
      sql,
      workspace.id,
      encoded.deliveries,
      lockedPrevious?.deliveries,
    );
    await syncAudit(sql, workspace.id, encoded.audit, lockedPrevious?.audit);
    const newlyQueuedRuns = workspace.runs.filter(
      (r) => r.status === "queued" && !lockedPrevious?.queuedRunIds.has(r.id),
    );
    const newlyPendingDeliveries = workspace.deliveries.filter(
      (d) =>
        d.state === "pending" && !lockedPrevious?.pendingDeliveryIds.has(d.id),
    );
    for (const [kind, records] of [
      ["run", newlyQueuedRuns],
      ["delivery", newlyPendingDeliveries],
    ] as const) {
      for (const record of records)
        await sql.query(
          "INSERT INTO outbox(id,kind,workspace_id,target_id) VALUES($1,$2,$3,$4) ON CONFLICT(kind,workspace_id,target_id) DO NOTHING",
          [randomUUID(), kind, workspace.id, record.id],
        );
    }
    snapshots.set(
      workspace,
      captureSnapshot(encoded, false, previous?.lockedSql),
    );
  }
  async change<T>(
    id: string,
    action: (workspace: Workspace, sql: Sql) => T | Promise<T>,
  ) {
    const changed = await transaction(this.pool, async (sql) => {
      const workspace = await this.read(id, sql, true);
      const active = new Set(
        workspace.workflows
          .filter((f) => f.status === "active")
          .map((f) => f.id),
      );
      const result = await action(workspace, sql);
      await this.save(sql, workspace);
      const suspended = workspace.workflows
        .filter((f) => active.has(f.id) && f.status === "suspended")
        .map((f) => ({
          reason: f.reason,
          runId: workspace.runs.findLast((r) => r.workflowId === f.id)?.id,
        }));
      return { result, suspended };
    });
    for (const suspension of changed.suspended)
      this.log.write("workflow_suspended", {
        workspaceId: id,
        runId: suspension.runId,
        error: new Fault(suspension.reason ?? "workflow_suspended"),
      });
    return changed.result;
  }
  async all(): Promise<Workspace[]> {
    const [workspaces, messages, runs, deliveries, audit] = await Promise.all([
      this.pool.query<{ id: string; data: Record<string, unknown> }>(
        "SELECT id,data FROM workspaces ORDER BY id",
      ),
      this.pool.query<{ workspace_id: string; data: Source }>(
        "SELECT workspace_id,data FROM workspace_messages ORDER BY workspace_id,seq",
      ),
      this.pool.query<{ workspace_id: string; data: Run }>(
        "SELECT workspace_id,data FROM workspace_runs ORDER BY workspace_id,seq",
      ),
      this.pool.query<{ workspace_id: string; data: Delivery }>(
        "SELECT workspace_id,data FROM workspace_deliveries ORDER BY workspace_id,seq",
      ),
      this.pool.query<{ workspace_id: string; data: Audit }>(
        "SELECT workspace_id,data FROM workspace_audit ORDER BY workspace_id,seq",
      ),
    ]);
    const groupBy = <T>(rows: { workspace_id: string; data: T }[]) => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.workspace_id);
        if (list) list.push(row.data);
        else grouped.set(row.workspace_id, [row.data]);
      }
      return grouped;
    };
    const msgMap = groupBy(messages.rows);
    const runMap = groupBy(runs.rows);
    const delMap = groupBy(deliveries.rows);
    const audMap = groupBy(audit.rows);
    return workspaces.rows.map((r) =>
      hydrateWorkspace(
        r.data,
        msgMap.get(r.id) ?? [],
        runMap.get(r.id) ?? [],
        delMap.get(r.id) ?? [],
        audMap.get(r.id) ?? [],
        this.privateStateKey,
      ),
    );
  }
  async ids(): Promise<string[]> {
    return (
      await this.pool.query("SELECT id FROM workspaces ORDER BY id")
    ).rows.map((r) => r.id);
  }
}
