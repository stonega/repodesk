import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { codingFailureMessage } from "../../src/coding/failure-messages.ts";
import { codingStatusLabel, runnerStage } from "../../src/coding/feedback.ts";
import {
  clearProgress,
  type Progress,
  queuedRunFeedback,
  recordProgress,
} from "../../src/telegram/feedback.ts";
import {
  requestFailureMessage,
  runStatus,
} from "../../src/telegram/messages.ts";
import {
  cancelRun,
  confirmRunStopped,
  createRun,
} from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function task() {
  return {
    id: randomUUID(),
    actor: "101",
    chatId: "101",
    topicId: 3,
    progress: undefined as Progress | undefined,
  };
}

test("progress persists deduplication and coalesces rapid phases without a false milestone", () => {
  const w = workspace(),
    t = task();
  recordProgress(w, t, "development", "prepare", "1", 10000);
  recordProgress(w, t, "development", "prepare", "1", 11000);
  expect(w.deliveries).toHaveLength(1);
  recordProgress(w, t, "development", "setup", "1", 12000);
  expect(w.deliveries[0]?.state).toBe("cancelled");
  expect(t.progress?.stage).toBe("setup");
  expect(w.deliveries).toHaveLength(1);
  const restored = JSON.parse(JSON.stringify(t)) as typeof t;
  recordProgress(w, restored, "development", "setup", "1", 20000);
  expect(w.deliveries.at(-1)?.text).toContain("environment");
  recordProgress(w, restored, "development", "setup", "1", 21000);
  expect(w.deliveries).toHaveLength(2);
  clearProgress(w, "development", t.id);
  expect(w.deliveries.every((d) => d.state === "cancelled")).toBe(true);
});

test("a confirmed long phase gets one delayed notice and real repairs get fresh identities", () => {
  const w = workspace(),
    t = task();
  recordProgress(w, t, "coding", "check", "1", 10000);
  recordProgress(w, t, "coding", "check", "1", 130000);
  recordProgress(w, t, "coding", "check", "1", 300000);
  expect(w.deliveries.filter((d) => d.id.endsWith(":delay"))).toHaveLength(1);
  recordProgress(w, t, "coding", "repair", "2", 310000);
  recordProgress(w, t, "coding", "check", "2", 320000);
  expect(new Set(w.deliveries.map((d) => d.id)).size).toBe(w.deliveries.length);
  expect(w.deliveries.at(-1)?.text).toContain("running them");
});

test("only retained authorized private queue waits receive a delayed queue notice", () => {
  const w = workspace(),
    at = new Date();
  const r = createRun(w, "101", "hello", "101", 3, "gpt-4.1-mini", { now: at });
  createRun(w, "101", "group question", "-100100", 3, "gpt-4.1-mini", {
    now: at,
  });
  queuedRunFeedback(w, at.getTime() + 29000);
  expect(w.deliveries).toHaveLength(0);
  queuedRunFeedback(w, at.getTime() + 31000);
  queuedRunFeedback(w, at.getTime() + 60000);
  expect(w.deliveries).toHaveLength(1);
  expect(w.deliveries[0]?.feedback).toMatchObject({ owner: "run", id: r.id });
  r.status = "running";
  clearProgress(w, "run", r.id);
  expect(w.deliveries[0]?.state).toBe("cancelled");
});

test("a repeated cancellation does not claim an active executor has stopped", () => {
  const w = workspace();
  const r = createRun(w, "101", "hello", "101", 3, "gpt-4.1-mini");
  r.status = "running";
  r.leaseUntil = new Date(Date.now() + 120000).toISOString();
  cancelRun(w, "101", r.id);
  cancelRun(w, "101", r.id);
  expect(r.stopConfirmed).toBe(false);
  expect(runStatus(r)).toContain("Stopping");
  expect(w.deliveries).toHaveLength(1);
  confirmRunStopped(w, r);
  confirmRunStopped(w, r);
  expect(w.deliveries).toHaveLength(2);
  expect(w.deliveries.at(-1)?.text).toContain("has stopped");
});

test("messages hide unknown codes and expose only verified runner stages", () => {
  const secret = "private-provider-token-detail";
  expect(codingFailureMessage(secret)).not.toContain(secret);
  expect(requestFailureMessage(secret)).not.toContain(secret);
  expect(codingFailureMessage("github_app_permissions_missing")).toContain(
    "operator",
  );
  expect(
    runnerStage(
      { state: "running", phase: "implement", repairCount: 2 },
      "intake",
    ),
  ).toBe("intake");
  expect(
    runnerStage({ state: "running", phase: "implement", repairCount: 2 }),
  ).toBe("repair");
  expect(codingStatusLabel({ state: "running", cancelRequested: true })).toBe(
    "Stopping",
  );
  expect(codingStatusLabel({ state: "failed" })).toBe("Could not complete");
});
