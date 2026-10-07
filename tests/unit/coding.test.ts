import { expect, test } from "bun:test";
import { branchName } from "../../src/coding/config.ts";
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
      backend: "podman",
      authMode: "provider_key",
      repositories: [
        {
          repositoryId: 7001,
          baseBranch: "develop",
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
test("legacy Actions settings cannot authorize a new coding task", () => {
  const { w } = codingFixture();
  (present(w.coding).settings as { backend: string }).backend =
    "github-actions";
  expect(() => codingDestination(w, "101", input)).toThrow(
    "coding_local_configuration_required",
  );
});
test("legacy settings discard operator commands and allow autonomous execution", () => {
  const { w } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const legacy = present(w.coding).settings;
  (legacy as { backend: string }).backend = "github-actions";
  Object.assign(present(legacy.repositories[0]), {
    workflowFile: "repodesk-codex.yml",
    setupCommand: "exit 91",
    checkCommand: "exit 92",
  });
  const page = codingView(w, admin);
  expect(page.legacyActionsConfiguration).toBe(true);
  expect(page.settings.repositories[0]).not.toHaveProperty("setupCommand");
  expect(page.settings.repositories[0]).not.toHaveProperty("checkCommand");
  const saved = saveCoding(w, admin, {
    revision: page.revision,
    settings: page.settings,
  });
  expect(saved.settings.enabled).toBe(true);
  expect(saved.legacyActionsConfiguration).toBe(false);
  expect(codingDestination(w, "101", input)).not.toHaveProperty("checkCommand");
});
test("repository saves discard obsolete command overrides from older clients", () => {
  const { w } = codingFixture();
  const settings = structuredClone(present(w.coding).settings);
  Object.assign(present(settings.repositories[0]), {
    setupCommand: "exit 91",
    checkCommand: "exit 92",
  });
  const saved = saveCoding(
    w,
    { id: w.operatorId, operator: true, username: "operator" },
    { revision: 1, settings },
  );
  expect(saved.settings.repositories[0]).not.toHaveProperty("setupCommand");
  expect(saved.settings.repositories[0]).not.toHaveProperty("checkCommand");
  expect(codingDestination(w, "101", input)).not.toHaveProperty("checkCommand");
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
  w.members.forEach((member) => {
    member.active = false;
  });
  expect(() => codingDestination(w, "101", input)).toThrow("access_denied");
});
test("device auth uses connected repositories regardless of visibility", () => {
  const { w } = codingFixture();
  present(w.coding).settings.authMode = "device_code";
  for (const visibility of [true, false, undefined]) {
    present(present(w.github).repositories[0]).private = visibility;
    expect(codingDestination(w, "101", input).authMode).toBe("device_code");
  }
  expect(() => codingDestination(w, "202", input)).toThrow(
    "coding_maintainer_required",
  );
  expect(() =>
    codingDestination(w, "101", { ...input, repositoryId: 7002 }),
  ).toThrow();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const page = saveCoding(w, admin, {
    revision: present(w.coding).revision,
    settings: present(w.coding).settings,
  });
  expect(page.settings.authMode).toBe("device_code");
});
test("full reviewed payload and one local task per approved tool call", () => {
  const { w, run } = codingFixture();
  const a = proposeCoding(w, "101", run.id, "call", input);
  expect(proposeCoding(w, "101", run.id, "call", input).id).toBe(a.id);
  expect(w.deliveries).toHaveLength(1);
  expect(w.deliveries[0]?.text).toContain(input.body);
  expect(w.deliveries[0]?.text).toContain("develop");
  expect(w.deliveries[0]?.text).toContain("local Podman");
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
  const owner = w.members.find((member) => member.id === "101");
  if (!owner) throw new Error("Missing owner fixture");
  owner.username = "maintainer";
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const settings = present(w.coding).settings;
  expect(codingView(w, admin).members).toContainEqual({
    id: "101",
    active: true,
    username: "maintainer",
  });
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
