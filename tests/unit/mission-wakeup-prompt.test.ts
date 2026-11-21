import { describe, expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { MissionWait } from "../../src/orchestration/types.ts";
import {
  buildWakeupTaskPrompt,
  MAX_WAKEUP_TASK_CHARS,
} from "../../src/orchestration/wakeup.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

describe("Mission prompt guidance and bounded wakeup prompts", () => {
  test("interactive prompt includes mission orchestration tools and wakeup prompt documents silent continuation", () => {
    const w = workspace();
    const interactive = createRun(
      w,
      "101",
      "Kick off multi-repo work",
      "101",
      0,
      "gpt-4.1-mini",
    );
    const { system: interactiveSystem } = buildContext(w, interactive);
    expect(interactiveSystem).toContain("manage_mission");
    expect(interactiveSystem).toContain("schedule_mission_followup");
    expect(interactiveSystem).toContain("inspect_missions");
    expect(interactiveSystem).not.toContain("## Mission Continuation");

    const wakeup = createRun(
      w,
      "101",
      "Continue background Mission m-1.",
      "101",
      0,
      "gpt-4.1-mini",
    );
    wakeup.triggerKind = "mission_wakeup";
    const { system: wakeupSystem } = buildContext(w, wakeup);
    expect(wakeupSystem).toContain("## Mission Continuation");
    expect(wakeupSystem).toContain("continue_silently");
  });

  test("buildWakeupTaskPrompt stays strictly under 4000 chars even with large multi-wait fan-out payloads", () => {
    const longGoal = `${"Ship coordinated release across repositories. ".repeat(44)}😀`;
    const waits: MissionWait[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `wait-${idx + 1}`,
      workspaceId: "ws-1",
      missionId: "mission-1",
      joinGroup: "jg-1",
      joinMode: "all",
      kind: "coding_task",
      targetId: `task-${idx + 1}`,
      status: idx === 11 ? "failed" : "satisfied",
      reason: `Cross-repo task ${idx + 1}: ${"details ".repeat(40)}`,
      result: {
        summary: `Completed step ${idx + 1}: ${"verified output ".repeat(120)}`,
        largeData: "x".repeat(5000),
      },
      createdAt: "2026-11-21T00:00:00.000Z",
      resolvedAt: "2026-11-21T00:05:00.000Z",
    }));

    const prompt = buildWakeupTaskPrompt(
      { id: "mission-1", goal: longGoal },
      waits,
    );
    expect(prompt.length).toBeLessThanOrEqual(MAX_WAKEUP_TASK_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain("mission-1");
    expect(prompt).toContain("continue_silently");
    expect(prompt).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
