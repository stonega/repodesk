import { expect, test } from "bun:test";
import { branchName, type CodingTask } from "../../src/coding/config.ts";
import { CodingGitHub } from "../../src/coding/github.ts";
import {
  cancelCoding,
  codingDestination,
  proposeCoding,
} from "../../src/coding/policy.ts";
import { codingView, saveCoding } from "../../src/coding/service.ts";
import { sweep } from "../../src/privacy/service.ts";
import { decrypt } from "../../src/setup/credentials.ts";
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
test("coding run and PR discovery accept RepoDesk and earlier task names", async () => {
  for (const prefix of ["repodesk", "deepx"]) {
    const id = "task-123";
    const branch = `codex/${prefix}-${id}`;
    const task = {
      id,
      createdAt: "2026-09-26T00:00:00.000Z",
      issue: {
        number: 42,
        url: "https://github.com/example/workspace/issues/42",
      },
      payload: {
        repository: "example/workspace",
        baseBranch: "develop",
        workflowFile: `${prefix}-codex.yml`,
      },
    } as CodingTask;
    const github = new CodingGitHub((async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/runs"))
        return Response.json({
          workflow_runs: [
            {
              id: 81,
              display_title: `${prefix}-coding:${id}`,
              event: "workflow_dispatch",
              head_branch: "develop",
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      if (url.pathname.endsWith("/pulls"))
        return Response.json(
          url.searchParams.get("head") === `example:${branch}`
            ? [
                {
                  number: 43,
                  body: "Implements https://github.com/example/workspace/issues/42",
                  head: {
                    ref: branch,
                    repo: { full_name: "example/workspace" },
                  },
                  base: { ref: "develop" },
                },
              ]
            : [],
        );
      throw new Error(`Unexpected GitHub request: ${url.pathname}`);
    }) as typeof fetch);
    expect((await github.run("token", task))?.id).toBe(81);
    expect(await github.pull("token", task)).toBe(
      "https://github.com/example/workspace/pull/43",
    );
  }
});
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

test("workspace provider credentials are encrypted, redacted, revisioned and explicitly removable", () => {
  const { w, run } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const key = "ab".repeat(32);
  const settings = present(w.coding).settings;
  const approval = proposeCoding(w, "101", run.id, "before-key", input);
  const save = (revision: number, providerApiKey?: string | null) =>
    saveCoding(w, admin, { revision, settings, providerApiKey }, key);
  const page = save(1, "workspace-provider-secret");
  const ciphertext = present(w.coding?.providerApiKey);
  expect(ciphertext).not.toContain("workspace-provider-secret");
  expect(decrypt(key, `coding-provider:${w.id}`, ciphertext)).toBe(
    "workspace-provider-secret",
  );
  expect(() =>
    decrypt(key, "coding-provider:another-workspace", ciphertext),
  ).toThrow();
  expect(page.providerApiKeyConfigured).toBe(true);
  expect(JSON.stringify(page)).not.toContain(ciphertext);
  expect(JSON.stringify(w)).not.toContain("workspace-provider-secret");
  expect(() => decide(w, "101", approval.id, true)).toThrow();
  save(2);
  expect(w.coding?.providerApiKey).toBe(ciphertext);
  expect(() => save(2, "stale-secret")).toThrow("version_conflict");
  expect(() =>
    saveCoding(
      w,
      { ...admin, id: "other" },
      { revision: 3, settings, providerApiKey: "foreign-secret" },
      key,
    ),
  ).toThrow("access_denied");
  expect(w.coding?.providerApiKey).toBe(ciphertext);
  expect(() => save(3, " ")).toThrow();
  save(3, "replacement-secret");
  expect(
    decrypt(key, `coding-provider:${w.id}`, present(w.coding?.providerApiKey)),
  ).toBe("replacement-secret");
  expect(save(4, null).providerApiKeyConfigured).toBe(false);
  expect(w.coding?.providerApiKey).toBeUndefined();
});
