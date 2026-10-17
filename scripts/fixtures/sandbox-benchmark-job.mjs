// Credential-free workload. Never contacts GitHub, Telegram or a model provider.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const mode = process.argv[2];
if (
  ["setup", "check", "export"].includes(mode) &&
  (process.env.GITHUB_TOKEN || process.env.CODEX_TASK_TOKEN)
)
  throw Error("Unexpected credential");
if (mode === "publish" && process.env.CODEX_TASK_TOKEN)
  throw Error("Model credential in publication");
const git = (args) =>
  execFileSync("git", args, {
    cwd: "/task/repo",
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
if (mode === "prepare") {
  await mkdir("/task/repo", { recursive: true });
  git(["init", "--initial-branch=main"]);
  for (let i = 0; i < 100; i++)
    await writeFile(`/task/repo/file-${i}.txt`, `fixture ${i}\n`.repeat(100));
  git(["add", "--all"]);
  git([
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await writeFile("/task/base-sha", git(["rev-parse", "HEAD"]).trim());
  try {
    git(["apply", "--index", "/input/checkpoint.patch"]);
  } catch {}
} else if (mode === "setup") {
  const input = await readFile("/input/job.json", "utf8");
  if (!JSON.parse(input).payload.title.startsWith("Sandbox benchmark"))
    throw Error("Wrong fixture");
} else if (mode === "implement") {
  await writeFile("/task/repo/result.txt", "verified fixture\n".repeat(65536));
  git(["add", "--all"]);
  await writeFile(
    "/task/result.patch",
    git(["diff", "--cached", "--binary", "HEAD"]),
  );
  await writeFile(
    "/task/conversation.json",
    JSON.stringify({
      threadId: "benchmark-thread",
      tokens: 0,
      result: {
        status: "completed",
        intent: "implement",
        evidenceRevision: 1,
        evidence: "Fix bug",
        publishRequested: true,
        summary: "Fixture completed",
        question: null,
        title: "Benchmark",
        body: "Fixture",
        verificationCommands: ["test -s result.txt"],
      },
    }),
  );
} else if (mode === "check") {
  if (
    !(await readFile("/task/repo/result.txt", "utf8")).startsWith(
      "verified fixture",
    )
  )
    throw Error("Missing output");
  git(["add", "--all"]);
  await writeFile(
    "/task/result.patch",
    git(["diff", "--cached", "--binary", "HEAD"]),
  );
} else if (mode === "export") {
  process.stdout.write(
    JSON.stringify({ patch: await readFile("/task/result.patch", "utf8") }),
  );
} else if (mode === "publish") {
  // Fresh publication storage must not contain the implementation checkout.
  await mkdir("/task/repo");
  if (!(await readFile("/input/patch", "utf8")).includes("verified fixture"))
    throw Error("Missing patch");
  await writeFile(
    "/task/publication.json",
    JSON.stringify({
      prUrl: "https://github.com/example/sandbox-benchmark/pull/1",
    }),
  );
} else throw Error("Unknown phase");
