import { randomUUID } from "node:crypto";
import { type Approval, requireThat, type Workspace } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audit, authorize } from "../workspaces/policy.ts";
export function requestDeletion(w: Workspace, actor: string) {
  authorize(w, actor, true);
  requireThat(!w.deletion, "deletion_pending", 409);
  const payload = { workspace: w.id, scope: "all_workspace_content" };
  const approval: Approval = {
    id: randomUUID(),
    actor,
    kind: "deletion",
    target: w.id,
    version: w.version,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  w.approvals.push(approval);
  audit(w, actor, "deletion.requested", w.id);
  return approval;
}
export function sweep(w: Workspace, now = new Date()) {
  if (w.deletion) {
    delete w.plugins;
    delete w.github;
    w.messages = [];
    w.instructions = [];
    w.runs = [];
    w.deliveries = [];
    w.approvals = [];
    w.tokens = [];
    w.skills = [];
    w.workflows = [];
    w.occurrences = [];
    w.chats = [];
    w.members = [];
    w.policy.allowed = [];
    w.deletion.purgedAt ??= now.toISOString();
    return;
  }
  for (const approval of w.approvals)
    if (!approval.decision && Date.parse(approval.expiresAt) <= now.getTime()) {
      approval.decision = "revoked";
      const run = w.runs.find((r) => r.id === approval.runId);
      if (run?.status === "awaiting_approval") {
        run.status = "partial";
        run.error = "approval_expired";
      }
    }
  const cutoff = now.getTime() - w.settings.retentionDays * 86400000;
  w.messages = w.messages.filter(
    (m) => Date.parse(m.expiresAt) > now.getTime() && Date.parse(m.at) > cutoff,
  );
  // Retained run snapshots never outlive their source messages.
  const retained = new Set(w.messages.map((m) => m.id));
  for (const r of w.runs) {
    if (r.sources.some((s) => !retained.has(s.id))) {
      r.cancelled = true;
      if (["queued", "running"].includes(r.status)) r.status = "cancelled";
      r.sources = [];
      r.transcript = [];
      r.result = undefined;
      r.task = "[source removed]";
      r.tools = {};
    }
  }
  w.runs = w.runs.filter(
    (r) =>
      Date.parse(r.at) > cutoff ||
      r.attempts.some(
        (a) =>
          a.status !== "settled" ||
          Date.parse(a.at) > now.getTime() - 90 * 86400000,
      ),
  );
  for (const r of w.runs)
    if (Date.parse(r.at) <= cutoff) {
      r.task = "[expired]";
      r.sources = [];
      r.instructions = [];
      r.transcript = [];
      r.result = undefined;
      r.tools = {};
    }
  w.deliveries = w.deliveries.filter((d) => Date.parse(d.at) > cutoff);
  w.tokens = w.tokens.filter((t) => Date.parse(t.expiresAt) > now.getTime());
  w.approvals = w.approvals.filter((a) => Date.parse(a.expiresAt) > cutoff);
  w.occurrences = w.occurrences.filter((o) => Date.parse(o.at) > cutoff);
  w.audit = w.audit.filter(
    (a) => Date.parse(a.at) > now.getTime() - 90 * 86400000,
  );
}
