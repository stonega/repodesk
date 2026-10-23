import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReferenceSource } from "../reference-sources.ts";
import { jobCommand } from "./job-command.ts";

const gitEnv = () => ({
  PATH: process.env.PATH,
  HOME: "/tmp",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
});
type Command = typeof jobCommand;

/** Credentials exist only in the application-owned preparation process. */
export async function prepareReferenceCheckouts(
  sources: ReferenceSource[],
  token: string | undefined,
  root = "/task/references",
  command: Command = jobCommand,
) {
  await rm(root, { recursive: true, force: true });
  if (!sources.length) return;
  if (!token) throw Error("coding_reference_source_unavailable");
  await mkdir(root, { recursive: true });
  const env = {
    ...gitEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  for (const source of sources) {
    const path = join(root, String(source.repositoryId));
    await command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "clone",
        "--no-checkout",
        "--single-branch",
        "--branch",
        source.ref,
        "--",
        `https://github.com/${source.repository}.git`,
        path,
      ],
      { env, cwd: root, stderr: true },
    );
    // Fetch the exact pin as well: the branch may have moved since API resolution.
    await command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "origin",
        source.sha,
      ],
      { env, cwd: path, stderr: true },
    );
    await command(
      "git",
      ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", source.sha],
      { env: gitEnv(), cwd: path, stderr: true },
    );
  }
  await verifyReferenceCheckouts(sources, root, command);
}

export async function verifyReferenceCheckouts(
  sources: ReferenceSource[],
  root = "/task/references",
  command: Command = jobCommand,
) {
  for (const source of sources) {
    const options = {
      cwd: join(root, String(source.repositoryId)),
      env: gitEnv(),
      stderr: true,
    };
    const head = await command("git", ["rev-parse", "HEAD"], options);
    const status = await command(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
      ],
      options,
    );
    if (head.trim() !== source.sha || status.trim())
      throw Error("coding_reference_source_changed");
    await command(
      "git",
      [
        "diff",
        "--exit-code",
        "--no-ext-diff",
        "--no-textconv",
        source.sha,
        "--",
      ],
      options,
    );
  }
}
