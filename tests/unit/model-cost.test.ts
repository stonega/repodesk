import { expect, test } from "bun:test";
import { queryModelCost } from "../../src/agent/model-cost.ts";
import { applicationTools } from "../../src/agent/tools.ts";
import type { Store } from "../../src/db/repositories.ts";
import type { Run, Workspace } from "../../src/domain.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const now = new Date("2026-09-20T12:00:00Z");
function fixture(actor = "202") {
  const w = workspace();
  const run = createRun(
    w,
    actor,
    "What have I spent?",
    actor,
    0,
    "gpt-4.1-mini",
  );
  run.status = "running";
  return { w, run };
}
function attempt(patch: Partial<Run["attempts"][number]> = {}) {
  return {
    id: crypto.randomUUID(),
    status: "settled" as const,
    reserved: 10,
    actual: 1,
    at: "2026-09-20T00:00:00Z",
    ...patch,
  };
}
function tool(w: Workspace, run: Run, workspaceId = w.id) {
  const store = {
    change: async (id: string, action: (w: Workspace) => unknown) => {
      if (id !== w.id) throw new Error("not_found");
      return action(w);
    },
  } as Store;
  const found = applicationTools(store, workspaceId, run.id, run.fence).find(
    (t) => t.name === "query_model_cost",
  );
  if (!found) throw new Error("missing cost tool");
  return found;
}

test("cost totals distinguish zero actuals, outstanding reservations and unknowns, grouped by model", () => {
  const { w, run } = fixture();
  run.attempts = [
    attempt(),
    attempt({ actual: 0 }),
    attempt({ status: "reserved", actual: undefined, reserved: 2 }),
    attempt({ status: "unknown", actual: undefined, reserved: 3 }),
  ];
  const otherModel = createRun(w, run.actor, "hello", run.actor, 0, "custom");
  otherModel.attempts = [attempt({ actual: 4 })];
  const otherActor = createRun(
    w,
    "101",
    "private task",
    "101",
    0,
    "secret-model",
  );
  otherActor.attempts = [attempt({ actual: 999 })];
  const result = queryModelCost(w, run, {}, now);
  expect(result.totals).toEqual({
    calls: 5,
    settledCalls: 3,
    reservedCalls: 1,
    unknownCalls: 1,
    settledUsd: 5,
    reservedUsd: 2,
    unknownUsd: 3,
    accountedUsd: 10,
  });
  expect(result.byModel.map((m) => m.model)).toEqual([
    "custom",
    "gpt-4.1-mini",
  ]);
  expect(result).not.toHaveProperty("monthlyBudget");
  expect(JSON.stringify(result)).not.toContain("secret-model");
  expect(JSON.stringify(result)).not.toContain("private task");
});

test("periods use attempt timestamps and UTC boundaries, excluding future records", () => {
  const { w, run } = fixture();
  run.attempts = [
    attempt({ at: "2026-08-31T23:59:59Z", actual: 8 }),
    attempt({ at: "2026-09-01T00:00:00Z", actual: 4 }),
    attempt({ at: "2026-09-19T23:59:59Z", actual: 2 }),
    attempt(),
    attempt({ at: "2026-09-21T00:00:00Z", actual: 100 }),
  ];
  expect(
    queryModelCost(w, run, { period: "today" }, now).totals.settledUsd,
  ).toBe(1);
  expect(queryModelCost(w, run, {}, now).totals.settledUsd).toBe(7);
  expect(
    queryModelCost(w, run, { period: "retained" }, now).totals.settledUsd,
  ).toBe(15);
});

test("workspace admins see aggregate costs and this month's budget independently of selected period", () => {
  const { w, run } = fixture("303");
  w.settings.monthlyBudgetUsd = 50;
  const member = createRun(w, "202", "private", "202", 0, "custom");
  member.attempts = [
    attempt({ actual: 3 }),
    attempt({ at: "2026-08-31T23:59:59Z", actual: 7 }),
  ];
  const result = queryModelCost(
    w,
    run,
    { scope: "workspace", period: "retained" },
    now,
  );
  expect(result.totals.settledUsd).toBe(10);
  expect(result.monthlyBudget).toEqual({
    limitUsd: 50,
    accountedUsd: 3,
    remainingUsd: 47,
  });
  expect(JSON.stringify(result)).not.toContain(member.id);
});

test("empty history is explicit and forged scopes and identity filters are rejected", () => {
  const { w, run } = fixture();
  expect(queryModelCost(w, run, {}, now).totals.calls).toBe(0);
  expect(queryModelCost(w, run, {}, now).byModel).toEqual([]);
  for (const args of [
    { scope: "workspace" },
    { scope: "all" },
    { actor: "101" },
    { workspaceId: "other" },
    { period: "year" },
  ])
    expect(() => queryModelCost(w, run, args, now)).toThrow();
  run.chatId = "-100100";
  expect(() => queryModelCost(w, run, {}, now)).toThrow(
    "model_cost_requires_private_chat",
  );
});

test("tool replay returns the durable snapshot and rechecks admin permissions", async () => {
  const { w, run } = fixture("303");
  const t = tool(w, run);
  const first = await t.execute("cost-call", { scope: "workspace" });
  run.attempts.push(attempt());
  expect(await t.execute("cost-call", { scope: "workspace" })).toEqual(first);
  const member = w.members.find((m) => m.id === run.actor);
  if (!member) throw new Error("missing member");
  member.role = "member";
  await expect(t.execute("cost-call", { scope: "workspace" })).rejects.toThrow(
    "access_denied",
  );
  await expect(t.execute("cost-call", { scope: "self" })).rejects.toThrow(
    "tool_call_conflict",
  );
});

test("cost tools enforce grants, current run policy, cancellation, fencing and tenant binding", async () => {
  const mutations: ((w: Workspace, run: Run) => void)[] = [
    (w) => {
      w.members.forEach((member) => {
        member.active = false;
      });
    },
    (w) => {
      w.settings.paused = true;
    },
    (_w, r) => {
      r.cancelled = true;
    },
    (_w, r) => {
      r.fence++;
    },
    (_w, r) => {
      r.status = "succeeded";
    },
    (w) => {
      for (const skill of w.skills)
        for (const version of skill.published)
          version.tools = version.tools.filter(
            (name) => name !== "query_model_cost",
          );
    },
  ];
  for (const mutate of mutations) {
    const { w, run } = fixture();
    const t = tool(w, run);
    await t.execute("existing", {});
    mutate(w, run);
    await expect(t.execute("existing", {})).rejects.toThrow();
  }
  const { w, run } = fixture();
  await expect(
    tool(w, run, "another-workspace").execute("cross-tenant", {}),
  ).rejects.toThrow("not_found");
  await expect(
    tool(w, run).execute("aborted", {}, AbortSignal.abort()),
  ).rejects.toThrow();
});
