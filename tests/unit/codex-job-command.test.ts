import { expect, test } from "bun:test";
import {
  type ChildProcess,
  execFileSync,
  type spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { jobCommand } from "../../src/coding/local/job-command.ts";

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
};

function fragmentedCommand(output: string, diagnostics = "", code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
  });
  const launch = (() => {
    queueMicrotask(() => {
      // Force every possible UTF-8 boundary without relying on OS pipe timing.
      for (const byte of Buffer.from(output))
        child.stdout.write(Buffer.from([byte]));
      for (const byte of Buffer.from(diagnostics))
        child.stderr.write(Buffer.from([byte]));
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    });
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  return launch;
}

test("fragmented multilingual Git output remains an applicable publication patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-utf8-patch-"));
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: root, env, input }).toString("utf8");
  const before = "# 群組設定\n\n保留原本內容。\n";
  const after = "# 群組設定\n\n保留原本內容。\n新增說明：連結群組 🌏 café。\n";
  try {
    git(["init", "--quiet"]);
    await writeFile(join(root, "guide.md"), before);
    git(["add", "guide.md"]);
    await writeFile(join(root, "guide.md"), after);
    const raw = git(["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
    const patch = await jobCommand("git", [], { env }, fragmentedCommand(raw));
    expect(patch).toBe(raw);
    expect(patch).not.toContain("\ufffd");
    await writeFile(join(root, "guide.md"), before);
    git(["apply", "--index", "-"], patch);
    expect(await readFile(join(root, "guide.md"), "utf8")).toBe(after);
    expect(git(["show", ":guide.md"])).toBe(after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fragmented command diagnostics preserve Unicode on both output streams", async () => {
  let failure: unknown;
  try {
    await jobCommand(
      "git",
      [],
      { env, stderr: true },
      fragmentedCommand("輸出 🌏\n", "錯誤：檔案不存在。\n", 1),
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("coding_command_failed");
  expect((failure as { diagnostics: string }).diagnostics).toBe(
    "輸出 🌏\n錯誤：檔案不存在。\n",
  );
});

test("line callbacks preserve fragmented Unicode without accumulating output", async () => {
  const lines: string[] = [];
  expect(
    await jobCommand(
      "fixture",
      [],
      { env, line: (line) => lines.push(line) },
      fragmentedCommand("群組 🌏\n第二行\n"),
    ),
  ).toBe("");
  expect(lines).toEqual(["群組 🌏", "第二行"]);
});

test("the job command runs a real subprocess with explicit environment and stdin", async () => {
  expect(
    await jobCommand("node", ["-e", "process.stdin.pipe(process.stdout)"], {
      env,
      input: "群組 🌏 café\n",
    }),
  ).toBe("群組 🌏 café\n");
});
