import { expect, test } from "bun:test";
import {
  configureRepositoryTasks,
  objectiveAllowed,
  releaseFlagAuthorized,
  releaseInstruction,
  releaseVersionAuthorized,
  versionMentioned,
} from "../../src/coding/objective.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

test.each([
  "Release example/workspace v1.2.0",
  "Please publish v1.2.0",
  "发布 v1.2.0",
  "请给仓库 A 发布 v1.2.0",
])("explicit release intent: %s", (text) =>
  expect(releaseInstruction(text)).toBe(true),
);
test.each([
  "Explain how to release v1.2.0",
  "Don't release v1.2.0",
  "The docs say release v1.2.0",
  "请解释如何发布 v1.2.0",
  "不要发布 v1.2.0",
  "Release notes for v1.2.0",
])("reference/negative intent: %s", (text) =>
  expect(releaseInstruction(text)).toBe(false),
);
test("version authorization matches a whole version", () => {
  expect(versionMentioned("Release v1.2.0", "1.2.0")).toBe(true);
  expect(versionMentioned("Release v11.2.0", "1.2.0")).toBe(false);
  expect(versionMentioned("Release v1.2.0-beta", "1.2.0")).toBe(false);
});
test("the latest version decision and directive fence older release authority", () => {
  const first = { revision: 1, text: "Release v1.2.0" };
  const next = [first, { revision: 2, text: "Release v2.0.0" }];
  expect(releaseVersionAuthorized(next, "v1.2.0")).toBe(false);
  expect(releaseVersionAuthorized(next, "v2.0.0")).toBe(true);
  expect(
    releaseVersionAuthorized(
      [first, { revision: 2, text: "Prepare release v1.2.0" }],
      "v1.2.0",
    ),
  ).toBe(false);
  expect(
    releaseVersionAuthorized(
      [
        { revision: 1, text: "Release this repository" },
        { revision: 2, text: "v1.2.0" },
      ],
      "v1.2.0",
    ),
  ).toBe(true);
  expect(
    releaseVersionAuthorized(
      [{ revision: 1, text: "Release v1.2.0 or v2.0.0" }],
      "v1.2.0",
    ),
  ).toBe(false);
});
test("release flags require current release evidence rather than old draft-PR instructions", () => {
  const old = { revision: 1, text: "Fix this and open a draft PR" };
  const current = { revision: 2, text: "Release v1.2.0" };
  expect(releaseFlagAuthorized([old, current], "draft", "v1.2.0")).toBe(false);
  expect(
    releaseFlagAuthorized(
      [old, { ...current, text: "Release v1.2.0 as a draft" }],
      "draft",
      "v1.2.0",
    ),
  ).toBe(true);
  expect(
    releaseFlagAuthorized(
      [{ ...current, text: "Release v1.2.0, not a draft" }],
      "draft",
      "v1.2.0",
    ),
  ).toBe(false);
  expect(releaseFlagAuthorized([current], "prerelease", "v1.2.0")).toBe(false);
  expect(
    releaseFlagAuthorized(
      [{ ...current, text: "Release v1.2.0-beta" }],
      "prerelease",
      "v1.2.0-beta",
    ),
  ).toBe(true);
});
test("selected repository objectives default enabled; explicit overrides remain local and grant no task authority", () => {
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
  expect(() => objectiveAllowed(w, 7001, { kind: "release" })).not.toThrow();
  expect(() =>
    objectiveAllowed(w, 7001, { kind: "investigation" }),
  ).not.toThrow();
  const disabled = JSON.parse(JSON.stringify(w));
  disabled.repositoryTasks = {
    revision: 1,
    repositories: [
      { repositoryId: 7001, investigation: false, release: false },
    ],
  };
  expect(() => objectiveAllowed(disabled, 7001, { kind: "release" })).toThrow(
    "coding_objective_disabled",
  );
  expect(() =>
    objectiveAllowed(disabled, 7001, { kind: "investigation" }),
  ).toThrow("coding_objective_disabled");
  const run = createRun(
    w,
    "101",
    "Configure repository tasks: example/workspace investigation=true release=true",
    "101",
    0,
    "gpt-4.1-mini",
    { botId: "999" },
  );
  const source = w.messages.find((s) => s.runId === run.id);
  const args = {
    sourceId: source?.id ?? "",
    repositoryId: 7001,
    investigation: true,
    release: true,
  };
  configureRepositoryTasks(w, run, args);
  expect(() => objectiveAllowed(w, 7001, { kind: "release" })).not.toThrow();
  expect(() => objectiveAllowed(w, 7002, { kind: "release" })).toThrow(
    "coding_objective_disabled",
  );
  expect(configureRepositoryTasks(w, run, args)?.revision).toBe(1);
  if (w.repositoryTasks)
    w.repositoryTasks.repositories = [
      { release: true, investigation: true, repositoryId: 7001 },
    ];
  expect(configureRepositoryTasks(w, run, args)?.revision).toBe(1);
  expect(() =>
    configureRepositoryTasks(w, run, { ...args, release: false }),
  ).toThrow("coding_settings_request_required");
});
