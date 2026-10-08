import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const image = process.argv[2] ?? "repodesk-ocr-job:test";
const root = await mkdtemp(join(tmpdir(), "repodesk-ocr-smoke-"));
const repo = join(root, "task", "repo");
const input = join(root, "input");
const binaries = join(root, "binaries");
const prefix = `repodesk-ocr-smoke-${randomUUID()}`;
const copier = `${prefix}-copy`;
const taskVolume = `${prefix}-task`;
const inputVolume = `${prefix}-input`;
const binaryVolume = `${prefix}-binaries`;
const docker = (args: string[]) =>
  exec("docker", args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 60000,
  });
const readResult = async (name: string) => {
  const destination = join(root, name);
  await docker(["cp", `${copier}:/task/${name}`, destination]);
  return readFile(destination, "utf8");
};
const env = {
  PATH: process.env.PATH,
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const git = async (...args: string[]) =>
  (await exec("git", args, { cwd: repo, env })).stdout.trim();
const run = (fixture = false) =>
  exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=1000:1000",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777",
      "--volume",
      `${taskVolume}:/task`,
      "--volume",
      `${inputVolume}:/input:ro`,
      ...(fixture
        ? [
            "--volume",
            `${binaryVolume}:/fixtures:ro`,
            "--env",
            "PATH=/fixtures:/usr/local/bin:/usr/bin:/bin",
          ]
        : []),
      image,
      "setup",
    ],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60000 },
  );

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(input);
  await mkdir(binaries);
  await git("init", "-q");
  await git("config", "user.name", "Offline fixture");
  await git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "src", "example.ts"), "export const total = 1;\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const baseSha = await git("rev-parse", "HEAD");
  await writeFile(join(repo, "src", "example.ts"), "export const total = 2;\n");
  await writeFile(
    join(repo, "README.md"),
    "# Excluded documentation fixture\n",
  );
  await git("add", ".");
  await git("commit", "-qm", "head");
  const headSha = await git("rev-parse", "HEAD");
  await writeFile(join(binaries, "ocr"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  // Named volumes work with rootless and remote daemons too; no host bind permissions.
  await docker([
    "create",
    "--name",
    copier,
    "--network=none",
    "--user=0:0",
    "--entrypoint=chown",
    "--volume",
    `${taskVolume}:/task`,
    "--volume",
    `${inputVolume}:/input`,
    "--volume",
    `${binaryVolume}:/fixtures`,
    image,
    "-R",
    "1000:1000",
    "/task",
    "/input",
    "/fixtures",
  ]);
  await docker(["cp", `${join(root, "task")}/.`, `${copier}:/task`]);
  await docker(["cp", `${binaries}/.`, `${copier}:/fixtures`]);
  await docker(["start", "--attach", copier]);
  const job = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    payload: {
      repositoryId: 1,
      repository: "fixture/repository",
      installationId: 1,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      title: "Offline review",
      body: "Review fixture",
      backend: "podman",
      authMode: "provider_key",
    },
    development: {
      taskId: "00000000-0000-4000-8000-000000000002",
      revision: 1,
      mode: "analysis",
      inputs: [
        {
          revision: 1,
          actor: "101",
          sourceId: "fixture",
          text: "review",
          kind: "request",
        },
      ],
      review: { number: 1, baseSha, headSha, action: "review" },
    },
  };
  const save = async () => {
    const file = join(input, "job.json");
    await writeFile(file, JSON.stringify(job));
    await docker(["cp", file, `${copier}:/input/job.json`]);
  };
  await save();
  await run();
  const plan = JSON.parse(await readResult("open-code-review.json"));
  assert.equal(plan.engine, "open-code-review");
  assert.equal(plan.preview.from, baseSha);
  assert.equal(plan.preview.to, headSha);
  assert.deepEqual(
    plan.preview.reviewable_files.map((file: { path: string }) => file.path),
    ["src/example.ts"],
  );
  assert.deepEqual(
    plan.ruleGroups.flatMap((group: { files: string[] }) => group.files),
    ["src/example.ts"],
  );
  assert.equal(plan.preview.excluded_files[0].path, "README.md");

  // Failure is deterministic and cannot use a model or a network fallback.
  await docker([
    "run",
    "--rm",
    "--network=none",
    "--entrypoint=rm",
    "--volume",
    `${taskVolume}:/task`,
    image,
    "/task/open-code-review.json",
  ]);
  await assert.rejects(run(true));
  assert.equal(
    await readResult("failure-code"),
    "coding_review_preparation_failed",
  );
  await assert.rejects(readResult("open-code-review.json"));
  for (const action of ["answer", "fix"]) {
    job.development.review.action = action;
    await save();
    await run(true);
  }
  // Check setup did not rewrite the checkout, even through an OCR invocation.
  assert.equal(
    (
      await docker([
        "run",
        "--rm",
        "--network=none",
        "--entrypoint=git",
        "--workdir=/task/repo",
        "--volume",
        `${taskVolume}:/task`,
        image,
        "status",
        "--porcelain",
      ])
    ).stdout.trim(),
    "",
  );
  console.log(
    "OCR job smoke passed: exact refs, complete rules, exclusions, fail-closed preparation and answer/fix isolation.",
  );
} finally {
  await docker(["stop", copier]).catch(() => {});
  await docker(["rm", copier]).catch(() => {});
  await docker(["volume", "rm", taskVolume, inputVolume, binaryVolume]).catch(
    () => {},
  );
  await rm(root, { recursive: true, force: true });
}
