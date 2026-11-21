import { expect, test } from "bun:test";
import type { LocalRunner } from "../../src/coding/local/protocol.ts";
import {
  CodexLocalWorkerAdapter,
  type CodingWorkerAdapter,
  CodingWorkerRegistry,
} from "../../src/coding/worker-adapter.ts";

test("CodingWorkerRegistry resolves available preferred worker and falls back cleanly", () => {
  const fakeRunner = {} as LocalRunner;
  const codex = new CodexLocalWorkerAdapter(fakeRunner);
  const unavailableClaude: CodingWorkerAdapter = {
    kind: "claude_code",
    label: "Claude Code Runner",
    capabilities: () => ({
      kind: "claude_code",
      label: "Claude Code Runner",
      available: false,
      supportsInvestigation: true,
      supportsRelease: false,
      supportsResume: true,
    }),
    runner: () => undefined,
  };

  const registry = new CodingWorkerRegistry([codex, unavailableClaude]);
  expect(registry.list()).toHaveLength(2);
  expect(registry.resolve("codex")?.kind).toBe("codex");
  expect(registry.resolve("codex")?.runner()).toBe(fakeRunner);
  // Unavailable preferred worker falls back to available codex adapter
  expect(registry.resolve("claude_code")?.kind).toBe("codex");
});
