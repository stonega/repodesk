import { expect, test } from "bun:test";
import { workflowSchema } from "../../src/domain.ts";
import { nextOccurrences } from "../../src/workflows/schedule.ts";
import { activateWorkflow, tick } from "../../src/workflows/service.ts";
import { workspace } from "../fixtures.ts";

test("nextOccurrences handles once, weekdays, monthly (including last), and interval with quiet hours", () => {
  const after = new Date("2026-11-20T09:00:00.000Z"); // Friday

  // One-shot future vs past
  expect(
    nextOccurrences(
      {
        frequency: "once",
        runAt: "2026-11-20T12:30:00.000Z",
        timezone: "UTC",
      },
      after,
    ),
  ).toEqual(["2026-11-20T12:30:00Z"]);
  expect(
    nextOccurrences(
      {
        frequency: "once",
        runAt: "2026-11-20T08:00:00.000Z",
        timezone: "UTC",
      },
      after,
    ),
  ).toEqual([]);

  // Weekdays skips Saturday (Nov 21) and Sunday (Nov 22)
  const weekdays = nextOccurrences(
    { frequency: "weekdays", hour: 10, minute: 0, timezone: "UTC" },
    after,
    3,
  );
  expect(weekdays).toEqual([
    "2026-11-20T10:00:00Z",
    "2026-11-23T10:00:00Z",
    "2026-11-24T10:00:00Z",
  ]);

  // Monthly "last" resolves Nov 30, Dec 31, Jan 31, Feb 28
  const monthlyLast = nextOccurrences(
    {
      frequency: "monthly",
      dayOfMonth: "last",
      hour: 9,
      minute: 0,
      timezone: "UTC",
    },
    after,
    4,
  );
  expect(monthlyLast).toEqual([
    "2026-11-30T09:00:00Z",
    "2026-12-31T09:00:00Z",
    "2027-01-31T09:00:00Z",
    "2027-02-28T09:00:00Z",
  ]);

  // Interval every 60 minutes with quiet hours 22:00-07:00 UTC
  const interval = nextOccurrences(
    {
      frequency: "interval",
      intervalMinutes: 60,
      quietStartHour: 22,
      quietEndHour: 7,
      timezone: "UTC",
    },
    new Date("2026-11-20T20:30:00.000Z"),
    3,
  );
  expect(interval).toEqual([
    "2026-11-20T21:30:00Z",
    "2026-11-21T07:30:00Z",
    "2026-11-21T08:30:00Z",
  ]);
});

test("one-shot workflow fires once in tick() and transitions to completed", () => {
  const w = workspace();
  const runAt = new Date(Date.now() + 60_000).toISOString();
  const { workflow } = activateWorkflow(
    w,
    "101",
    workflowSchema.parse({
      name: "Check PR CI once",
      task: "Check CI status on PR #42",
      chatId: "101",
      topicId: 0,
      recurrence: { frequency: "once", runAt, timezone: "UTC" },
      deliveryMode: "on_condition",
    }),
  );
  expect(workflow.status).toBe("active");
  expect(workflow.nextAt).toBeTruthy();

  // Fire right after due time
  tick(w, "gpt-4.1-mini", new Date(Date.parse(runAt) + 5_000));
  expect(workflow.status).toBe("completed");
  expect(workflow.nextAt).toBeUndefined();
  expect(w.runs.some((r) => r.workflowId === workflow.id)).toBe(true);
});

test("event-triggered workflow remains active without nextAt and is skipped by cron tick()", () => {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 10,
    repositories: [
      {
        id: 100,
        full_name: "acme/app",
        default_branch: "main",
        private: false,
      },
    ],
  };
  const { workflow } = activateWorkflow(
    w,
    "101",
    workflowSchema.parse({
      name: "CI Failure Watcher",
      task: "Analyze failed CI on main",
      chatId: "101",
      topicId: 0,
      recurrence: { frequency: "daily", hour: 9, minute: 0, timezone: "UTC" },
      trigger: {
        kind: "github_event",
        event: "check_suite_failed",
        branch: "main",
        cooldownMinutes: 15,
      },
      deliveryMode: "on_condition",
      watcherAction: "investigate_readonly",
      github: { revision: 1, repositoryIds: [100] },
    }),
  );
  expect(workflow.status).toBe("active");
  expect(workflow.nextAt).toBeUndefined();

  tick(w, "gpt-4.1-mini", new Date("2026-11-21T09:00:05.000Z"));
  expect(w.runs.filter((r) => r.workflowId === workflow.id)).toHaveLength(0);
});
