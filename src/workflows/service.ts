import { randomUUID } from "node:crypto";
import {
  type Approval,
  type Instruction,
  requireThat,
  type WorkflowSpec,
  type Workspace,
  workflowSchema,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import {
  audience,
  audit,
  authorize,
  revokeWork,
} from "../workspaces/policy.ts";
import { createRun } from "../workspaces/service.ts";
import { nextOccurrences } from "./schedule.ts";
export function proposeWorkflow(
  w: Workspace,
  actor: string,
  input: WorkflowSpec,
  now = new Date(),
  id?: string,
  expectedVersion?: number,
) {
  authorize(w, actor);
  const spec = workflowSchema.parse(input);
  audience(w, actor, spec.chatId);
  requireThat(
    spec.budgetUsd <= w.settings.runBudgetUsd,
    "budget_exceeds_workspace_limit",
  );
  const skill = w.skills.find(
    (s) =>
      s.id === spec.skillId && s.enabled && !s.archived && s.published.length,
  );
  requireThat(skill, "skill_unavailable");
  let workflow = id ? w.workflows.find((f) => f.id === id) : undefined;
  if (id) {
    requireThat(workflow, "not_found", 404);
    requireThat(workflow.version === expectedVersion, "version_conflict", 409);
    requireThat(workflow.owner === actor, "owner_required", 403);
    workflow.version++;
    workflow.spec = spec;
    workflow.skillVersion = skill.published.length;
    workflow.status = "draft";
  } else {
    workflow = {
      id: randomUUID(),
      version: 1,
      owner: actor,
      status: "draft",
      spec,
      skillVersion: skill.published.length,
      versions: [],
    };
    w.workflows.push(workflow);
  }
  workflow.versions.push({
    version: workflow.version,
    spec: structuredClone(spec),
    skillVersion: workflow.skillVersion,
  });
  const payload = {
    spec: structuredClone(spec),
    owner: actor,
    skillVersion: workflow.skillVersion,
  };
  const approval: Approval = {
    id: randomUUID(),
    actor,
    kind: "workflow",
    target: workflow.id,
    version: workflow.version,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(),
  };
  w.approvals.push(approval);
  revokeWork(w);
  audit(w, actor, "workflow.proposed", workflow.id, workflow.version, now);
  return { workflow, approval, next: nextOccurrences(spec.recurrence, now) };
}
export function proposeInstruction(
  w: Workspace,
  actor: string,
  body: string,
  scope: Instruction["scope"],
  provenance: string,
  workflowId?: string,
  replaceId?: string,
) {
  authorize(w, actor, scope === "workspace");
  requireThat(body.trim() && body.length <= 4000, "invalid_instruction");
  requireThat(
    !/-----BEGIN .*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}|\d{8,}:[A-Za-z0-9_-]{30,}/.test(
      body,
    ),
    "instruction_contains_secret",
  );
  if (scope === "workflow")
    requireThat(
      w.workflows.some((f) => f.id === workflowId && f.owner === actor),
      "workflow_denied",
      403,
    );
  const previous = replaceId
    ? w.instructions.find((i) => i.id === replaceId)
    : undefined;
  if (replaceId)
    requireThat(
      previous &&
        previous.scope === scope &&
        previous.workflowId === workflowId &&
        (scope !== "personal" || previous.author === actor),
      "instruction_denied",
      403,
    );
  const payload: Instruction = {
    id: replaceId ?? randomUUID(),
    version: (previous?.version ?? 0) + 1,
    scope,
    workflowId,
    author: actor,
    body,
    active: true,
    at: new Date().toISOString(),
    provenance,
  };
  const approval: Approval = {
    id: randomUUID(),
    actor,
    kind: "instruction",
    target: payload.id,
    version: payload.version,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  w.approvals.push(approval);
  audit(w, actor, "instruction.proposed", payload.id, payload.version);
  return approval;
}
export function decide(
  w: Workspace,
  actor: string,
  id: string,
  accept: boolean,
  now = new Date(),
) {
  authorize(w, actor);
  const approval = w.approvals.find((a) => a.id === id);
  requireThat(approval && approval.actor === actor, "approval_denied", 403);
  requireThat(!approval.decision, "approval_consumed", 409);
  requireThat(
    Date.parse(approval.expiresAt) > now.getTime(),
    "approval_expired",
    409,
  );
  requireThat(
    fingerprint(approval.payload) === approval.hash,
    "approval_changed",
    409,
  );
  if (accept && approval.kind === "workflow") {
    authorize(w, actor);
    const workflow = w.workflows.find((f) => f.id === approval.target);
    requireThat(
      workflow &&
        workflow.version === approval.version &&
        workflow.status === "draft",
      "approval_stale",
      409,
    );
    requireThat(
      fingerprint({
        spec: workflow.spec,
        owner: workflow.owner,
        skillVersion: workflow.skillVersion,
      }) === approval.hash,
      "approval_changed",
      409,
    );
    audience(w, actor, workflow.spec.chatId);
    requireThat(
      w.skills.some(
        (s) => s.id === workflow.spec.skillId && s.enabled && !s.archived,
      ),
      "skill_unavailable",
    );
    workflow.status = "active";
    workflow.nextAt = nextOccurrences(workflow.spec.recurrence, now, 1)[0];
    workflow.reason = undefined;
  }
  if (accept && approval.kind === "instruction") {
    const instruction = approval.payload as Instruction;
    authorize(w, actor, instruction.scope === "workspace");
    const previous = w.instructions.find((i) => i.id === instruction.id);
    requireThat(
      (previous?.version ?? 0) === instruction.version - 1,
      "approval_stale",
      409,
    );
    if (previous) Object.assign(previous, instruction);
    else w.instructions.push(structuredClone(instruction));
  }
  if (accept && approval.kind === "deletion") {
    authorize(w, actor, true);
    w.deletion = {
      requestedAt: now.toISOString(),
      providerState:
        "No provider-hosted sessions created. Provider abuse-monitoring retention is governed by its account policy.",
    };
    revokeWork(w, now);
  }
  approval.decision = accept ? "approved" : "rejected";
  const run = w.runs.find((r) => r.id === approval.runId);
  if (
    run?.status === "awaiting_approval" &&
    !w.approvals.some((a) => a.runId === run.id && !a.decision)
  )
    run.status = "succeeded";
  audit(w, actor, `approval.${approval.decision}`, id, approval.version, now);
  return approval;
}
export function workflowAction(
  w: Workspace,
  actor: string,
  id: string,
  action: "pause" | "resume" | "delete" | "run",
  version: number,
  model: string,
) {
  authorize(w, actor, action !== "run");
  const f = w.workflows.find((f) => f.id === id);
  requireThat(f, "not_found", 404);
  requireThat(f.version === version, "version_conflict", 409);
  if (action === "run")
    return createRun(
      w,
      actor,
      f.spec.task,
      f.spec.chatId,
      f.spec.topicId,
      model,
      { workflowId: id },
    );
  requireThat(f.owner === actor, "owner_required", 403);
  if (action === "resume") {
    requireThat(f.status === "paused", "new_approval_required", 409);
    audience(w, actor, f.spec.chatId);
    requireThat(
      w.skills.some((s) => s.id === f.spec.skillId && s.enabled && !s.archived),
      "skill_unavailable",
    );
    f.status = "active";
    f.nextAt = nextOccurrences(f.spec.recurrence, new Date(), 1)[0];
  } else f.status = action === "pause" ? "paused" : "deleted";
  revokeWork(w);
  audit(w, actor, `workflow.${action}`, id, f.version);
  return f;
}
export function tick(w: Workspace, model: string, now = new Date()) {
  revokeWork(w, now);
  if (w.deletion || w.settings.paused) return;
  for (const f of w.workflows) {
    if (
      f.status !== "active" ||
      !f.nextAt ||
      Date.parse(f.nextAt) > now.getTime()
    )
      continue;
    const instant = f.nextAt;
    const key = `${f.id}:${instant}`;
    f.nextAt = nextOccurrences(f.spec.recurrence, now, 1)[0];
    if (w.occurrences.some((o) => o.key === key)) continue;
    if (
      now.getTime() - Date.parse(instant) >
      w.settings.missedRunMinutes * 60000
    ) {
      w.occurrences.push({
        key,
        workflowId: f.id,
        version: f.version,
        at: instant,
        status: "skipped",
      });
      w.deliveries.push({
        id: randomUUID(),
        actor: f.owner,
        chatId: f.owner,
        topicId: 0,
        text: `Skipped late workflow ${f.spec.name} at ${instant}. No catch-up was sent.`,
        state: "pending",
        attempts: 0,
        at: now.toISOString(),
      });
      continue;
    }
    try {
      const run = createRun(
        w,
        f.owner,
        f.spec.task,
        f.spec.chatId,
        f.spec.topicId,
        model,
        { workflowId: f.id, now },
      );
      w.occurrences.push({
        key,
        workflowId: f.id,
        version: f.version,
        at: instant,
        status: "queued",
        runId: run.id,
      });
    } catch {
      f.status = "suspended";
      f.reason = "dispatch_policy_or_capacity";
      audit(w, f.owner, "workflow.dispatch_failed", f.id);
    }
  }
}
