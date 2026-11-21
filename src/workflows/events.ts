import { randomUUID } from "node:crypto";
import type { Sql } from "../db/pool.ts";
import type { Workflow, Workspace } from "../domain.ts";
import { workflowRepositoriesAllowed } from "../github/metadata-policy.ts";
import {
  audience,
  audit,
  eligible,
  workflowSkillAvailable,
} from "../workspaces/policy.ts";
import { createRun } from "../workspaces/service.ts";

export type GitHubAutomationEventKind =
  | "check_suite_failed"
  | "issue_opened"
  | "issue_labeled"
  | "pull_request_opened"
  | "pull_request_ready";

export type IncomingAutomationEvent =
  | {
      kind: "github_event";
      event: GitHubAutomationEventKind;
      eventKey: string;
      repositoryId: number;
      repository: string;
      branch?: string;
      label?: string;
      url?: string;
      title?: string;
      number?: number;
      sha?: string;
    }
  | {
      kind: "plugin_event";
      pluginId: string;
      pluginGeneration: number;
      eventName: string;
      eventKey: string;
      summary: string;
      url?: string;
    };

function matchesTrigger(
  workflow: Workflow,
  incoming: IncomingAutomationEvent,
): boolean {
  const trigger = workflow.spec.trigger;
  if (!trigger || trigger.kind !== incoming.kind) return false;
  if (incoming.kind === "github_event" && trigger.kind === "github_event") {
    if (trigger.event !== incoming.event) return false;
    if (!workflow.spec.github?.repositoryIds.includes(incoming.repositoryId)) {
      return false;
    }
    if (
      trigger.branch &&
      incoming.branch &&
      trigger.branch !== incoming.branch
    ) {
      return false;
    }
    if (
      trigger.label &&
      (!incoming.label ||
        trigger.label.toLowerCase() !== incoming.label.toLowerCase())
    ) {
      return false;
    }
    return true;
  }
  if (incoming.kind === "plugin_event" && trigger.kind === "plugin_event") {
    return (
      trigger.pluginId === incoming.pluginId &&
      trigger.pluginGeneration === incoming.pluginGeneration &&
      trigger.eventName === incoming.eventName
    );
  }
  return false;
}

export async function recordWatcherDedupe(
  sql: Sql,
  workspaceId: string,
  workflowId: string,
  dedupeKey: string,
  cooldownMinutes: number,
  now = new Date(),
): Promise<boolean> {
  const cutoff = new Date(
    now.getTime() - Math.max(1, cooldownMinutes) * 60_000,
  ).toISOString();
  const recent = await sql.query<{ id: string }>(
    `SELECT id FROM workspace_automation_events
     WHERE workspace_id=$1 AND workflow_id=$2 AND kind='watcher_alert'
       AND event_key=$3 AND created_at > $4
     LIMIT 1`,
    [workspaceId, workflowId, dedupeKey, cutoff],
  );
  if (recent.rows.length > 0) return false;
  await sql.query(
    `INSERT INTO workspace_automation_events(workspace_id, id, workflow_id, event_key, kind, created_at)
     VALUES($1, $2, $3, $4, 'watcher_alert', $5)
     ON CONFLICT (workspace_id, workflow_id, event_key)
     DO UPDATE SET created_at = excluded.created_at`,
    [workspaceId, randomUUID(), workflowId, dedupeKey, now.toISOString()],
  );
  return true;
}

/**
 * Evaluates active event-triggered automations inside the workspace transaction,
 * enforcing ownership, repository scope, semantic dedupe, and per-automation cooldown.
 */
export async function dispatchAutomationEvent(
  sql: Sql,
  w: Workspace,
  incoming: IncomingAutomationEvent,
  model: string,
  now = new Date(),
): Promise<string[]> {
  if (w.deletion || w.settings.paused) return [];
  const runIds: string[] = [];

  for (const workflow of w.workflows) {
    if (workflow.status !== "active") continue;
    if (!matchesTrigger(workflow, incoming)) continue;
    if (!eligible(w, workflow.owner)) continue;
    try {
      audience(w, workflow.owner, workflow.spec.chatId);
    } catch {
      continue;
    }
    if (
      workflow.spec.github &&
      !workflowRepositoriesAllowed(
        w,
        workflow.owner,
        workflow.spec.chatId,
        workflow.spec.github,
      )
    ) {
      continue;
    }
    if (!workflowSkillAvailable(w, workflow)) continue;

    const trigger = workflow.spec.trigger;
    const cooldownMinutes =
      trigger && "cooldownMinutes" in trigger
        ? (trigger.cooldownMinutes ?? 15)
        : 15;
    const cutoff = new Date(
      now.getTime() - cooldownMinutes * 60_000,
    ).toISOString();

    const cooldownHit = await sql.query<{ id: string }>(
      `SELECT id FROM workspace_automation_events
       WHERE workspace_id=$1 AND workflow_id=$2 AND kind=$3 AND created_at > $4
       LIMIT 1`,
      [w.id, workflow.id, incoming.kind, cutoff],
    );
    if (cooldownHit.rows.length > 0) continue;

    const inserted = await sql.query<{ id: string }>(
      `INSERT INTO workspace_automation_events(workspace_id, id, workflow_id, event_key, kind, created_at)
       VALUES($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, workflow_id, event_key) DO NOTHING
       RETURNING id`,
      [
        w.id,
        randomUUID(),
        workflow.id,
        incoming.eventKey,
        incoming.kind,
        now.toISOString(),
      ],
    );
    if (inserted.rows.length === 0) continue;

    const boundedPayload =
      incoming.kind === "github_event"
        ? {
            event: incoming.event,
            repository: incoming.repository,
            repositoryId: incoming.repositoryId,
            branch: incoming.branch,
            label: incoming.label,
            number: incoming.number,
            title: incoming.title?.slice(0, 200),
            sha: incoming.sha,
            url: incoming.url,
          }
        : {
            pluginId: incoming.pluginId,
            eventName: incoming.eventName,
            summary: incoming.summary.slice(0, 500),
            url: incoming.url,
          };

    const taskPrompt = `${workflow.spec.task}\n\nTrigger event (untrusted reference data): ${JSON.stringify(boundedPayload)}`;
    try {
      const run = createRun(
        w,
        workflow.owner,
        taskPrompt,
        workflow.spec.chatId,
        workflow.spec.topicId,
        model,
        { workflowId: workflow.id, now },
      );
      w.occurrences.push({
        key: `${workflow.id}:${incoming.eventKey}`,
        workflowId: workflow.id,
        version: workflow.version,
        at: now.toISOString(),
        status: "queued",
        runId: run.id,
      });
      audit(
        w,
        workflow.owner,
        "workflow.event_triggered",
        workflow.id,
        workflow.version,
        now,
      );
      runIds.push(run.id);
    } catch {
      audit(
        w,
        workflow.owner,
        "workflow.event_dispatch_failed",
        workflow.id,
        workflow.version,
        now,
      );
    }
  }
  return runIds;
}

export async function purgeAutomationEvents(
  sql: Sql,
  workspaceId?: string,
): Promise<void> {
  if (workspaceId) {
    await sql.query(
      "DELETE FROM workspace_automation_events WHERE workspace_id=$1",
      [workspaceId],
    );
    return;
  }
  await sql.query(
    "DELETE FROM workspace_automation_events WHERE created_at < now() - interval '30 days'",
  );
}
