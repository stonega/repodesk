import { expect, test } from "bun:test";
import { codingDestination } from "../../src/coding/policy.ts";
import { issueApproval } from "../../src/github/issues.ts";
import {
  authorizeRepository,
  invalidateGitHubWork,
  repositoryAccess,
} from "../../src/github/user-access.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function linked() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [{ id: 7001, full_name: "example/workspace" }],
  };
  const member = w.members.find((m) => m.id === "202");
  if (member)
    member.github = {
      id: 42,
      login: "member",
      status: "connected",
      connectionRevision: 1,
      syncedAt: new Date().toISOString(),
      repositories: [
        {
          id: 7001,
          full_name: "example/workspace",
          permissions: { pull: true, push: false, admin: false },
        },
      ],
    };
  return w;
}
test("synced read access permits issue proposals but does not confer coding access or workspace roles", () => {
  const w = linked();
  expect(repositoryAccess(w, "202", 7001)).toBe(true);
  expect(() => authorizeRepository(w, "202", 7001, true)).toThrow(
    "github_user_access_denied",
  );
  expect(
    issueApproval(w, "202", {
      repositoryId: 7001,
      revision: 1,
      title: "Report",
      body: "Test",
    }).kind,
  ).toBe("github_issue");
  expect(w.members.find((m) => m.id === "202")?.role).toBe("member");
  w.coding = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
    },
  };
  expect(() =>
    codingDestination(w, "202", {
      repositoryId: 7001,
      title: "Fix",
      body: "Test",
    }),
  ).toThrow("github_user_access_denied");
});
test("missing permission data, disconnected credentials and stale snapshots deny linked access", () => {
  const w = linked();
  const access = w.members.find((m) => m.id === "202")?.github;
  if (!access) throw new Error("fixture");
  delete access.repositories[0]?.permissions;
  expect(repositoryAccess(w, "202", 7001)).toBe(false);
  expect(() =>
    issueApproval(w, "202", {
      repositoryId: 7001,
      revision: 1,
      title: "Report",
      body: "Test",
    }),
  ).toThrow("github_user_access_denied");
  access.status = "disconnected";
  expect(repositoryAccess(w, "202", 7001)).toBe(false);
  // Explicit existing operator-managed grants remain backward compatible.
  expect(repositoryAccess(w, "101", 7001)).toBe(true);
});
test("permission revocation cancels actor work and pending writes without touching another member", () => {
  const w = linked();
  const run = createRun(w, "202", "Read repository", "202", 0, "test-model");
  const other = createRun(w, "303", "Other work", "303", 0, "test-model");
  const approval = issueApproval(w, "202", {
    repositoryId: 7001,
    revision: 1,
    title: "Report",
    body: "Test",
  });
  approval.decision = "approved";
  w.deliveries.push({
    id: "answer",
    actor: "202",
    chatId: "202",
    topicId: 0,
    text: "Source",
    runId: run.id,
    state: "pending",
    attempts: 0,
    at: new Date().toISOString(),
  });
  invalidateGitHubWork(w, "202");
  expect(run.cancelled).toBe(true);
  expect(String(approval.decision)).toBe("revoked");
  expect(w.deliveries[0]?.state).toBe("cancelled");
  expect(other.cancelled).toBe(false);
});
test("unavailable and expired snapshots block actions with a retryable error; confirmed denials do not", () => {
  const w = linked();
  const access = w.members.find((m) => m.id === "202")?.github;
  if (!access) throw new Error("fixture");
  for (const state of ["unavailable", "stale"] as const) {
    access.status = state === "stale" ? "connected" : "unavailable";
    access.syncedAt = new Date(Date.now() - 11 * 60000).toISOString();
    expect(repositoryAccess(w, "202", 7001)).toBe(false);
    expect(() => authorizeRepository(w, "202", 7001)).toThrow(
      "github_user_access_unavailable",
    );
  }
  access.status = "unavailable";
  access.syncError = "github_access_denied";
  expect(() => authorizeRepository(w, "202", 7001)).toThrow(
    "github_user_access_denied",
  );
});

test("targeted permission loss preserves other repository work and fences dependent answers and writes", () => {
  const w = linked();
  const access = w.members.find((m) => m.id === "202")?.github;
  if (!w.github || !access) throw new Error("fixture");
  const second = {
    id: 7002,
    full_name: "example/second",
    permissions: { pull: true, push: true, admin: false },
  };
  w.github.repositories.push(second);
  access.repositories.push(second);
  const first = createRun(w, "202", "First report", "202", 0, "test-model");
  first.githubRead = { revision: 1, repositoryIds: [7001] };
  const lost = createRun(w, "202", "Second report", "202", 0, "test-model");
  lost.githubRead = { revision: 1, repositoryIds: [7002] };
  const dependent = createRun(w, "202", "Follow-up", "202", 0, "test-model");
  dependent.followup = {
    anchorRunId: lost.id,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    decision: "reply",
    transcript: [],
  };
  const approvals = [7001, 7002].map((repositoryId) =>
    issueApproval(w, "202", {
      repositoryId,
      revision: 1,
      title: "Report",
      body: "Fixture",
    }),
  );
  for (const run of [first, lost])
    w.deliveries.push({
      id: `output-${run.id}`,
      actor: "202",
      chatId: "202",
      topicId: 0,
      runId: run.id,
      text: "Fixture",
      state: "pending",
      attempts: 0,
      at: new Date().toISOString(),
    });
  invalidateGitHubWork(w, "202", []);
  expect(w.runs.every((r) => !r.cancelled)).toBe(true);
  invalidateGitHubWork(w, "202", [7002]);
  expect(first.cancelled).toBe(false);
  expect(lost.cancelled).toBe(true);
  expect(dependent.cancelled).toBe(true);
  expect(approvals[0]?.decision).toBeUndefined();
  expect(approvals[1]?.decision).toBe("revoked");
  expect(w.deliveries.find((d) => d.runId === first.id)?.state).toBe("pending");
  expect(w.deliveries.find((d) => d.runId === lost.id)?.state).toBe(
    "cancelled",
  );
});
