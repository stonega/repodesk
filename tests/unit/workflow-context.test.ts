import { expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { Workflow, Workspace } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { spec, workspace } from "../fixtures.ts";

function saved(w: Workspace, id: string, overrides: Partial<Workflow> = {}) {
  const workflow: Workflow = {
    id,
    version: 1,
    owner: "101",
    status: "active",
    spec: spec(w),
    versions: [],
    ...overrides,
  };
  w.workflows.push(workflow);
  return workflow;
}

test("schedule context includes comparison details for every non-deleted workflow state", () => {
  const w = workspace();
  const states = ["draft", "active", "paused", "suspended"] as const;
  for (const status of states)
    saved(w, status, {
      status,
      spec: {
        ...spec(w),
        name: `${status} report`,
        task: "Report waiting pull requests.",
        format: "Include repository links.",
        windowDays: 3,
        github: { revision: 2, repositoryIds: [42] },
      },
      versions: [
        { version: 1, spec: { ...spec(w), task: "Old instructions" } },
      ],
    });
  saved(w, "deleted", { status: "deleted" });
  const run = createRun(
    w,
    "101",
    "Schedule a weekly pull request report.",
    "-100100",
    0,
    "gpt-4.1-mini",
  );
  const { prompt } = buildContext(w, run);
  const existing = JSON.parse(prompt).existingWorkflows;
  expect(existing.map((f: Workflow) => f.status)).toEqual(states);
  expect(existing[0]).toEqual({
    id: "draft",
    status: "draft",
    spec: w.workflows[0]?.spec,
  });
  expect(prompt).not.toContain("Old instructions");
});

test("private schedule comparison excludes other owners, destinations, topics and workspaces", () => {
  const w = workspace();
  const own = { ...spec(w), chatId: "101", topicId: 10 };
  saved(w, "own", { spec: own });
  saved(w, "other-owner", { owner: "202", spec: own });
  saved(w, "other-private", { owner: "202", spec: { ...own, chatId: "202" } });
  saved(w, "other-topic", { spec: { ...own, topicId: 11 } });
  saved(w, "group", { spec: { ...own, chatId: "-100100" } });
  saved(workspace(), "another-workspace", { spec: own });
  const run = createRun(
    w,
    "101",
    "Schedule a recap.",
    "101",
    10,
    "gpt-4.1-mini",
  );
  expect(JSON.parse(buildContext(w, run).prompt).existingWorkflows).toEqual([
    { id: "own", status: "active", spec: own },
  ]);
});

test("group comparison includes teammates in the same topic and refreshes changed records", () => {
  const w = workspace();
  const shared = { ...spec(w), topicId: 10 };
  const own = saved(w, "own", { spec: shared });
  const teammate = saved(w, "teammate", { owner: "202", spec: shared });
  saved(w, "another-topic", { spec: spec(w) });
  saved(w, "another-group", { spec: { ...shared, chatId: "-100200" } });
  saved(w, "private", { spec: { ...shared, chatId: "101" } });
  const run = createRun(
    w,
    "101",
    "Add the weekly recap.",
    "-100100",
    10,
    "gpt-4.1-mini",
  );
  const context = () =>
    JSON.parse(buildContext(w, run).prompt).existingWorkflows;
  expect(context().map((f: Workflow) => f.id)).toEqual(["own", "teammate"]);
  own.status = "deleted";
  teammate.status = "paused";
  expect(context()).toEqual([
    { id: "teammate", status: "paused", spec: shared },
  ]);
  teammate.status = "deleted";
  expect(context()).toEqual([]);
});
