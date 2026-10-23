import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevelopmentTask } from "../../src/coding/development.ts";
import { developmentPrompt } from "../../src/coding/development.ts";
import { jobCommand } from "../../src/coding/local/job-command.ts";
import {
  prepareReferenceCheckouts,
  verifyReferenceCheckouts,
} from "../../src/coding/local/job-reference-sources.ts";
import {
  checkReferenceSources,
  type ReferenceSource,
  requestedReferences,
} from "../../src/coding/reference-sources.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const source: ReferenceSource = {
  repositoryId: 2,
  repository: "stonega/repodesk",
  installationId: 501,
  connectionRevision: 1,
  repositoryRevision: 0,
  ref: "main",
  sha: "a".repeat(40),
  revision: 1,
};
function fixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      {
        id: 1,
        full_name: "stonega/repodesk-landing",
        default_branch: "main",
        private: true,
      },
      {
        id: 2,
        full_name: "stonega/repodesk",
        default_branch: "main",
        private: true,
      },
    ],
  };
  grantGitHubAccess(w, ["101", "202"]);
  const task: DevelopmentTask = {
    id: randomUUID(),
    workspaceId: w.id,
    actor: "101",
    botId: "999",
    chatId: "101",
    topicId: 0,
    sourceId: "original",
    payload: {
      repositoryId: 1,
      repository: "stonega/repodesk-landing",
      installationId: 501,
      githubRevision: 1,
      configRevision: 1,
      baseBranch: "main",
      backend: "podman",
      authMode: "provider_key",
      title: "Sync",
      body: "Sync",
    },
    policy: { publishByDefault: true },
    state: "queued",
    phase: "intake",
    revision: 1,
    consumedRevision: 0,
    verifiedRevision: 0,
    fence: 0,
    attempts: 0,
    tokens: 0,
    activeMs: 0,
    canImplement: false,
    canPublish: false,
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    w,
    task,
    inputs: (text: string) => [
      {
        text,
        sourceId: "original",
        actor: "101",
        revision: 1,
        kind: "request" as const,
      },
    ],
  };
}

test("the reported short source name resolves independently of the longer modification target", () => {
  const f = fixture();
  expect(
    requestedReferences(
      f.w,
      f.task,
      f.inputs(
        "Copy/refresh docs from another repo (like repodesk) into repodesk-landing? yes",
      ),
    ).map((r) => r.id),
  ).toEqual([2]);
  expect(
    requestedReferences(f.w, f.task, f.inputs("Fix stonega/repodesk-landing")),
  ).toEqual([]);
  expect(
    requestedReferences(f.w, f.task, f.inputs("Fix repodesk-landing")),
  ).toEqual([]);
  expect(
    requestedReferences(
      f.w,
      f.task,
      f.inputs(
        "Use https://github.com/stonega/repodesk/blob/main/docs/user/README.md",
      ),
    ),
  ).toHaveLength(1);
  expect(
    requestedReferences(
      f.w,
      f.task,
      f.inputs("Use https://github.com.evil/stonega/repodesk"),
    ),
  ).toEqual([]);
  f.w.github?.repositories.push({
    id: 3,
    full_name: "another/repodesk",
    default_branch: "main",
  });
  expect(requestedReferences(f.w, f.task, f.inputs("Read repodesk"))).toEqual(
    [],
  );
  expect(
    requestedReferences(f.w, f.task, f.inputs("Read stonega/repodesk")),
  ).toHaveLength(1);
});

test("reference access requires workspace selection and current read access for every contributor", () => {
  const f = fixture();
  expect(
    requestedReferences(f.w, f.task, f.inputs("Read elsewhere/private")),
  ).toEqual([]);
  const actor = f.w.members.find((m) => m.id === "101");
  if (!actor?.github) throw Error("Missing fixture access");
  actor.github.repositories = actor.github.repositories.filter(
    (r) => r.id !== 2,
  );
  expect(() =>
    requestedReferences(f.w, f.task, f.inputs("Read repodesk")),
  ).toThrow("github_user_access_denied");
  const g = fixture();
  g.task.referenceSources = [source];
  checkReferenceSources(g.w, g.task, ["101"]);
  g.w.github?.repositories.splice(1, 1);
  expect(() => checkReferenceSources(g.w, g.task, ["101"])).toThrow(
    "coding_reference_source_changed",
  );
});

test("handoff exposes the actual pinned reference path and routes environment blockers separately from product questions", () => {
  const f = fixture();
  const prompt = developmentPrompt({
    taskId: f.task.id,
    revision: 1,
    mode: "intake",
    context: "",
    inputs: f.inputs("Copy repodesk docs"),
    referenceSources: [source],
  });
  expect(prompt).toContain('"path":"/task/references/2"');
  expect(prompt).toContain(source.sha);
  expect(prompt).toContain(
    "If the required reference is already listed, use it without another source-preparation question",
  );
  expect(prompt).toContain("blocker=environment and question=null");
});

test("reference preparation checks out the exact pin despite a newer branch tip, and verification rejects changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repodesk-reference-"));
  directories.push(directory);
  const origin = join(directory, "origin"),
    root = join(directory, "references");
  await mkdir(origin);
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[]) =>
    jobCommand("git", args, { cwd: origin, env, stderr: true });
  await git(["init", "--initial-branch=main"]);
  await mkdir(join(origin, "docs/user"), { recursive: true });
  await writeFile(join(origin, "docs/user/README.md"), "# Pinned 文档\n");
  await git(["add", "."]);
  const commit = () =>
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ]);
  await commit();
  const pinned = { ...source, sha: (await git(["rev-parse", "HEAD"])).trim() };
  await writeFile(join(origin, "docs/user/README.md"), "# Newer source\n");
  await git(["add", "."]);
  await commit();
  const credentialCalls: string[][] = [];
  const command: typeof jobCommand = async (binary, args, options) => {
    if (options.env.GIT_CONFIG_VALUE_0) credentialCalls.push(args);
    expect(args.join(" ")).not.toContain("reference-secret");
    return jobCommand(
      binary,
      args.map((arg) =>
        arg === "https://github.com/stonega/repodesk.git" ? origin : arg,
      ),
      options,
    );
  };
  await prepareReferenceCheckouts([pinned], "reference-secret", root, command);
  expect(credentialCalls).toHaveLength(2);
  expect(await readFile(join(root, "2/docs/user/README.md"), "utf8")).toBe(
    "# Pinned 文档\n",
  );
  await verifyReferenceCheckouts([pinned], root);
  await writeFile(join(root, "2/docs/user/README.md"), "Changed\n");
  await expect(verifyReferenceCheckouts([pinned], root)).rejects.toThrow(
    "coding_reference_source_changed",
  );
  await expect(
    prepareReferenceCheckouts([pinned], undefined, root),
  ).rejects.toThrow("coding_reference_source_unavailable");
});
