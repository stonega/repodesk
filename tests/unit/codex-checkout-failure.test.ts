import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkoutFailureCode } from "../../src/coding/local/checkout-failure.ts";

const exec = promisify(execFile);

test("a real Git clone identifies a missing configured base branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-checkout-failure-"));
  try {
    const source = join(dir, "source");
    const git = (args: string[]) =>
      exec("git", args, {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
    await git(["init", "--initial-branch=main", source]);
    await writeFile(join(source, "README.md"), "Local fixture\n");
    await git(["-C", source, "add", "README.md"]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ]);
    let failure: unknown;
    try {
      await git([
        "clone",
        "--no-checkout",
        "--single-branch",
        "--branch",
        "develop",
        "--",
        source,
        join(dir, "checkout"),
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(
      checkoutFailureCode(
        { diagnostics: (failure as { stderr: string }).stderr },
        "develop",
        "develop",
      ),
    ).toBe("coding_base_branch_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkout failures do not expose diagnostics or mislabel a missing PR branch", () => {
  const error = {
    diagnostics:
      "token=private-value\nfatal: Remote branch codex/task not found in upstream origin\n",
  };
  expect(checkoutFailureCode(error, "codex/task", "develop")).toBe(
    "coding_checkout_failed",
  );
  for (const failure of [
    { diagnostics: "fatal: Authentication failed for token=private-value" },
    { diagnostics: "fatal: Could not resolve host: private-host" },
    { diagnostics: "fatal: Remote branch main not found in upstream origin" },
    new Error("private repository output"),
    null,
  ])
    expect(checkoutFailureCode(failure, "develop", "develop")).toBe(
      "coding_checkout_failed",
    );
});
