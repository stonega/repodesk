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
      repositories: [
        {
          repositoryId: 7001,
          baseBranch: "main",
          maintainers: ["202"],
        },
      ],
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
