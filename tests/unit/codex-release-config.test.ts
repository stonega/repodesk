import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../deploy/codex/release-config.mjs");
const images = {
  CODEX_SUPERVISOR_IMAGE: `sha256:${"a".repeat(64)}`,
  CODEX_RUNNER_IMAGE: `sha256:${"b".repeat(64)}`,
};
function fixture(
  check: (
    root: string,
    release: string,
    run: () => ReturnType<typeof Bun.spawnSync>,
  ) => void,
  configured = "",
) {
  const root = mkdtempSync(join(tmpdir(), "repodesk-codex-release-"));
  const release = join(root, "release");
  mkdirSync(release);
  writeFileSync(join(root, ".env"), configured);
  try {
    check(root, release, () =>
      Bun.spawnSync(["node", script, root, release, "repodesk"], {
        env: { ...process.env, ...images },
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("release generates a private token once, preserving account state and token across updates", () => {
  fixture((root, release, run) => {
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout?.toString()).toBe("");
    const path = join(root, "secrets/codex-runner-token");
    const token = readFileSync(path, "utf8").trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(release, "codex.env")).mode & 0o777).toBe(0o600);
    writeFileSync(join(root, "secrets/account-fixture"), "sealed account");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
    expect(readFileSync(join(root, "secrets/account-fixture"), "utf8")).toBe(
      "sealed account",
    );
    expect(readFileSync(join(release, "codex.env"), "utf8")).toBe(
      `CODEX_RUNNER_TOKEN=${token}\nCODEX_SUPERVISOR_IMAGE=${images.CODEX_SUPERVISOR_IMAGE}\nCODEX_RUNNER_IMAGE=${images.CODEX_RUNNER_IMAGE}\nCODEX_RUNNER_NETWORK=repodesk_codex_tasks\n`,
    );
  });
});
test("existing configured token is adopted; mismatched rotation fails without overwriting it", () => {
  const configured = "existing-secret-".repeat(4);
  fixture((root, _release, run) => {
    expect(run().exitCode).toBe(0);
    writeFileSync(
      join(root, ".env"),
      `CODEX_RUNNER_TOKEN=${"different-secret-".repeat(4)}\n`,
    );
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("explicitly rotate");
    expect(result.stderr?.toString()).not.toContain(configured);
    expect(
      readFileSync(join(root, "secrets/codex-runner-token"), "utf8").trim(),
    ).toBe(configured);
  }, `CODEX_RUNNER_TOKEN=${configured}\nUNRELATED=$(exit 99)\n`);
});
test("invalid configured token is rejected without exposing it", () => {
  fixture((_root, _release, run) => {
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("URL-safe");
    expect(result.stderr?.toString()).not.toContain("bad-private-token");
  }, "CODEX_RUNNER_TOKEN=bad-private-token\n");
});
