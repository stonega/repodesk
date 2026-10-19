import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wasInterrupted } from "../../src/coding/local/interruption.ts";

test("job SIGTERM writes a bounded generation marker and exits without exposing input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-signal-"));
  const path = join(dir, "interruption.json");
  const executionId = randomUUID();
  const module = new URL(
    "../../src/coding/local/interruption.ts",
    import.meta.url,
  ).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { watchInterruption } from ${JSON.stringify(module)};
    watchInterruption(${JSON.stringify(executionId)}, "implement", ${JSON.stringify(path)});
    console.log("ready");
    setInterval(() => {}, 1000);
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    reader.releaseLock();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      executionId,
      phase: "implement",
    });
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only a matching job signal or a proven host boot change permits interruption recovery", () => {
  const executionId = randomUUID();
  const marker = { executionId, phase: "implement" };
  const state = {
    Running: false,
    Status: "exited",
    ExitCode: 143,
    OOMKilled: false,
  };
  expect(wasInterrupted(state, marker, executionId, "implement", false)).toBe(
    true,
  );
  expect(wasInterrupted(state, undefined, executionId, "implement", true)).toBe(
    true,
  );
  expect(
    wasInterrupted(
      { ...state, ExitCode: 137 },
      undefined,
      executionId,
      "implement",
      true,
    ),
  ).toBe(true);
  for (const [changed, candidate, status, phase] of [
    [false, undefined, state, "implement"],
    [false, { ...marker, executionId: randomUUID() }, state, "implement"],
    [false, marker, state, "check"],
    [false, marker, { ...state, ExitCode: 1 }, "implement"],
    [false, marker, { ...state, ExitCode: 137 }, "implement"],
    [true, marker, { ...state, OOMKilled: true }, "implement"],
    [true, marker, { ...state, Running: true }, "implement"],
    [true, marker, state, "publish"],
    [
      true,
      undefined,
      { Running: false, Status: "exited", ExitCode: 137 },
      "implement",
    ],
  ] as const)
    expect(wasInterrupted(status, candidate, executionId, phase, changed)).toBe(
      false,
    );
});
