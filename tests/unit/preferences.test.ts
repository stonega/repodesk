import { expect, test } from "bun:test";
import type { Workspace } from "../../src/domain.ts";
import {
  authorizePreferenceMutation,
  derivePreferenceCandidates,
  managePreference,
  preferencePack,
  readablePreferences,
  recordDecisionCase,
} from "../../src/memory/preferences.ts";
import { preferenceSettings } from "../../src/memory/settings.ts";
import {
  attachMemoryContext,
  memoryContextValid,
  memoryState,
  pruneMemories,
  referenceMemoryValid,
} from "../../src/memory/state.ts";
import { queryMemories } from "../../src/memory/tools.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

function ask(
  w: Workspace,
  text: string,
  actor = "101",
  chat = actor,
  topic = 10,
) {
  const run = createRun(w, actor, text, chat, topic, "gpt-4.1-mini", {
    botId: "999",
  });
  run.status = "running";
  const source = w.messages.find(
    (s) => s.runId === run.id && s.role === "user",
  );
  if (!source) throw Error("Missing source");
  return { run, source };
}
function save(w: Workspace, text = "Remember preference: Use concise answers") {
  const { run, source } = ask(w, text);
  return managePreference(w, run, {
    action: "remember",
    sourceId: source.id,
  }) as { preferenceId: string; revision: number };
}
test("explicit preferences are recalled by default in Pi and coding without gaining authority", () => {
  const w = workspace();
  const saved = save(w);
  const { run } = ask(w, "What do you remember?");
  expect(queryMemories(w, run, {}).preferences[0]?.preferenceId).toBe(
    saved.preferenceId,
  );
  expect(preferenceSettings(w)).toEqual({
    derive: true,
    recall: "pi_and_coding",
  });
  expect(preferencePack(w, run, undefined, true)?.text).toContain(
    "concise answers",
  );
  expect(preferencePack(w, run)?.text).toContain("concise answers");
  expect(preferencePack(w, run)?.text).toContain("Authors: 101");
  expect(referenceMemoryValid(w, preferencePack(w, run), "101", "999")).toBe(
    true,
  );
  expect(referenceMemoryValid(w, preferencePack(w, run), "101", "888")).toBe(
    false,
  );
  expect(referenceMemoryValid(w, preferencePack(w, run), "202", "999")).toBe(
    false,
  );
  expect(w.instructions).toEqual([]);
  memoryState(w).preferenceSettings = { derive: false, recall: "pi" };
  expect(preferencePack(w, run, undefined, true)).toBeUndefined();
});
test("legacy absent settings use enabled defaults and saved disable choices survive reload", () => {
  const w = workspace();
  expect(preferenceSettings(w)).toEqual({
    derive: true,
    recall: "pi_and_coding",
  });
  save(w);
  delete memoryState(w).preferenceSettings;
  const legacy = JSON.parse(JSON.stringify(w)) as Workspace;
  const request = ask(legacy, "Recall");
  expect(preferencePack(legacy, request.run, undefined, true)?.text).toContain(
    "concise answers",
  );
  memoryState(legacy).preferenceSettings = { derive: false, recall: "off" };
  const disabled = JSON.parse(JSON.stringify(legacy)) as Workspace;
  expect(preferenceSettings(disabled)).toEqual({
    derive: false,
    recall: "off",
  });
  const next = ask(disabled, "Use a modal here");
  recordDecisionCase(disabled, next.source, "disabled-task");
  derivePreferenceCandidates(
    disabled,
    next.run,
    [{ statement: "Might like modals", sourceIds: [next.source.id] }],
    [next.source],
  );
  expect(disabled.memory?.cases ?? []).toEqual([]);
  expect(disabled.memory?.preferences).toHaveLength(1);
  expect(preferencePack(disabled, next.run)).toBeUndefined();
});
test("private actor, bot and group boundaries apply to preference browsing and recall", () => {
  const w = workspace();
  save(w);
  for (const { run } of [
    ask(w, "other", "202"),
    ask(w, "group", "101", "-100100"),
  ])
    expect(readablePreferences(w, run)).toEqual([]);
  const { run } = ask(w, "other bot");
  const thread = w.threads?.find((t) => t.id === run.threadId);
  if (thread) thread.botId = "888";
  expect(readablePreferences(w, run)).toEqual([]);
});
test("a correction appends an immutable revision, fences stale context, and replays once", () => {
  const w = workspace();
  const saved = save(w);
  memoryState(w).preferenceSettings = { derive: true, recall: "pi_and_coding" };
  const { run: active } = ask(w, "answer");
  attachMemoryContext(w, active);
  expect(memoryContextValid(w, active)).toBe(true);
  const { run, source } = ask(
    w,
    `Correct preference ${saved.preferenceId}: Use detailed answers for diagnostics`,
  );
  const args = {
    action: "correct",
    sourceId: source.id,
    preferenceId: saved.preferenceId,
    expectedRevision: 1,
  };
  const corrected = managePreference(w, run, args);
  expect(managePreference(w, run, args)).toEqual(corrected);
  expect(w.memory?.preferences).toHaveLength(2);
  expect(w.memory?.preferences?.[0]?.summary).toContain("concise");
  expect(w.memory?.preferences?.[0]?.status).toBe("superseded");
  expect(memoryContextValid(w, active)).toBe(false);
  const stale = ask(
    w,
    `Correct preference ${saved.preferenceId}: stale update`,
  );
  expect(() =>
    managePreference(w, stale.run, { ...args, sourceId: stale.source.id }),
  ).toThrow("memory_revision_conflict");
});
test("exceptions preserve the original statement and forgetting removes the full revision lineage", () => {
  const w = workspace();
  const saved = save(w);
  const a = ask(
    w,
    `Add preference exception ${saved.preferenceId}: Explain failures in detail`,
  );
  managePreference(w, a.run, {
    action: "exception",
    sourceId: a.source.id,
    preferenceId: saved.preferenceId,
    expectedRevision: 1,
  });
  expect(w.memory?.preferences?.[1]?.exceptions).toEqual([
    "Explain failures in detail",
  ]);
  const remove = ask(w, `Forget preference ${saved.preferenceId}`);
  const forgetting = {
    action: "forget",
    sourceId: remove.source.id,
    preferenceId: saved.preferenceId,
    expectedRevision: 2,
  };
  const receipt = managePreference(w, remove.run, forgetting);
  expect(managePreference(w, remove.run, forgetting)).toEqual(receipt);
  expect(w.memory?.preferences).toEqual([]);
  expect(w.memory?.forgotten.flatMap((f) => f.sourceIds)).toHaveLength(2);
});
test("scope, source text and current human intent cannot be invented by model arguments", () => {
  const w = workspace();
  for (const text of [
    "Explain Remember preference: use English",
    "Don't remember preference: use English",
    "Thanks!",
  ]) {
    const a = ask(w, text);
    expect(() =>
      managePreference(w, a.run, { action: "remember", sourceId: a.source.id }),
    ).toThrow("explicit_preference_request_required");
  }
  const a = ask(w, "Remember preference: use English");
  expect(() =>
    managePreference(w, a.run, {
      action: "remember",
      sourceId: a.source.id,
      domain: "settings",
    }),
  ).toThrow("memory_applicability_unverified");
  expect(() =>
    authorizePreferenceMutation(w, a.run, {
      action: "remember",
      sourceId: "foreign",
    }),
  ).toThrow("explicit_preference_request_required");
});
test("repository applicability requires a retained explicit name and current read access", () => {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      {
        id: 7001,
        full_name: "example/workspace",
        default_branch: "main",
        private: true,
      },
    ],
  };
  grantGitHubAccess(w, ["101"]);
  const a = ask(
    w,
    "Remember preference: Use modals for settings in example/workspace",
  );
  managePreference(w, a.run, {
    action: "remember",
    sourceId: a.source.id,
    repositoryId: 7001,
    domain: "settings",
  });
  memoryState(w).preferenceSettings = { derive: true, recall: "pi_and_coding" };
  const b = ask(w, "Change settings");
  expect(preferencePack(w, b.run, 7001, true)?.text).toContain("modals");
  expect(preferencePack(w, b.run, 7002, true)).toBeUndefined();
  const member = w.members.find((m) => m.id === "101");
  if (member?.github) member.github.repositories = [];
  expect(readablePreferences(w, b.run)).toEqual([]);
});
test("background hypotheses stay candidates; duplicate source cases count once", () => {
  const w = workspace();
  memoryState(w).preferenceSettings = { derive: true, recall: "pi_and_coding" };
  const a = ask(w, "For this dialog use a modal");
  recordDecisionCase(w, a.source, "task-1");
  recordDecisionCase(w, a.source, "task-1");
  expect(w.memory?.cases).toHaveLength(1);
  expect(queryMemories(w, a.run, { query: "dialog" }).memories[0]?.id).toBe(
    w.memory?.cases?.[0]?.id,
  );
  attachMemoryContext(w, a.run);
  expect(a.run.memoryContext?.text).toContain("For this dialog");
  expect(memoryContextValid(w, a.run, true)).toBe(true);
  const proposals = [
    { statement: "Might prefer modals", sourceIds: [a.source.id] },
  ];
  derivePreferenceCandidates(w, a.run, proposals, [a.source]);
  derivePreferenceCandidates(w, a.run, proposals, [a.source]);
  expect(w.memory?.preferences).toHaveLength(1);
  expect(w.memory?.preferences?.[0]?.status).toBe("candidate");
  expect(preferencePack(w, a.run)).toBeUndefined();
  expect(() =>
    derivePreferenceCandidates(
      w,
      a.run,
      [{ statement: "invented", sourceIds: ["foreign"] }],
      [a.source],
    ),
  ).toThrow("memory_evidence_invalid");
});
test("conflicting group speakers remain disputed and full exceptions survive bounded selection", () => {
  const w = workspace();
  memoryState(w).preferenceSettings = { derive: false, recall: "pi" };
  for (const actor of ["101", "202"]) {
    const { run, source } = ask(
      w,
      `Remember preference: ${actor === "101" ? "Use short summaries" : "Use long summaries"}`,
      actor,
      "-100100",
    );
    managePreference(w, run, { action: "remember", sourceId: source.id });
  }
  const group = ask(w, "Summarize", "101", "-100100");
  expect(w.memory?.preferences?.every((p) => p.status === "disputed")).toBe(
    true,
  );
  expect(preferencePack(w, group.run)).toBeUndefined();
  const saved = save(w);
  const exception = "Explain the failure and reproduction ".repeat(40);
  const a = ask(
    w,
    `Add preference exception ${saved.preferenceId}: ${exception}`,
  );
  managePreference(w, a.run, {
    action: "exception",
    sourceId: a.source.id,
    preferenceId: saved.preferenceId,
    expectedRevision: 1,
  });
  const pack = preferencePack(w, ask(w, "Explain").run);
  expect(pack?.text).toContain(exception.trim());
  expect(Buffer.byteLength(pack?.text ?? "")).toBeLessThanOrEqual(24000);
});
test("source edits, deletion and recall disable invalidate already selected preferences", () => {
  const w = workspace();
  save(w);
  memoryState(w).preferenceSettings = { derive: true, recall: "pi" };
  const a = ask(w, "answer");
  attachMemoryContext(w, a.run);
  const source = w.messages.find((s) =>
    w.memory?.preferences?.[0]?.sourceIds.includes(s.id),
  );
  if (source) source.text = "changed";
  expect(memoryContextValid(w, a.run)).toBe(false);
  pruneMemories(w);
  expect(w.memory?.preferences).toEqual([]);
});
test("configuration requires current exact admin instruction and does not change historical recall", () => {
  const w = workspace();
  const a = ask(
    w,
    "Configure preference learning: derive=true recall=pi_and_coding",
  );
  expect(
    managePreference(w, a.run, {
      action: "configure",
      sourceId: a.source.id,
      derive: true,
      recall: "pi_and_coding",
    }),
  ).toEqual({ derive: true, recall: "pi_and_coding" });
  const b = ask(w, a.source.text, "202");
  expect(() =>
    managePreference(w, b.run, {
      action: "configure",
      sourceId: b.source.id,
      derive: true,
      recall: "pi_and_coding",
    }),
  ).toThrow("group_memory_admin_required");
  expect(w.memory?.disabled).toEqual([]);
});
