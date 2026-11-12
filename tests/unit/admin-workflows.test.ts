import { describe, expect, test } from "bun:test";
import { workflowOwner, workflowView } from "../../src/admin/workflow-view.ts";
import {
  decide,
  proposeInstruction,
  proposeWorkflow,
  saveManagedWorkflow,
  tick,
  workflowAction,
} from "../../src/workflows/service.ts";
import { revokeWork, runAllowed } from "../../src/workspaces/policy.ts";
import { spec } from "../fixtures.ts";
import { fixtureValue, teamWorkspace } from "../team-workflows-fixture.ts";

describe("panel workflow management", () => {
  test("edit capability requires the active current owner and defaults to denied", () => {
    const w = teamWorkspace();
    const { workflow } = proposeWorkflow(w, "303", spec(w));
    expect(workflowView(w, workflow).canEdit).toBe(false);
    expect(workflowView(w, workflow, w.operatorId).canEdit).toBe(false);
    expect(workflowView(w, workflow, "101").canEdit).toBe(false);
    expect(workflowView(w, workflow, "303").canEdit).toBe(true);
    fixtureValue(w.members.find((m) => m.id === "303")).active = false;
    expect(workflowView(w, workflow, "303").canEdit).toBe(false);
  });

  test("workflow summaries expose only the current owner's display profile", () => {
    const w = teamWorkspace();
    const owner = fixtureValue(w.members.find((m) => m.id === "202"));
    Object.assign(owner, {
      name: "Taylor Example",
      username: "taylor",
      profileUpdatedAt: new Date().toISOString(),
    });
    const { workflow } = proposeWorkflow(w, owner.id, {
      ...spec(w),
      chatId: owner.id,
    });
    expect(workflowView(w, workflow).ownerProfile).toEqual({
      id: "202",
      name: "Taylor Example",
      username: "taylor",
    });
    owner.name = "Updated name";
    owner.username = undefined;
    expect(workflowView(w, workflow).ownerProfile).toEqual({
      id: "202",
      name: "Updated name",
      username: undefined,
    });
    w.members = [];
    expect(workflowView(w, workflow).ownerProfile).toEqual({
      id: "202",
      name: undefined,
      username: undefined,
    });
  });

  test("panel saves activate the exact version without a pending admin review", () => {
    const w = teamWorkspace();
    const result = saveManagedWorkflow(
      w,
      "202",
      { ...spec(w), chatId: "202" },
      w.operatorId,
    );
    expect(result.workflow).toMatchObject({ owner: "202", status: "active" });
    expect(result).not.toHaveProperty("approval");
    expect(w.approvals.every((a) => a.decision === "approved")).toBe(true);
    workflowAction(
      w,
      "202",
      result.workflow.id,
      "pause",
      1,
      "test-model",
      w.operatorId,
    );
    expect(() =>
      saveManagedWorkflow(
        w,
        "202",
        {
          ...result.workflow.spec,
          task: "Updated while paused",
        },
        w.operatorId,
        result.workflow.id,
        1,
      ),
    ).toThrow("owner_required");
    const own = saveManagedWorkflow(w, "101", spec(w), "101").workflow;
    workflowAction(w, "101", own.id, "pause", 1, "test-model");
    const edited = saveManagedWorkflow(
      w,
      "101",
      { ...own.spec, task: "Updated while paused" },
      "101",
      own.id,
      1,
    );
    expect(edited.workflow).toMatchObject({ status: "paused", version: 2 });
    expect(edited.workflow.nextAt).toBeUndefined();
    expect(w.approvals.every((a) => a.decision === "approved")).toBe(true);
    expect(() =>
      saveManagedWorkflow(w, "202", result.workflow.spec, "202"),
    ).toThrow("access_denied");
  });

  test("operator approval preserves execution ownership, duplicate ticks and team budgets", () => {
    const w = teamWorkspace();
    const manager = w.operatorId;
    const input = {
      ...spec(w),
      github: { revision: 1, repositoryIds: [7001] },
    };
    const { workflow, approval } = proposeWorkflow(
      w,
      workflowOwner(w, manager, input),
      input,
      new Date(),
      undefined,
      undefined,
      manager,
    );
    expect(workflow.owner).toBe("101");
    expect(approval.actor).toBe(manager);
    revokeWork(w);
    expect(approval.decision).toBeUndefined();
    decide(w, manager, approval.id, true, new Date(), manager);
    w.settings.runBudgetUsd = 0;
    const now = new Date(workflow.nextAt as string);
    tick(w, "test-model", now);
    tick(w, "test-model", now);
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]?.actor).toBe("101");
    expect(w.runs[0]?.settings.runBudgetUsd).toBe(0);
    expect(runAllowed(w, fixtureValue(w.runs[0]))).toBe(true);
    fixtureValue(w.github).revision++;
    revokeWork(w);
    expect(workflow.status).toBe("suspended");
    expect(w.runs[0]?.status).toBe("cancelled");
  });

  test("panel administrators cannot edit another owner's workflow through the proposal service", () => {
    const w = teamWorkspace();
    const proposal = proposeWorkflow(w, "202", { ...spec(w), chatId: "202" });
    decide(w, "303", proposal.approval.id, true, new Date(), "303");
    const before = structuredClone(proposal.workflow);
    for (const manager of ["101", "303", w.operatorId])
      expect(() =>
        proposeWorkflow(
          w,
          "202",
          { ...proposal.workflow.spec, task: "Updated" },
          new Date(),
          proposal.workflow.id,
          1,
          manager,
        ),
      ).toThrow("owner_required");
    expect(proposal.workflow).toEqual(before);
    expect(w.approvals).toHaveLength(1);
  });

  test("member and foreign managers cannot act as administrators", () => {
    const w = teamWorkspace();
    for (const manager of ["202", "foreign-operator"]) {
      expect(() =>
        proposeWorkflow(
          w,
          "101",
          spec(w),
          new Date(),
          undefined,
          undefined,
          manager,
        ),
      ).toThrow("access_denied");
    }
    expect(w.workflows).toHaveLength(0);
    const { workflow, approval } = proposeWorkflow(w, "101", spec(w));
    expect(() =>
      decide(w, "202", approval.id, true, new Date(), "202"),
    ).toThrow("access_denied");
    expect(() =>
      workflowAction(w, "101", workflow.id, "delete", 1, "test-model", "202"),
    ).toThrow("access_denied");
    expect(() =>
      proposeWorkflow(w, "303", spec(w), new Date(), workflow.id, 1),
    ).toThrow("owner_required");
    expect(workflow.status).toBe("draft");
  });

  test("manager authority cannot approve unrelated private instructions or bypass execution scope", () => {
    const w = teamWorkspace();
    const instruction = proposeInstruction(
      w,
      "101",
      "Keep it concise",
      "personal",
      "test",
    );
    expect(() =>
      decide(w, w.operatorId, instruction.id, true, new Date(), w.operatorId),
    ).toThrow("approval_denied");
    expect(instruction.decision).toBeUndefined();
    expect(() =>
      proposeWorkflow(
        w,
        "202",
        {
          ...spec(w),
          chatId: "-100100",
          github: { revision: 1, repositoryIds: [7001] },
        },
        new Date(),
        undefined,
        undefined,
        w.operatorId,
      ),
    ).toThrow("github_workflow_scope_denied");
    expect(() =>
      proposeWorkflow(
        w,
        "101",
        { ...spec(w), chatId: "-999" },
        new Date(),
        undefined,
        undefined,
        w.operatorId,
      ),
    ).toThrow("destination_denied");
  });

  test("revoking an execution owner blocks approval and dispatch despite panel authority", () => {
    const w = teamWorkspace();
    const { workflow, approval } = proposeWorkflow(
      w,
      "101",
      spec(w),
      new Date(),
      undefined,
      undefined,
      w.operatorId,
    );
    fixtureValue(w.members.find((m) => m.id === "101")).active = false;
    expect(() =>
      decide(w, w.operatorId, approval.id, true, new Date(), w.operatorId),
    ).toThrow("access_denied");
    expect(() =>
      workflowAction(
        w,
        "101",
        workflow.id,
        "run",
        1,
        "test-model",
        w.operatorId,
      ),
    ).toThrow("access_denied");
    expect(w.runs).toHaveLength(0);
    expect(
      workflowAction(
        w,
        "101",
        workflow.id,
        "delete",
        1,
        "test-model",
        w.operatorId,
      ).status,
    ).toBe("deleted");
  });

  test("new workflows resolve active execution owners and deleted records stay unavailable", () => {
    const w = teamWorkspace();
    expect(workflowOwner(w, w.operatorId, { ...spec(w), chatId: "202" })).toBe(
      "202",
    );
    expect(workflowOwner(w, w.operatorId, spec(w))).toBe("101");
    const { workflow } = proposeWorkflow(w, "101", spec(w));
    workflow.status = "deleted";
    expect(() =>
      workflowOwner(w, w.operatorId, undefined, workflow.id),
    ).toThrow("not_found");
    w.members.forEach((member) => {
      member.active = false;
    });
    expect(() => workflowOwner(w, w.operatorId, spec(w))).toThrow(
      "workflow_owner_unavailable",
    );
  });
});
