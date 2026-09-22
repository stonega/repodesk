import { expect, test } from "bun:test";
import { branchName } from "../../src/coding/config.ts";
import {
  cancelCoding,
  codingDestination,
  proposeCoding,
} from "../../src/coding/policy.ts";
import { codingView, saveCoding } from "../../src/coding/service.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

export function codingFixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [{ id: 7001, full_name: "example/workspace" }],
  };
  w.coding = {
    revision: 1,
    settings: {
      enabled: true,
      repositories: [
        {
          repositoryId: 7001,
          baseBranch: "develop",
          workflowFile: "deepx-codex.yml",
          maintainers: ["101"],
        },
      ],
    },
  };
  const run = createRun(
    w,
    "101",
    "Implement a bug fix",
    "101",
    0,
    "gpt-4.1-mini",
  );
  run.status = "running";
  return { w, run };
}
const input = {
  repositoryId: 7001,
  title: "Fix recap",
  body: "Include the last message. Add regression tests.",
};
test("only a repository maintainer can propose; workspace admin is not an implicit grant", () => {
  const { w } = codingFixture();
  for (const actor of ["202", "303"])
    expect(() => codingDestination(w, actor, input)).toThrow(
      "coding_maintainer_required",
    );
  expect(() =>
    codingDestination(w, "101", { ...input, repositoryId: 7002 }),
  ).toThrow();
  w.policy.allowed = [];
  expect(() => codingDestination(w, "101", input)).toThrow("access_denied");
});
test("full reviewed payload and one workflow per approved tool call", () => {
  const { w, run } = codingFixture();
  const a = proposeCoding(w, "101", run.id, "call", input);
  expect(proposeCoding(w, "101", run.id, "call", input).id).toBe(a.id);
  expect(w.deliveries).toHaveLength(1);
  expect(w.deliveries[0]?.text).toContain(input.body);
  expect(w.deliveries[0]?.text).toContain("develop");
  expect(w.codingTasks).toBeUndefined();
  expect(() => decide(w, "303", a.id, true)).toThrow("approval_denied");
  decide(w, "101", a.id, true);
  expect(w.codingTasks).toHaveLength(1);
  expect(w.codingTasks?.[0]?.state).toBe("queued");
  expect(() => decide(w, "101", a.id, true)).toThrow("approval_consumed");
});
test("changed destination, revoked maintainer, expiry, cancellation and payload tampering invalidate approval", () => {
  for (const mutate of [
    (f: ReturnType<typeof codingFixture>) => {
      present(present(f.w.coding).settings.repositories[0]).baseBranch = "main";
    },
    (f: ReturnType<typeof codingFixture>) => {
      present(present(f.w.coding).settings.repositories[0]).maintainers = [
        "202",
      ];
    },
    (f: ReturnType<typeof codingFixture>) => {
      present(f.w.github).revision++;
    },
    (f: ReturnType<typeof codingFixture>) => {
      f.run.cancelled = true;
    },
    (f: ReturnType<typeof codingFixture>) => {
      present(f.w.approvals[0]).expiresAt = new Date(0).toISOString();
    },
    (f: ReturnType<typeof codingFixture>) => {
      (present(f.w.approvals[0]).payload as { body: string }).body = "tampered";
    },
  ]) {
    const f = codingFixture();
    const a = proposeCoding(f.w, "101", f.run.id, "call", input);
    mutate(f);
    expect(() => decide(f.w, "101", a.id, true)).toThrow();
    expect(f.w.codingTasks?.length ?? 0).toBe(0);
  }
});
test("configuration is operator and tenant scoped with optimistic revision and active members", () => {
  const { w } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const settings = present(w.coding).settings;
  expect(() => codingView(w, { ...admin, id: "other" })).toThrow(
    "access_denied",
  );
  expect(() =>
    saveCoding(w, { ...admin, operator: false }, { revision: 1, settings }),
  ).toThrow();
  expect(() => saveCoding(w, admin, { revision: 0, settings })).toThrow(
    "version_conflict",
  );
  const bad = structuredClone(settings);
  present(bad.repositories[0]).maintainers = ["999"];
  expect(() => saveCoding(w, admin, { revision: 1, settings: bad })).toThrow(
    "coding_maintainer_inactive",
  );
  expect(saveCoding(w, admin, { revision: 1, settings }).revision).toBe(2);
});
test("branch validation rejects ref tricks, options and path traversal", () => {
  for (const value of [
    "--help",
    "../main",
    "a..b",
    "foo.lock",
    "a/.hidden",
    "a//b",
    "a/",
    "main.",
    "a b",
    "refs/heads/x^{commit}",
  ])
    expect(branchName.safeParse(value).success).toBe(false);
  for (const value of ["develop", "release/next", "feature-x_2.0"])
    expect(branchName.safeParse(value).success).toBe(true);
});
test("initiator can stop after maintainer removal; deletion purges coding data", () => {
  const { w, run } = codingFixture();
  const a = proposeCoding(w, "101", run.id, "call", input);
  decide(w, "101", a.id, true);
  present(present(w.coding).settings.repositories[0]).maintainers = ["303"];
  expect(cancelCoding(w, "101", a.id).cancelRequested).toBe(true);
  expect(() => cancelCoding(w, "202", a.id)).toThrow(
    "coding_maintainer_required",
  );
  w.deletion = { requestedAt: new Date().toISOString(), providerState: "none" };
  sweep(w);
  expect(w.coding).toBeUndefined();
  expect(w.codingTasks).toBeUndefined();
});

test("disconnected repositories do not prevent disabling the extension", () => {
  const { w } = codingFixture();
  const settings = present(w.coding).settings;
  w.github = { revision: 2, repositories: [] };
  const result = saveCoding(
    w,
    { id: w.operatorId, operator: true, username: "operator" },
    { revision: 1, settings: { ...settings, enabled: false } },
  );
  expect(result.settings.enabled).toBe(false);
});
