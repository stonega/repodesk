import { expect, test } from "bun:test";
import {
  autonomyView,
  effectiveAutonomyMode,
  evaluateAutonomy,
  isDestructiveCloudflareAction,
  updateRepositoryAutonomy,
  updateWorkspaceAutonomy,
} from "../../src/autonomy/policy.ts";
import { workspace } from "../fixtures.ts";

test("default workspace autonomy is supervised and gates L1/L2 + L3 writes while allowing L0 reads", () => {
  const w = workspace();
  expect(effectiveAutonomyMode(w)).toBe("supervised");
  expect(effectiveAutonomyMode(w, 100)).toBe("supervised");

  expect(evaluateAutonomy(w, "read_query").allowedAutomatic).toBe(true);
  expect(evaluateAutonomy(w, "research_subagent").allowedAutomatic).toBe(true);
  expect(evaluateAutonomy(w, "mission_followup_timer").allowedAutomatic).toBe(
    true,
  );
  expect(evaluateAutonomy(w, "codex_investigation").allowedAutomatic).toBe(
    true,
  );

  expect(evaluateAutonomy(w, "github_issue_write", 100).requiresApproval).toBe(
    true,
  );
  expect(evaluateAutonomy(w, "github_pr_create", 100).requiresApproval).toBe(
    true,
  );
  expect(evaluateAutonomy(w, "obsidian_note_write").requiresApproval).toBe(
    true,
  );
  expect(
    evaluateAutonomy(w, "cloudflare_non_destructive_write").requiresApproval,
  ).toBe(true);

  expect(evaluateAutonomy(w, "github_pr_merge", 100).requiresApproval).toBe(
    true,
  );
  expect(
    evaluateAutonomy(w, "github_release_publish", 100).requiresApproval,
  ).toBe(true);
});

test("check_in enables routine non-destructive L1/L2 writes but ALWAYS gates L3 high-impact actions", () => {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 10,
    repositories: [
      { id: 100, full_name: "acme/app", default_branch: "main", private: true },
      {
        id: 200,
        full_name: "acme/prod-infra",
        default_branch: "main",
        private: true,
      },
    ],
  };

  updateWorkspaceAutonomy(w, "101", { revision: 0, defaultMode: "check_in" });
  expect(effectiveAutonomyMode(w)).toBe("check_in");
  expect(effectiveAutonomyMode(w, 100)).toBe("check_in");

  // Override prod-infra back to supervised
  updateRepositoryAutonomy(w, "101", 200, { revision: 1, mode: "supervised" });
  expect(effectiveAutonomyMode(w, 100)).toBe("check_in");
  expect(effectiveAutonomyMode(w, 200)).toBe("supervised");

  // L1/L2 automatic on acme/app (check_in), gated on acme/prod-infra (supervised)
  expect(evaluateAutonomy(w, "github_issue_write", 100).allowedAutomatic).toBe(
    true,
  );
  expect(evaluateAutonomy(w, "github_pr_create", 100).allowedAutomatic).toBe(
    true,
  );
  expect(evaluateAutonomy(w, "obsidian_note_write").allowedAutomatic).toBe(
    true,
  );
  expect(
    evaluateAutonomy(w, "cloudflare_non_destructive_write").allowedAutomatic,
  ).toBe(true);

  expect(evaluateAutonomy(w, "github_issue_write", 200).allowedAutomatic).toBe(
    false,
  );
  expect(evaluateAutonomy(w, "github_pr_create", 200).requiresApproval).toBe(
    true,
  );

  // L3 immutable hard gates NEVER become automatic even under check_in
  for (const action of [
    "github_pr_merge",
    "github_pr_close",
    "github_release_publish",
    "cloudflare_destructive_write",
    "obsidian_permanent_delete",
    "workspace_delete",
    "permission_or_autonomy_change",
  ] as const) {
    const decision = evaluateAutonomy(w, action, 100);
    expect(decision.actionClass).toBe("L3");
    expect(decision.allowedAutomatic).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toBe("autonomy_l3_approval_required");
  }

  // Destructive cloudflare classification
  expect(isDestructiveCloudflareAction("dns_delete")).toBe(true);
  expect(isDestructiveCloudflareAction("dns_create")).toBe(false);
  expect(isDestructiveCloudflareAction("purge_cache")).toBe(false);

  // Optimistic revision check rejects stale writes
  expect(() =>
    updateWorkspaceAutonomy(w, "101", {
      revision: 0,
      defaultMode: "supervised",
    }),
  ).toThrow("version_conflict");

  const view = autonomyView(w);
  expect(view.revision).toBe(2);
  expect(view.defaultMode).toBe("check_in");
  expect(view.repositories).toEqual([
    {
      id: 100,
      full_name: "acme/app",
      override: "inherit",
      effectiveMode: "check_in",
    },
    {
      id: 200,
      full_name: "acme/prod-infra",
      override: "supervised",
      effectiveMode: "supervised",
    },
  ]);
});
