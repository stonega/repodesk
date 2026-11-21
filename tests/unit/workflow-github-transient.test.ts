import { expect, test } from "bun:test";
import type { Workspace } from "../../src/domain.ts";
import { repositoryAccess } from "../../src/github/user-access.ts";
import { repositoryPermissionFingerprint } from "../../src/github/users.ts";
import { activateWorkflow, tick } from "../../src/workflows/service.ts";
import { revokeWork } from "../../src/workspaces/policy.ts";
import { workspace } from "../fixtures.ts";

const repository = {
  id: 7001,
  full_name: "example/repo",
  private: false,
  permissions: { pull: true, push: true, admin: false },
};

function fixture() {
  const w = workspace();
  w.github = { revision: 1, installationId: 501, repositories: [repository] };
  const member = w.members.find((m) => m.id === "202");
  if (!member) throw new Error("fixture");
  member.github = {
    id: 42,
    login: "member",
    status: "connected",
    connectionRevision: 1,
    syncedAt: new Date().toISOString(),
    repositories: [structuredClone(repository)],
  };
  const { workflow } = activateWorkflow(w, "202", {
    name: "Daily stars",
    task: "Report repository stars",
    format: "markdown",
    windowDays: 1,
    chatId: "202",
    topicId: 0,
    recurrence: {
      frequency: "daily",
      timezone: "Asia/Taipei",
      hour: 8,
      minute: 0,
    },
    github: { revision: 1, repositoryIds: [7001] },
  });
  return { w, workflow, access: member.github };
}

function suspensions(w: Workspace) {
  return w.audit.filter((a) => a.action === "workflow.suspended");
}

test("a transient GitHub sync failure defers dispatch without suspending the schedule", () => {
  const { w, workflow, access } = fixture();
  const nextAt = workflow.nextAt as string;
  access.status = "unavailable";
  access.syncError = "github_unavailable";
  revokeWork(w);
  revokeWork(w);
  expect(workflow.status).toBe("active");
  expect(workflow.reason).toBeUndefined();
  expect(suspensions(w)).toHaveLength(0);
  // Reads and dispatch still require fresh access.
  expect(repositoryAccess(w, "202", 7001)).toBe(false);
  const due = new Date(Date.parse(nextAt) + 1000);
  tick(w, "test-model", due);
  expect(w.runs).toHaveLength(0);
  expect(w.occurrences).toHaveLength(0);
  expect(workflow.nextAt).toBe(nextAt);
  // The next successful sync lets the deferred occurrence run once.
  access.status = "connected";
  access.syncError = undefined;
  access.syncedAt = new Date().toISOString();
  tick(w, "test-model", due);
  tick(w, "test-model", due);
  expect(w.runs).toHaveLength(1);
  expect(w.occurrences).toHaveLength(1);
  expect(workflow.status).toBe("active");
});

test("an overdue permission refresh does not suspend; a late occurrence is skipped after the missed-run window", () => {
  const { w, workflow, access } = fixture();
  const nextAt = workflow.nextAt as string;
  access.syncedAt = new Date(Date.now() - 11 * 60000).toISOString();
  revokeWork(w);
  expect(workflow.status).toBe("active");
  const late = new Date(
    Date.parse(nextAt) + (w.settings.missedRunMinutes + 1) * 60000,
  );
  tick(w, "test-model", late);
  expect(w.runs).toHaveLength(0);
  expect(w.occurrences).toEqual([
    expect.objectContaining({ status: "skipped", at: nextAt }),
  ]);
  expect(workflow.status).toBe("active");
  expect(suspensions(w)).toHaveLength(0);
});

test("confirmed GitHub denials and lost repository permissions still suspend the schedule", () => {
  for (const mutate of [
    (a: ReturnType<typeof fixture>["access"]) => {
      a.status = "unavailable";
      a.syncError = "github_access_denied";
      a.repositories = [];
    },
    (a: ReturnType<typeof fixture>["access"]) => {
      a.repositories = [];
    },
    (a: ReturnType<typeof fixture>["access"]) => {
      a.status = "disconnected";
      a.repositories = [];
    },
    // A transient failure cannot preserve a snapshot lacking pull access.
    (a: ReturnType<typeof fixture>["access"]) => {
      a.status = "unavailable";
      a.syncError = "github_unavailable";
      a.repositories = [];
    },
  ]) {
    const { w, workflow, access } = fixture();
    mutate(access);
    revokeWork(w);
    revokeWork(w);
    expect(workflow.status).toBe("suspended");
    expect(workflow.reason).toBe("github_workflow_scope_denied");
    expect(suspensions(w)).toHaveLength(1);
  }
});

test("a workspace connection change still suspends during a transient sync failure", () => {
  const { w, workflow, access } = fixture();
  access.status = "unavailable";
  access.syncError = "github_unavailable";
  if (!w.github) throw new Error("fixture");
  w.github.revision = 2;
  w.github.connectionRevision = 2;
  revokeWork(w);
  expect(workflow.status).toBe("suspended");
  expect(workflow.reason).toBe("github_workflow_scope_denied");
});

test("repository permission fingerprint ignores JSONB key order, page order and activity timestamps", () => {
  const two = {
    id: 2,
    full_name: "a/two",
    pushed_at: "2026-11-21T14:00:00Z",
    updated_at: "2026-11-21T14:05:00Z",
    permissions: { pull: true, push: false, admin: false },
  };
  const one = {
    id: 1,
    full_name: "a/one",
    pushed_at: "2026-11-21T13:00:00Z",
    permissions: { pull: true, push: true, admin: false },
  };
  const fetched = [two, one];
  const stored = JSON.parse(
    '[{"full_name":"a/one","id":1,"permissions":{"admin":false,"pull":true,"push":true},"pushed_at":"2026-11-20T00:00:00Z"},{"full_name":"a/two","id":2,"permissions":{"admin":false,"pull":true,"push":false},"updated_at":"2026-11-20T00:00:00Z"}]',
  );
  expect(JSON.stringify(fetched)).not.toBe(JSON.stringify(stored));
  expect(repositoryPermissionFingerprint(fetched)).toBe(
    repositoryPermissionFingerprint(stored),
  );
  const changed = [
    two,
    {
      ...one,
      permissions: { pull: true, push: false, admin: false },
    },
  ];
  expect(repositoryPermissionFingerprint(changed)).not.toBe(
    repositoryPermissionFingerprint(stored),
  );
});
