import { expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import { Fault } from "../../src/domain.ts";
import { safeLogCode } from "../../src/observability/logs.ts";

test("run deadline configuration is bounded and defaults to five minutes", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/test",
    ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect(config(env).RUN_TIMEOUT_SECONDS).toBe(300);
  expect(
    config({ ...env, RUN_TIMEOUT_SECONDS: "600" }).RUN_TIMEOUT_SECONDS,
  ).toBe(600);
  for (const value of ["0", "-1", "1.5", "1801", "NaN", "Infinity", ""]) {
    expect(() => config({ ...env, RUN_TIMEOUT_SECONDS: value })).toThrow();
  }
});

test("timeout and shutdown diagnoses survive safe logging", () => {
  for (const code of ["run_timeout", "worker_shutdown"]) {
    expect(safeLogCode(new Fault(code))).toBe(code);
  }
});
