import { randomUUID } from "node:crypto";
import { type Approval, requireThat, type Workspace } from "../domain.ts";
import { memoryContextValid, pruneMemories } from "../memory/state.ts";
import { fingerprint } from "../setup/credentials.ts";
import { pruneSkillSources } from "../skills/proposals.ts";
import { discardFollowup } from "../telegram/followup.ts";
import { validMemory } from "../workspaces/conversation-memory.ts";
import { audit, authorize } from "../workspaces/policy.ts";
import { retainedSource } from "../workspaces/threads.ts";
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
    w.reviewCleanup = [
      ...new Set([
        ...(w.reviewCleanup ?? []),
        ...(w.reviewTasks ?? []).flatMap((t) => [
          ...(t.attemptIds ?? []),
          t.attemptId,
        ]),
      ]),
    ];
    delete w.reviewTasks;
    delete w.reviewBot;
    delete w.plugins;
    delete w.googleUsers;
    delete w.github;
    delete w.repositorySelections;
    delete w.coding;
    delete w.chatModel;
    delete w.memory;
    delete w.obsidian;
    w.messages = [];
    w.threads = [];
    w.instructions = [];
    w.runs = [];
    delete w.adminChecks;
    w.deliveries = [];
    w.approvals = [];
    w.tokens = [];
    w.skills = [];
    w.workflows = [];
    w.occurrences = [];
    w.chats = [];
    w.members = [];
    w.accessRequests = [];
    w.accessLinkClaims = [];
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
  for (const run of w.runs) {
    if (
      run.followup &&
      run.followup.decision !== "reply" &&
      (run.cancelled ||
        !["queued", "running"].includes(run.status) ||
        Date.parse(run.followup.expiresAt) <= now.getTime())
    ) {
      if (["queued", "running"].includes(run.status)) {
        run.cancelled = true;
        run.status = "cancelled";
      }
      discardFollowup(w, run);
    }
  }
  w.accessLinkClaims = w.accessLinkClaims?.filter(
    (claim) => Date.parse(claim.expiresAt) > now.getTime(),
  );
  for (const [actor, user] of Object.entries(w.googleUsers ?? {})) {
    if (!w.members.some((m) => m.id === actor && m.active)) {
      delete w.googleUsers?.[actor];
      continue;
    }
    if (user.flow && Date.parse(user.flow.expiresAt) <= now.getTime())
      delete user.flow;
    if (
      user.properties &&
      Date.parse(user.properties.expiresAt) <= now.getTime()
    )
      delete user.properties;
  }
  const cutoff = now.getTime() - w.settings.retentionDays * 86400000;
  w.repositorySelections = w.repositorySelections?.filter(
    (s) => Date.parse(s.at) > cutoff,
  );
  w.accessRequests = w.accessRequests?.filter(
    (r) =>
      Date.parse(r.decidedAt ?? r.requestedAt) > now.getTime() - 30 * 86400000,
  );
  w.messages = w.messages.filter((m) => retainedSource(w, m, now.getTime()));
  pruneMemories(w, now.getTime());
  // Remove derived answers transitively as their sources expire or are removed.
  // Otherwise another thread could retrieve an answer whose private sources were erased.
  let removed: boolean;
  do {
    removed = false;
    const retained = new Set(w.messages.map((m) => m.id));
    for (const r of w.runs) {
      if (
        r.sources.some((s) => !retained.has(s.id)) ||
        (r.contextSummary && !validMemory(r.contextSummary, w.messages)) ||
        !memoryContextValid(w, r, true) ||
        (r.handoffRead && !validMemory(r.handoffRead.references, w.messages)) ||
        (r.followup?.references &&
          !validMemory(r.followup.references, w.messages))
      ) {
        r.cancelled = true;
        if (["queued", "running"].includes(r.status)) r.status = "cancelled";
        r.sources = [];
        r.transcript = [];
        r.result = undefined;
        r.task = "[source removed]";
        r.tools = {};
        delete r.contextSummary;
        delete r.compaction;
        if (r.followup) {
          r.followup.transcript = [];
          delete r.followup.references;
        }
        delete r.discussionUpdates;
        delete r.handoffRead;
        delete r.memoryContext;
        const count = w.messages.length;
        w.messages = w.messages.filter(
          (m) => !(m.runId === r.id && m.role === "assistant"),
        );
        removed ||= count !== w.messages.length;
      }
    }
  } while (removed);
  pruneSkillSources(w, now.getTime());
  w.adminChecks = w.adminChecks?.filter((check) => {
    if (
      check.status === "running" &&
      Date.parse(check.at) < now.getTime() - 120000
    ) {
      check.status = "failed";
      for (const attempt of check.attempts)
        if (attempt.status === "reserved") attempt.status = "unknown";
    }
    return (
      Date.parse(check.at) > now.getTime() - 90 * 86400000 ||
      check.attempts.some((attempt) => attempt.status !== "settled")
    );
  });
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
      delete r.contextSummary;
      delete r.compaction;
      delete r.memoryContext;
      if (r.followup) {
        r.followup.transcript = [];
        delete r.followup.references;
      }
      delete r.discussionUpdates;
    }
  w.deliveries = w.deliveries.filter((d) => Date.parse(d.at) > cutoff);
  w.threads = w.threads?.filter((t) =>
    w.messages.some((m) => m.threadId === t.id),
  );
  for (const thread of w.threads ?? []) {
    if (thread.summary && !validMemory(thread.summary, w.messages))
      delete thread.summary;
    thread.discussions = thread.discussions?.filter((d) =>
      validMemory(d, w.messages),
    );
    if (!thread.discussions?.some((d) => d.id === thread.activeDiscussionId))
      delete thread.activeDiscussionId;
  }
  w.tokens = w.tokens.filter((t) => Date.parse(t.expiresAt) > now.getTime());
  w.approvals = w.approvals.filter((a) => Date.parse(a.expiresAt) > cutoff);
  w.occurrences = w.occurrences.filter((o) => Date.parse(o.at) > cutoff);
  w.audit = w.audit.filter(
    (a) => Date.parse(a.at) > now.getTime() - 90 * 86400000,
  );
  pruneMemories(w, now.getTime());
}
