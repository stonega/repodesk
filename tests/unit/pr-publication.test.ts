import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationPushArgs } from "../../src/coding/local/publication.ts";

test("publication refuses a concurrent maintainer rewind even when the patch is a fast-forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-publication-"));
  const remote = join(root, "remote.git"),
    local = join(root, "repo");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], cwd = root) =>
    execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const commit = () =>
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-am",
        "Fixture",
      ],
      local,
    );
  try {
    git(["init", "--bare", remote]);
    git(["init", "-b", "main", local]);
    git(["remote", "add", "origin", remote], local);
    await writeFile(join(local, "file.txt"), "seed\n");
    git(["add", "file.txt"], local);
    commit();
    const seed = git(["rev-parse", "HEAD"], local);
    await writeFile(join(local, "file.txt"), "maintainer commit\n");
    commit();
    const expected = git(["rev-parse", "HEAD"], local);
    git(["push", "origin", "main"], local);
    await writeFile(join(local, "file.txt"), "bot fix\n");
    commit();
    git(["merge-base", "--is-ancestor", expected, "HEAD"], local);
    git(["--git-dir", remote, "update-ref", "refs/heads/main", seed]);
    expect(() => git(publicationPushArgs("main", expected), local)).toThrow();
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(
      seed,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
