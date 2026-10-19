import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCodeTruthToken } from "../../scripts/code-truth-token.ts";

test("Code Truth initialization publishes one shared token and preserves it across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "repodesk-code-truth-token-"));
  const path = join(root, "auth/token");
  try {
    initializeCodeTruthToken(path);
    const token = readFileSync(path, "utf8");
    expect(token.trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    initializeCodeTruthToken(path);
    expect(readFileSync(path, "utf8")).toBe(token);
    expect(readdirSync(join(root, "auth"))).toEqual(["token"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid saved Code Truth token stops initialization without replacing or revealing it", () => {
  const root = mkdtempSync(join(tmpdir(), "repodesk-code-truth-token-"));
  const path = join(root, "token");
  try {
    writeFileSync(path, "private-invalid-token");
    expect(() => initializeCodeTruthToken(path)).toThrow(
      "Saved Code Truth service token is invalid",
    );
    expect(readFileSync(path, "utf8")).toBe("private-invalid-token");
    expect(readdirSync(root)).toEqual(["token"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent initializers share one complete token without exposing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "repodesk-code-truth-token-"));
  const path = join(root, "token");
  try {
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../scripts/code-truth-token.ts"),
          path,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    for (const child of children) {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    }
    expect(readFileSync(path, "utf8").trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(root)).toEqual(["token"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
