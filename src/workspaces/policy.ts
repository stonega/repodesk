import { randomUUID } from "node:crypto";
import {
  type Audit,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { validMemory } from "./conversation-memory.ts";
export function eligible(w: Workspace, actor: string, admin = false) {
  const member = w.members.find((m) => m.id === actor && m.active);
  return !w.deletion && !!member && (!admin || member.role !== "member");
}
export function authorize(
  w: Workspace,
  actor: string | undefined,
  admin = false,
) {
  if (admin && actor === w.operatorId && !w.deletion) return actor;
  requireThat(actor && eligible(w, actor, admin), "access_denied", 403);
  return actor;
}
export function audience(w: Workspace, actor: string, chatId: string) {
  authorize(w, actor);
  requireThat(
    chatId === actor || w.chats.some((c) => c.id === chatId && c.active),
    "destination_denied",
    403,
  );
}
export function audit(
  w: Workspace,
  actor: string,
  action: string,
  target: string,
  version?: number,
  now = new Date(),
) {
  const entry: Audit = {
    id: randomUUID(),
    actor,
    action,
    target,
    version,
    at: now.toISOString(),
  };
  w.audit.push(entry);
}
export function runAllowed(w: Workspace, run: Run) {
  return (
    eligible(w, run.actor) &&
    !w.settings.paused &&
    !run.cancelled &&
    (!run.followup ||
      run.followup.decision === "reply" ||
      (Date.parse(run.followup.expiresAt) > Date.now() &&
        w.runs.some(
          (r) => r.id === run.followup?.anchorRunId && !r.followupClosed,
        ))) &&
    (!run.followup?.references ||
      validMemory(run.followup.references, w.messages)) &&
    (!run.contextSummary || validMemory(run.contextSummary, w.messages)) &&
    run.sources.every(
      (s) =>
        Date.parse(s.expiresAt) > Date.now() &&
        Date.parse(s.retentionOriginAt ?? s.at) >
          Date.now() - w.settings.retentionDays * 86400000 &&
        w.messages.some((m) => m.id === s.id),
    ) &&
    (run.chatId === run.actor ||
      w.chats.some((c) => c.id === run.chatId && c.active)) &&
    run.skillPins.every((p) =>
      w.skills.some(
        (s) =>
          s.id === p.id &&
          s.enabled &&
          !s.archived &&
          s.published[p.version - 1],
      ),
    ) &&
    (!run.workflowId ||
      w.workflows.some(
        (f) =>
          f.id === run.workflowId &&
          f.status === "active" &&
          eligible(w, f.owner),
      ))
  );
}
export function revokeWork(w: Workspace, now = new Date()) {
  for (const approval of w.approvals)
    if (!approval.decision && !eligible(w, approval.actor))
      approval.decision = "revoked";
  for (const workflow of w.workflows)
    if (
      workflow.status === "active" &&
      (!eligible(w, workflow.owner) ||
        !w.skills.some(
          (s) => s.id === workflow.spec.skillId && s.enabled && !s.archived,
        ))
    ) {
      workflow.status = "suspended";
      workflow.reason = "owner_or_skill_revoked";
    }
  for (const run of w.runs)
    if (
      ["queued", "running", "awaiting_approval"].includes(run.status) &&
      !runAllowed(w, run)
    ) {
      run.cancelled = true;
      run.status = "cancelled";
      run.finishedAt = now.toISOString();
    }
  for (const d of w.deliveries)
    if (
      d.state === "pending" &&
      (!eligible(w, d.actor) ||
        (d.runId && !w.runs.some((r) => r.id === d.runId && runAllowed(w, r))))
    )
      d.state = "cancelled";
}
export function updateMembership(
  w: Workspace,
  actor: string,
  version: number,
  input: { id: string; role: "admin" | "member"; active: boolean },
) {
  authorize(w, actor, true);
  requireThat(w.memberVersion === version, "version_conflict", 409);
  const previous = w.members.find((m) => m.id === input.id);
  requireThat(previous?.role !== "owner", "owner_requires_host_recovery", 409);
  const member = {
    ...previous,
    id: input.id,
    role: input.role,
    active: input.active,
  };
  const members = previous
    ? w.members.map((m) => (m.id === input.id ? member : m))
    : [...w.members, member];
  if (actor !== w.operatorId)
    requireThat(
      members.some((m) => m.active && m.role !== "member"),
      "last_admin_lockout",
      409,
    );
  w.members = members;
  w.memberVersion++;
  revokeWork(w);
  audit(w, actor, "member.updated", input.id, w.memberVersion);
}
