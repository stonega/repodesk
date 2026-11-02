import { expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import { Fault } from "../../src/domain.ts";
import { safeLogCode } from "../../src/observability/logs.ts";

test("retired run deadlines do not impose an execution limit", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/test",
    ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect(config(env)).not.toHaveProperty("RUN_TIMEOUT_SECONDS");
  for (const value of ["300", "600", "0", "invalid"]) {
    expect(config({ ...env, RUN_TIMEOUT_SECONDS: value })).not.toHaveProperty(
      "RUN_TIMEOUT_SECONDS",
    );
  }
});

test("timeout and shutdown diagnoses survive safe logging", () => {
  for (const code of ["run_timeout", "worker_shutdown"]) {
    expect(safeLogCode(new Fault(code))).toBe(code);
  }
});
