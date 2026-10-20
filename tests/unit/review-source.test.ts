import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareOpenCodeReview } from "../../src/coding/local/open-code-review.ts";
import { ReviewSource } from "../../src/coding/local/review-source.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repodesk-review-source-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    ).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "example.ts"), "export const total = 1;\n");
  await writeFile(join(repo, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "secret"), "runtime-secret-never-returned");
  await symlink(join(root, "secret"), join(repo, "secret-link"));
  await git("add", ".");
  await git("commit", "-qm", "base");
  const mergeBase = await git("rev-parse", "HEAD");
  await writeFile(join(repo, "example.ts"), "export const total = 2;\n");
  await writeFile(join(repo, "$(touch hacked).ts"), "literal name\n");
  await git("add", ".");
  await git("commit", "-qm", "head");
  const headSha = await git("rev-parse", "HEAD");
  await git("checkout", "--detach", mergeBase);
  await writeFile(join(repo, "base-only.ts"), "base branch only\n");
  await git("add", ".");
  await git("commit", "-qm", "newer base");
  const baseSha = await git("rev-parse", "HEAD");
  const review = { baseSha, headSha, action: "review" };
  const plan = await prepareOpenCodeReview(review, async (args) =>
    JSON.stringify(
      args[1] === "preview"
        ? {
            schema_version: "1",
            mode: "range",
            from: baseSha,
            to: headSha,
            merge_base: mergeBase,
            total_files: 1,
            reviewable_count: 1,
            excluded_count: 0,
            reviewable_files: [
              {
                path: "example.ts",
                status: "modified",
                insertions: 1,
                deletions: 1,
              },
            ],
            excluded_files: [],
          }
        : {
            schema_version: "1",
            groups: [
              {
                source: "system",
                pattern: "*.ts",
                files: ["example.ts"],
                rule: "Check correctness.",
              },
            ],
          },
    ),
  );
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  return {
    root,
    repo,
    git,
    review,
    plan,
    planPath,
    mergeBase,
    source: await ReviewSource.create(repo, review, planPath),
  };
}
function page(result: Awaited<ReturnType<ReviewSource["handle"]>>) {
  expect(result.success).toBe(true);
  return JSON.parse(result.contentItems[0]?.text ?? "");
}

test("review reads pinned Git objects and merge-base diffs without using working-tree files", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "example.ts"), "runtime-secret-never-returned");
  expect(
    page(await f.source.handle({ action: "read", path: "example.ts" })).content,
  ).toBe("export const total = 2;\n");
  const diff = page(
    await f.source.handle({ action: "diff", path: "example.ts" }),
  ).content;
  expect(diff).toContain("-export const total = 1;");
  expect(diff).toContain("+export const total = 2;");
  expect(diff).not.toContain("runtime-secret");
  expect(
    page(await f.source.handle({ action: "list", revision: "head" })).content,
  ).not.toContain("base-only.ts");
  expect(
    page(
      await f.source.handle({
        action: "read",
        path: "base-only.ts",
        revision: "base",
      }),
    ).content,
  ).toBe("base branch only\n");
  expect(
    (
      await f.source.handle({
        action: "read",
        path: "base-only.ts",
        revision: "merge_base",
      })
    ).success,
  ).toBe(false);
  expect(
    page(await f.source.handle({ action: "read", path: "$(touch hacked).ts" }))
      .content,
  ).toBe("literal name\n");
  await expect(readFile(join(f.repo, "hacked"))).rejects.toThrow();
});

test("runtime paths, traversal, arbitrary revisions/commands, binary files and symlink targets are inaccessible", async () => {
  const f = await fixture();
  for (const args of [
    ...[
      "/auth/auth.json",
      "/proc/self/environ",
      "../secret",
      "src/../../secret",
      ".git/config",
      "example.ts\n",
    ].map((path) => ({ action: "read", path })),
    { action: "read", path: "binary" },
    { action: "read", path: "example.ts", revision: "HEAD" },
    { action: "exec", path: "example.ts" },
    { action: "read", path: "example.ts", command: "env" },
  ]) {
    const result = await f.source.handle(args);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "runtime-secret-never-returned",
    );
    expect(JSON.stringify(result)).not.toContain(f.root);
  }
  const link = page(
    await f.source.handle({ action: "read", path: "secret-link" }),
  );
  expect(link.content).toBe(join(f.root, "secret"));
  expect(link.content).not.toContain("runtime-secret-never-returned");
});

test("source and OCR plan pagination preserve complete content and exclusions/rules", async () => {
  const f = await fixture();
  let offset = 0,
    content = "";
  do {
    const result = page(
      await f.source.handle({ action: "plan", offset, limit: 31 }),
    );
    content += result.content;
    offset = result.nextOffset;
  } while (offset !== null);
  expect(JSON.parse(content)).toEqual(f.plan);
  expect(
    page(
      await f.source.handle({
        action: "read",
        path: "example.ts",
        offset: 7,
        limit: 5,
      }),
    ),
  ).toMatchObject({ content: "const", offset: 7, nextOffset: 12 });
});

test("invalid, stale, incomplete, wrong-merge-base and symlinked OCR plans fail before model execution", async () => {
  const f = await fixture();
  for (const plan of [
    {},
    { ...f.plan, ruleGroups: [] },
    { ...f.plan, preview: { ...f.plan.preview, to: f.review.baseSha } },
    { ...f.plan, preview: { ...f.plan.preview, merge_base: f.review.baseSha } },
  ]) {
    await writeFile(f.planPath, JSON.stringify(plan));
    await expect(
      ReviewSource.create(f.repo, f.review, f.planPath),
    ).rejects.toThrow();
  }
  await rm(f.planPath);
  await symlink(join(f.root, "secret"), f.planPath);
  await expect(
    ReviewSource.create(f.repo, f.review, f.planPath),
  ).rejects.toThrow();
  const answer = await ReviewSource.create(
    f.repo,
    { ...f.review, action: "answer" },
    f.planPath,
  );
  expect((await answer.handle({ action: "plan" })).success).toBe(false);
  expect(
    page(await answer.handle({ action: "read", path: "example.ts" })).content,
  ).toContain("total = 2");
});

test("Git diff cannot execute a repository-configured external driver", async () => {
  const f = await fixture();
  const marker = join(f.root, "driver-ran");
  const driver = join(f.root, "driver.sh");
  await writeFile(driver, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await f.git("config", "diff.external", driver);
  expect(
    page(await f.source.handle({ action: "diff", path: "example.ts" })).content,
  ).toContain("+export const total = 2;");
  await expect(readFile(marker)).rejects.toThrow();
});
