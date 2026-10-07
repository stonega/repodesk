import { describe, expect, test } from "bun:test";
import { validateSources } from "../../src/agent/context.ts";
import { workHandoff } from "../../src/agent/work-handoff.ts";
import { workflowSchema } from "../../src/domain.ts";
import { metadataQuery } from "../../src/github/metadata.ts";
import { recordRepositoryRead } from "../../src/github/metadata-policy.ts";
import { sweep } from "../../src/privacy/service.ts";
import { changeSkill } from "../../src/skills/catalog.ts";
import {
  completedSkillSource,
  proposeSkill,
} from "../../src/skills/proposals.ts";
import { repositoryReportWindow } from "../../src/workflows/schedule.ts";
import {
  decide,
  proposeWorkflow,
  tick,
  workflowAction,
} from "../../src/workflows/service.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { revokeWork, runAllowed } from "../../src/workspaces/policy.ts";
import { spec } from "../fixtures.ts";
import {
  developmentTask,
  fixtureValue,
  requestRun,
  reusableSkill,
  successfulRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

describe("repository reports", () => {
  test("daily repository reports cover the previous local calendar day", () => {
    const w = teamWorkspace();
    expect(
      repositoryReportWindow("2026-10-07T01:00:00Z", {
        ...spec(w),
        windowDays: 1,
      }),
    ).toEqual({ since: "2026-10-05T16:00:00Z", until: "2026-10-06T16:00:00Z" });
  });
  test("calendar report windows include complete short and long DST days", () => {
    const w = teamWorkspace(),
      input = {
        ...spec(w),
        windowDays: 1,
        recurrence: { ...spec(w).recurrence, timezone: "America/New_York" },
      };
    expect(repositoryReportWindow("2026-03-09T13:00:00Z", input)).toEqual({
      since: "2026-03-08T05:00:00Z",
      until: "2026-03-09T04:00:00Z",
    });
    expect(repositoryReportWindow("2026-11-02T14:00:00Z", input)).toEqual({
      since: "2026-11-01T04:00:00Z",
      until: "2026-11-02T05:00:00Z",
    });
  });
  test("query validation rejects mismatched windows, forged keys and issue merge requests", () => {
    const q = { repositoryId: 7001, kind: "issues", state: "merged" };
    expect(metadataQuery.safeParse(q).success).toBe(false);
    expect(
      metadataQuery.safeParse({
        repositoryId: 7001,
        kind: "pulls",
        token: "secret",
      }).success,
    ).toBe(false);
    expect(
      metadataQuery.safeParse({
        repositoryId: 7001,
        kind: "pulls",
        since: "2026-10-07T00:00:00Z",
        until: "2026-10-06T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      metadataQuery.safeParse({ repositoryId: 7001, kind: "pulls", page: 101 })
        .success,
    ).toBe(false);
  });
  test("private reads stay private; a linked group alone is not a private repository grant", () => {
    const w = teamWorkspace();
    const personal = requestRun(w);
    recordRepositoryRead(w, personal, 7001, 1);
    expect(runAllowed(w, personal)).toBe(true);
    const group = requestRun(w, "101", "-100100", 3);
    expect(() => recordRepositoryRead(w, group, 7001, 1)).toThrow(
      "github_metadata_scope_denied",
    );
    recordRepositoryRead(w, group, 7002, 1);
  });
  test("group reports require an admin and recheck repository authority at approval and dispatch", () => {
    const w = teamWorkspace();
    const input = {
      ...spec(w),
      github: { revision: 1, repositoryIds: [7001] },
    };
    expect(() => proposeWorkflow(w, "202", input)).toThrow(
      "github_workflow_scope_denied",
    );
    const p = proposeWorkflow(w, "101", input);
    fixtureValue(w.members.find((m) => m.id === "101")).role = "member";
    expect(() => decide(w, "101", p.approval.id, true)).toThrow(
      "github_workflow_scope_denied",
    );
    fixtureValue(w.members.find((m) => m.id === "101")).role = "owner";
    decide(w, "101", p.approval.id, true);
    const when = new Date(p.workflow.nextAt as string);
    tick(w, "gpt-4.1-mini", when);
    tick(w, "gpt-4.1-mini", when);
    expect(w.occurrences).toHaveLength(1);
    const r = fixtureValue(w.runs[0]);
    expect(r.githubRead).toEqual(input.github);
    recordRepositoryRead(w, r, 7001, 1);
    expect(() => recordRepositoryRead(w, r, 7002, 1)).toThrow(
      "github_workflow_source_denied",
    );
    fixtureValue(w.github).revision++;
    revokeWork(w);
    expect(p.workflow.status).toBe("suspended");
    expect(runAllowed(w, r)).toBe(false);
  });
  test("public group sources still require selected IDs; duplicate sources and connection changes fail", () => {
    const w = teamWorkspace();
    expect(
      workflowSchema.safeParse({
        ...spec(w),
        github: { revision: 1, repositoryIds: [7002, 7002] },
      }).success,
    ).toBe(false);
    expect(() =>
      proposeWorkflow(w, "101", {
        ...spec(w),
        github: { revision: 1, repositoryIds: [9000] },
      }),
    ).toThrow("github_workflow_scope_denied");
    expect(() =>
      proposeWorkflow(w, "202", {
        ...spec(w),
        github: { revision: 1, repositoryIds: [7002] },
      }),
    ).not.toThrow();
    const p = proposeWorkflow(w, "303", {
      ...spec(w),
      github: { revision: 1, repositoryIds: [7002] },
    });
    decide(w, "303", p.approval.id, true);
    workflowAction(
      w,
      "303",
      p.workflow.id,
      "pause",
      p.workflow.version,
      "gpt-4.1-mini",
    );
    fixtureValue(w.github).revision++;
    expect(() =>
      workflowAction(
        w,
        "303",
        p.workflow.id,
        "resume",
        p.workflow.version,
        "gpt-4.1-mini",
      ),
    ).toThrow();
  });
  test("owner grant loss suspends schedules; late repository reports never backfill", () => {
    const w = teamWorkspace();
    const p = proposeWorkflow(w, "101", {
      ...spec(w),
      chatId: "101",
      github: { revision: 1, repositoryIds: [7001] },
    });
    decide(w, "101", p.approval.id, true);
    tick(
      w,
      "gpt-4.1-mini",
      new Date(Date.parse(fixtureValue(p.workflow.nextAt)) + 6 * 60000),
    );
    expect(w.runs).toHaveLength(0);
    expect(w.occurrences[0]?.status).toBe("skipped");
    fixtureValue(w.github).repositories = [];
    revokeWork(w);
    expect(p.workflow.status).toBe("suspended");
  });
  test("API/application evidence permits a report without unrelated chat citations", () => {
    const w = teamWorkspace(),
      r = requestRun(w, "101", "101", 0, "Summarize merged PRs");
    expect(() => validateSources("PR #1", r)).toThrow("recap_requires_sources");
    r.tools.read = { name: "query_github_metadata", state: "done" };
    expect(
      validateSources("PR #1: https://github.com/example/private/pull/1", r),
    ).toContain("PR #1");
    expect(() => validateSources("[source:invented]", r)).toThrow(
      "invalid_source_citation",
    );
  });
});

describe("conversation skill drafts", () => {
  test("requester review creates one disabled draft; admin publishes and existing pins stay unchanged", () => {
    const w = teamWorkspace(),
      source = successfulRun(w, "202"),
      r = requestRun(w, "202");
    const p = proposeSkill(w, r, source.id, reusableSkill);
    expect(w.skills).toHaveLength(2);
    expect(() => decide(w, "101", p.approval.id, true)).toThrow(
      "approval_denied",
    );
    decide(w, "202", p.approval.id, true);
    const draft = fixtureValue(
      w.skills.find((s) => s.id === p.approval.target),
    );
    expect(draft.enabled).toBe(false);
    expect(draft.published).toHaveLength(0);
    expect(draft.origin?.actor).toBe("202");
    expect(() => decide(w, "202", p.approval.id, true)).toThrow(
      "approval_consumed",
    );
    expect(() => changeSkill(w, "202", draft.id, 1, "publish")).toThrow(
      "access_denied",
    );
    changeSkill(w, "101", draft.id, 1, "publish");
    changeSkill(w, "101", draft.id, 2, "enable");
    expect(draft.enabled).toBe(true);
    expect(r.skillPins.some((p) => p.id === draft.id)).toBe(false);
  });
  test("private sources, unfinished work and another group topic cannot be imported", () => {
    const w = teamWorkspace(),
      source = successfulRun(w),
      group = requestRun(w, "101", "-100100", 4);
    expect(() => completedSkillSource(w, "202", "202", 0, source.id)).toThrow(
      "skill_source_unavailable",
    );
    expect(() => proposeSkill(w, group, source.id, reusableSkill)).toThrow(
      "skill_source_unavailable",
    );
    const otherTopic = successfulRun(w, "101", "-100100", 7);
    expect(() => proposeSkill(w, group, otherTopic.id, reusableSkill)).toThrow(
      "skill_source_unavailable",
    );
    const queued = requestRun(w);
    expect(() => completedSkillSource(w, "101", "101", 0, queued.id)).toThrow(
      "skill_source_unavailable",
    );
  });
  test("source edits invalidate approval and any queued derived answer", () => {
    const w = teamWorkspace(),
      source = successfulRun(w),
      r = requestRun(w);
    const p = proposeSkill(w, r, source.id, reusableSkill);
    fixtureValue(
      w.messages.find((s) => s.id === fixtureValue(source.sources[0]).id),
    ).text = "Revised private input";
    expect(runAllowed(w, r)).toBe(false);
    expect(() => decide(w, "101", p.approval.id, true)).toThrow(
      "skill_source_changed",
    );
    sweep(w);
    expect(p.approval.decision).toBe("revoked");
    expect(p.approval.payload).toEqual({ removed: true });
  });
  test("erasure purges unpublished drafts; independently published procedures survive source retention", () => {
    const w = teamWorkspace(),
      source = successfulRun(w),
      r = requestRun(w);
    const p = proposeSkill(w, r, source.id, reusableSkill);
    decide(w, "101", p.approval.id, true);
    const draft = fixtureValue(
      w.skills.find((s) => s.id === p.approval.target),
    );
    w.messages = w.messages.filter(
      (s) => !fixtureValue(draft.origin).references.sourceIds.includes(s.id),
    );
    sweep(w);
    expect(draft.archived).toBe(true);
    expect(draft.draft.body).toBe("[source removed]");
    const independent = teamWorkspace(),
      good = successfulRun(independent),
      next = requestRun(independent);
    const approved = proposeSkill(independent, next, good.id, reusableSkill);
    decide(independent, "101", approved.approval.id, true);
    const published = fixtureValue(
      independent.skills.find((s) => s.id === approved.approval.target),
    );
    changeSkill(independent, "101", published.id, 1, "publish");
    independent.messages = [];
    sweep(independent);
    expect(published.draft.body).toBe(reusableSkill.body);
    expect(published.origin?.sourceRemovedAt).toBeTruthy();
  });
  test("secrets, copied source markers and oversized previews are refused", () => {
    const w = teamWorkspace(),
      source = successfulRun(w),
      r = requestRun(w);
    for (const body of [
      "[source:private]",
      "x".repeat(2401),
      `sk-${"a".repeat(30)}`,
    ])
      expect(() =>
        proposeSkill(w, r, source.id, { ...reusableSkill, body }),
      ).toThrow();
    expect(w.approvals).toHaveLength(0);
  });
});

describe("work handoffs", () => {
  test("historical repository results keep their authority dependency through successive handoffs", () => {
    const w = teamWorkspace(),
      source = successfulRun(w);
    recordRepositoryRead(w, source, 7001, 1);
    const first = requestRun(w);
    workHandoff(w, first, [], {});
    first.status = "succeeded";
    first.result = "Previous repository work is ready.";
    const second = requestRun(w);
    workHandoff(w, second, [], {});
    expect(runAllowed(w, second)).toBe(true);
    fixtureValue(w.github).revision++;
    expect(runAllowed(w, first)).toBe(false);
    expect(runAllowed(w, second)).toBe(false);
  });
  test("cyclic derived-record references are refused", () => {
    const w = teamWorkspace(),
      source = successfulRun(w),
      r = requestRun(w);
    workHandoff(w, r, [], {});
    source.handoffRead = {
      references: memoryReferences(source.sources),
      runIds: [r.id],
      chatIds: ["101"],
      repositoryIds: [],
    };
    expect(runAllowed(w, r)).toBe(false);
  });
  test("personal handoffs aggregate own work, prioritize questions and preserve verification uncertainty", () => {
    const w = teamWorkspace(),
      completed = successfulRun(w),
      task = developmentTask(w);
    const other = developmentTask(w, "303");
    const r = requestRun(w, "101", "101", 9, "Where did we leave off?");
    const result = workHandoff(w, r, [task, other], {});
    expect(result.entries[0]?.id).toBe(`development:${task.id}`);
    expect(result.entries[0]?.question).toContain("sessions");
    expect(result.entries[0]?.verification).toMatchObject({
      currentRevisionVerified: false,
    });
    expect(result.entries.some((e) => e.runId === completed.id)).toBe(true);
    expect(result.entries.some((e) => e.id === `development:${other.id}`)).toBe(
      false,
    );
    expect(runAllowed(w, r)).toBe(true);
  });
  test("group handoffs exclude private work and other topics, including administrator private runs", () => {
    const w = teamWorkspace(),
      privateTask = developmentTask(w),
      current = developmentTask(w, "303", "-100100", 3),
      another = developmentTask(w, "101", "-100100", 4);
    successfulRun(w);
    const r = requestRun(w, "101", "-100100", 3, "What needs review?");
    const result = workHandoff(w, r, [privateTask, current, another], {});
    expect(result.entries.map((e) => e.id)).toEqual([
      `development:${current.id}`,
    ]);
  });
  test("coding grant revocation or source erasure prevents a queued handoff answer", () => {
    const w = teamWorkspace(),
      task = developmentTask(w),
      r = requestRun(w);
    workHandoff(w, r, [task], {});
    fixtureValue(fixtureValue(w.coding).settings.repositories[0]).maintainers =
      ["303"];
    expect(runAllowed(w, r)).toBe(false);
    const next = teamWorkspace(),
      selected = developmentTask(next),
      reading = requestRun(next);
    workHandoff(next, reading, [selected], {});
    next.messages = next.messages.filter((s) => s.id !== selected.sourceId);
    expect(runAllowed(next, reading)).toBe(false);
    sweep(next);
    expect(reading.task).toBe("[source removed]");
  });
  test("discussion decisions/todos use retained provenance and remain topic scoped", () => {
    const w = teamWorkspace(),
      old = successfulRun(w, "101", "101", 8),
      r = requestRun(w, "101", "101", 9);
    fixtureValue(
      fixtureValue(w.threads).find((t) => t.id === old.threadId),
    ).discussions = [
      {
        id: "old-discussion",
        title: "Session policy",
        summary: "Keep existing sessions",
        decisions: ["Keep valid sessions"],
        todos: ["Review expiration behavior"],
        relatedIds: [],
        messageIds: old.sources.map((s) => s.id),
        updatedAt: old.at,
        ...memoryReferences(old.sources),
      },
    ];
    const result = workHandoff(w, r, [], { query: "Session policy" });
    expect(result.entries.find((e) => e.kind === "discussion")?.todos).toEqual([
      "Review expiration behavior",
    ]);
    fixtureValue(
      w.messages.find((s) => s.id === fixtureValue(old.sources[0]).id),
    ).text = "Changed policy";
    expect(runAllowed(w, r)).toBe(false);
  });
  test("pagination is explicit and forged filters cannot widen identity or audience", () => {
    const w = teamWorkspace();
    successfulRun(w);
    successfulRun(w, "101", "101", 2);
    const r = requestRun(w);
    const first = workHandoff(w, r, [], { limit: 1 });
    expect(first.hasMore).toBe(true);
    const second = workHandoff(w, r, [], {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    expect(() => workHandoff(w, r, [], { actor: "303" })).toThrow();
    expect(() => workHandoff(w, r, [], { cursor: "someone-else" })).toThrow(
      "handoff_cursor_unavailable",
    );
  });
});
