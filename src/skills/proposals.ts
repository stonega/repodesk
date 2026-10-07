import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Approval,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { githubReadAllowed } from "../github/metadata-policy.ts";
import { fingerprint } from "../setup/credentials.ts";
import { memoryReferences } from "../workspaces/conversation-memory.ts";
import { audience, audit, authorize } from "../workspaces/policy.ts";
import { validateSkill } from "./catalog.ts";
import { skillSourcesPresent } from "./provenance.ts";

export function completedSkillSource(
  w: Workspace,
  actor: string,
  chatId: string,
  topicId: number,
  id: string,
) {
  audience(w, actor, chatId);
  const source = w.runs.find((r) => r.id === id);
  requireThat(
    source &&
      source.actor === actor &&
      source.chatId === chatId &&
      (chatId === actor || source.topicId === topicId) &&
      source.status === "succeeded" &&
      !source.cancelled &&
      !!source.result &&
      !source.codingTaskId &&
      Date.parse(source.at) > Date.now() - w.settings.retentionDays * 86400000,
    "skill_source_unavailable",
    404,
  );
  const references = memoryReferences(source.sources);
  requireThat(githubReadAllowed(w, source), "skill_source_unavailable", 404);
  requireThat(
    skillSourcesPresent(w, references) &&
      (!source.contextSummary || skillSourcesPresent(w, source.contextSummary)),
    "skill_source_changed",
    409,
  );
  return { source, references };
}

export function readSkillSource(w: Workspace, r: Run, id: string) {
  const { source, references } = completedSkillSource(
    w,
    r.actor,
    r.chatId,
    r.topicId,
    id,
  );
  const prior = r.handoffRead;
  const all = w.messages.filter(
    (s) =>
      references.sourceIds.includes(s.id) ||
      prior?.references.sourceIds.includes(s.id),
  );
  r.handoffRead = {
    references: memoryReferences(all),
    runIds: [...new Set([...(prior?.runIds ?? []), source.id])],
    chatIds: [...new Set([...(prior?.chatIds ?? []), source.chatId])],
    repositoryIds: prior?.repositoryIds ?? [],
    codingRevision: prior?.codingRevision,
  };
  for (const s of source.sources)
    if (!r.sources.some((prior) => prior.id === s.id))
      r.sources.push(structuredClone(s));
  return {
    runId: source.id,
    request: source.task.slice(0, 4000),
    result: source.result?.slice(0, 6000),
    sources: references.sourceIds,
    at: source.at,
    guidance:
      "Draft a reusable procedure, inputs, output conventions and a sanitized example. Do not copy the transcript, private facts, secrets or source citation markers.",
  };
}

const proposal = z
  .object({
    sourceRunId: z.string().min(1).max(100),
    chatId: z.string(),
    topicId: z.number().int().nonnegative(),
    spec: z.unknown(),
    references: z.object({
      sourceIds: z.array(z.string()),
      sourceHash: z.string(),
    }),
  })
  .strict();

export function proposeSkill(
  w: Workspace,
  r: Run,
  sourceRunId: string,
  input: unknown,
) {
  authorize(w, r.actor);
  const { references } = completedSkillSource(
    w,
    r.actor,
    r.chatId,
    r.topicId,
    sourceRunId,
  );
  readSkillSource(w, r, sourceRunId);
  const spec = validateSkill(input);
  requireThat(
    spec.body.length <= 2400 && !/\[source:/i.test(spec.body),
    "skill_preview_too_large_or_unsanitized",
  );
  requireThat(
    !w.approvals.some(
      (a) =>
        a.actor === r.actor &&
        !a.decision &&
        Date.parse(a.expiresAt) > Date.now(),
    ),
    "resolve_existing_proposal_first",
    409,
  );
  requireThat(w.skills.length < 100, "skill_capacity_reached", 429);
  requireThat(
    !w.skills.some((s) => s.draft.slug === spec.slug),
    "duplicate_slug",
    409,
  );
  const payload = {
    sourceRunId,
    chatId: r.chatId,
    topicId: r.topicId,
    spec,
    references,
  };
  const approval: Approval = {
    id: randomUUID(),
    actor: r.actor,
    kind: "skill",
    runId: r.id,
    target: randomUUID(),
    version: 1,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  };
  w.approvals.push(approval);
  audit(w, r.actor, "skill.proposed", approval.target);
  return { approval, spec };
}

export function approveSkill(w: Workspace, approval: Approval) {
  const payload = proposal.parse(approval.payload);
  const { references } = completedSkillSource(
    w,
    approval.actor,
    payload.chatId,
    payload.topicId,
    payload.sourceRunId,
  );
  requireThat(
    fingerprint(references) === fingerprint(payload.references),
    "skill_source_changed",
    409,
  );
  const spec = validateSkill(payload.spec);
  requireThat(w.skills.length < 100, "skill_capacity_reached", 429);
  requireThat(
    !w.skills.some(
      (s) => s.draft.slug === spec.slug || s.id === approval.target,
    ),
    "duplicate_slug",
    409,
  );
  w.skills.push({
    id: approval.target,
    version: 1,
    enabled: false,
    archived: false,
    published: [],
    draft: spec,
    tests: [],
    origin: {
      runId: payload.sourceRunId,
      actor: approval.actor,
      references,
      sharedAt: new Date().toISOString(),
    },
  });
  audit(w, approval.actor, "skill.created_from_run", approval.target);
}

export function pruneSkillSources(w: Workspace, now: number) {
  for (const s of w.skills)
    if (s.origin && !skillSourcesPresent(w, s.origin.references, now)) {
      s.origin.sourceRemovedAt ??= new Date(now).toISOString();
      // Publication approves a standalone procedure with its own lifecycle.
      if (s.published.length) continue;
      s.enabled = false;
      s.archived = true;
      s.draft = {
        ...s.draft,
        name: "Source removed",
        slug: `removed-${s.id}`,
        body: "[source removed]",
        description: "Source removed",
      };
      s.published = s.published.map((spec) => ({
        ...spec,
        body: "[source removed]",
        description: "Source removed",
      }));
      s.tests = [];
    }
  for (const a of w.approvals)
    if (a.kind === "skill") {
      const parsed = proposal.safeParse(a.payload);
      if (
        !parsed.success ||
        !skillSourcesPresent(w, parsed.data.references, now)
      ) {
        if (!a.decision) a.decision = "revoked";
        a.payload = { removed: true };
      }
    }
}
