import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "../../src/db/pool.ts";
import { Fault } from "../../src/domain.ts";
import { logQuery, RuntimeLogger } from "../../src/observability/logs.ts";

test("runtime logs allow only fixed codes, messages and UUID context", async () => {
  const output: string[] = [];
  const batches: unknown[][] = [];
  const sql = {
    async query(_text: unknown, params: string[]) {
      batches.push(JSON.parse(params[0] ?? "[]"));
    },
  } as unknown as Sql;
  const log = new RuntimeLogger(sql, "worker", (line) => output.push(line));
  const secret = "sk-secret-api-key-and-private-text";
  log.write("run_failed", {
    error: new Error(secret),
    workspaceId: secret,
    runId: secret,
  });
  log.write("run_failed", {
    error: new Fault(secret),
    workspaceId: randomUUID(),
    runId: randomUUID(),
  });
  log.write("run_failed", { error: new Fault("workspace_budget_exhausted") });
  await log.close();
  expect(output.join("")).not.toContain(secret);
  expect(JSON.stringify(batches)).not.toContain(secret);
  expect(output.join("")).toContain("unexpected_error");
  expect(output.join("")).toContain("workspace_budget_exhausted");
  expect(JSON.parse(output[0] ?? "{}").workspace_id).toBeUndefined();
  log.write("app_started");
  expect(output).toHaveLength(3);
});
test("logging storage failures do not throw or recursively log database errors", async () => {
  const output: string[] = [];
  let calls = 0;
  const sql = {
    async query() {
      calls++;
      throw Error("postgres://secret@private-host/database");
    },
  } as unknown as Sql;
  const log = new RuntimeLogger(sql, "app", (line) => output.push(line));
  log.write("app_started");
  await log.flush();
  expect(calls).toBe(1);
  expect(output.join("")).toContain("log_storage_unavailable");
  expect(output.join("")).not.toContain("private-host");
});
test("draft diagnostics omit Telegram bodies, credentials and private content", () => {
  const output: string[] = [];
  const log = new RuntimeLogger(undefined, "worker", (line) =>
    output.push(line),
  );
  log.write("telegram_draft_failed", {
    error: new Error("private response and token"),
  });
  log.write("telegram_draft_failed", {
    error: new Fault("telegram_destination_rejected"),
  });
  log.write("telegram_draft_started");
  expect(output.join("")).not.toContain("private response and token");
  expect(output.join("")).toContain("telegram_destination_rejected");
  expect(output.join("")).toContain("telegram_draft_started");
});
test("log buffering is bounded while the database is slow", async () => {
  const gate = Promise.withResolvers<void>();
  let saved = 0;
  const sql = {
    async query(_text: unknown, params: string[]) {
      await gate.promise;
      saved += JSON.parse(params[0] ?? "[]").length;
    },
  } as unknown as Sql;
  const output: string[] = [];
  const log = new RuntimeLogger(sql, "worker", (line) => output.push(line));
  for (let i = 0; i < 1000; i++) log.write("telegram_polling_failed");
  gate.resolve();
  await log.close();
  expect(saved).toBeLessThanOrEqual(250);
  expect(
    output.filter((line) => JSON.parse(line).event === "log_buffer_full"),
  ).toHaveLength(1);
});
test("log filters reject invalid enums, oversized queries and bigint overflow", () => {
  expect(logQuery.parse({ limit: "2", before: "123" }).limit).toBe(2);
  for (const invalid of [
    { limit: "1000" },
    { level: "secret" },
    { service: "postgres" },
    { q: "x".repeat(101) },
    { before: "9223372036854775808" },
    { before: "-1" },
  ])
    expect(() => logQuery.parse(invalid)).toThrow();
});
