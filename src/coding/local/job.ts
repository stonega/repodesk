// Fixed entrypoint for task phases. Never imported by the bot worker.
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { exportRelease } from "../../releases/prepare.ts";
import {
  developmentPrompt,
  developmentSchema,
  verificationCommands,
} from "../development.ts";
import { CodexAuthError } from "./auth-failure.ts";
import { checkoutFailureCode } from "./checkout-failure.ts";
import { runConversation } from "./conversation.ts";
import { CodexConversationError } from "./conversation-failure.ts";
import { watchInterruption } from "./interruption.ts";
import { JobTaskChannel } from "./job-channel.ts";
import { jobCommand as command } from "./job-command.ts";
import { jobPath } from "./job-paths.ts";
import {
  prepareReferenceCheckouts,
  verifyReferenceCheckouts,
} from "./job-reference-sources.ts";
import { prepareOpenCodeReview } from "./open-code-review.ts";
import { localStart } from "./protocol.ts";
import { markPullRequestReady, publicationPushArgs } from "./publication.ts";
import { ReviewSource } from "./review-source.ts";

const jobSchema = localStart
  .omit({ readToken: true, referenceToken: true, providerApiKey: true })
  .extend({
    executionId: z.uuid().optional(),
    recoveryId: z.uuid().optional(),
    baseSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    config: z.string().optional(),
    verificationCommands: verificationCommands.optional(),
  });
type Job = z.infer<typeof jobSchema>;
const repo = jobPath("/task/repo");
const gitEnv = {
  PATH: process.env.PATH,
  HOME: "/tmp",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

function git(args: string[], cwd = repo, auth = false) {
  const env: NodeJS.ProcessEnv = { ...gitEnv };
  if (auth) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64")}`;
  }
  return command(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, env, stderr: true },
  );
}
async function clone(job: Job) {
  const branch = job.development?.review
    ? job.payload.baseBranch
    : (job.development?.pr?.branch ?? job.payload.baseBranch);
  try {
    await git(
      [
        "clone",
        "--no-checkout",
        "--single-branch",
        "--branch",
        branch,
        "--",
        `https://github.com/${job.payload.repository}.git`,
        repo,
      ],
      jobPath("/task"),
      true,
    );
  } catch (error) {
    await writeFile(
      jobPath("/task/failure-code"),
      checkoutFailureCode(error, branch, job.payload.baseBranch),
    );
    throw new Error("coding_checkout_failed");
  }
  if (job.development?.review) {
    const review = job.development.review;
    await git(
      ["fetch", "--no-tags", "origin", `refs/pull/${review.number}/head`],
      repo,
      true,
    );
    if ((await git(["rev-parse", "FETCH_HEAD"])).trim() !== review.headSha) {
      await writeFile(
        jobPath("/task/failure-code"),
        "coding_remote_head_changed",
      );
      throw new Error("coding_remote_head_changed");
    }
    await git(["cat-file", "-e", `${review.baseSha}^{commit}`]);
  }
  const sha =
    job.baseSha ??
    job.development?.review?.headSha ??
    job.development?.pr?.headSha ??
    (await git(["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("coding_base_invalid");
  await git(["checkout", "--detach", sha]);
  return sha;
}
async function setup(job: Job) {
  const env = { ...gitEnv, HOME: jobPath("/task/home") };
  await mkdir(env.HOME, { recursive: true });
  if (job.development?.review?.action === "review") {
    try {
      const plan = await prepareOpenCodeReview(job.development.review, (args) =>
        command("ocr", args, { cwd: repo, env }),
      );
      await writeFile(
        jobPath("/task/open-code-review.json"),
        JSON.stringify(plan),
      );
    } catch {
      await writeFile(
        jobPath("/task/failure-code"),
        "coding_review_preparation_failed",
      );
      throw new Error("coding_review_preparation_failed");
    }
  }
}
async function implement(job: Job) {
  if (!job.baseSha || !job.config) throw new Error("coding_job_invalid");
  const codexHome =
    job.payload.authMode === "device_code"
      ? jobPath("/auth")
      : jobPath("/task/codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(`${codexHome}/config.toml`, job.config, { mode: 0o600 });
  const env = { ...gitEnv, HOME: jobPath("/task/home"), CODEX_HOME: codexHome };
  await mkdir(env.HOME, { recursive: true });
  // A resumed execution must not reuse the prior failure marker.
  await rm(jobPath("/task/failure-code"), { force: true });
  await rm(jobPath("/task/auth-failure.json"), { force: true });
  await rm(jobPath("/task/conversation-failure.json"), { force: true });
  await rm(jobPath("/task/native-transcript.jsonl"), { force: true });
  const channel =
    process.env.CODEX_TASK_CHANNEL_URL && process.env.CODEX_TASK_CHANNEL_TOKEN
      ? new JobTaskChannel(
          process.env.CODEX_TASK_CHANNEL_URL,
          process.env.CODEX_TASK_CHANNEL_TOKEN,
          fetch,
          jobPath("/task/native-transcript.jsonl"),
          process.env.CODEX_TASK_BROWSER_ENABLED === "true",
        )
      : undefined;
  let channelThread = "";
  if (channel)
    try {
      channelThread = (
        await readFile(jobPath("/task/repodesk-channel-thread"), "utf8")
      ).trim();
    } catch {
      /* Older work volumes reconstruct from durable task context. */
    }
  let diagnostics: string | undefined;
  try {
    diagnostics = (
      await readFile(jobPath("/task/check-diagnostics"), "utf8")
    ).slice(0, 12000);
  } catch {}
  let turn: Awaited<ReturnType<typeof runConversation>>;
  try {
    let reviewSource: ReviewSource | undefined;
    if (job.development.review && job.development.mode !== "work") {
      try {
        reviewSource = await ReviewSource.create(
          repo,
          job.development.review,
          jobPath("/task/open-code-review.json"),
        );
      } catch {
        await writeFile(
          jobPath("/task/failure-code"),
          "coding_review_preparation_failed",
        );
        throw Error("coding_review_preparation_failed");
      }
    }
    turn = await runConversation({
      channel,
      reviewSource,
      cwd: repo,
      binary: process.env.REPODESK_CODEX_BIN,
      env: {
        ...env,
        ...(job.payload.authMode === "provider_key"
          ? { CODEX_TASK_TOKEN: process.env.CODEX_TASK_TOKEN }
          : {}),
      },
      prompt:
        (reviewSource
          ? "Use only repodesk_review_source for repository investigation. Its plan action reads the prepared OCR plan; read and list accept head/base/merge_base revisions, and diff returns the pinned merge-base-to-head diff for a literal path. Follow nextOffset until null for complete content. Runtime filesystem paths and arbitrary shell commands are unavailable. Do not ask the user to restore shell access. Report unavailable committed source as a coverage gap.\n"
          : "") +
        (job.recoveryId
          ? "The previous execution was interrupted by an infrastructure shutdown. Continue from the retained checkout and inspect its existing changes before editing. Preserve authorized partial work. Reconstruct the conversation if its session is unavailable, and run the fixed verification plan in full.\n"
          : "") +
        developmentPrompt(
          job.development,
          diagnostics,
          job.verificationCommands,
          {
            repository: job.payload.repository,
            baseSha: job.baseSha,
            taskRoot: jobPath("/task"),
          },
        ) +
        (job.development.media?.prompt ?? ""),
      images: job.development.media?.images,
      outputSchema: developmentSchema(job.development),
      threadId:
        job.payload.authMode === "device_code"
          ? undefined
          : !channel || channelThread === job.development.threadId
            ? job.development.threadId
            : undefined,
      readOnly: job.development.mode !== "work",
      protectCredentials:
        !!job.development.review && job.development.mode !== "work",
    });
  } catch (error) {
    if (
      job.payload.authMode === "device_code" &&
      error instanceof CodexAuthError
    ) {
      await writeFile(
        jobPath("/task/auth-failure.json"),
        JSON.stringify({
          threadId: error.threadId,
          tokens: error.tokens,
          usageUnknown: error.usageUnknown,
        }),
      );
      await writeFile(
        jobPath("/task/failure-code"),
        "coding_device_auth_required",
      );
    } else if (error instanceof CodexConversationError) {
      await writeFile(
        jobPath("/task/conversation-failure.json"),
        JSON.stringify({
          code: error.code,
          threadId: error.threadId,
          tokens: error.tokens,
          usageUnknown: error.usageUnknown,
          resultIssues: error.resultIssues,
        }),
        { mode: 0o600 },
      );
      await writeFile(jobPath("/task/failure-code"), error.code);
    }
    throw error;
  }
  await writeFile(jobPath("/task/conversation.json"), JSON.stringify(turn));
  if (channel)
    await writeFile(jobPath("/task/repodesk-channel-thread"), turn.threadId, {
      mode: 0o600,
    });
  await writeFile(jobPath("/task/thread-id"), turn.threadId);
  await git(["add", "--all"]);
  await writeFile(
    jobPath("/task/result.patch"),
    await git([
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      job.baseSha,
    ]),
  );
}

async function check(job: Job) {
  if (!job.baseSha) throw new Error("coding_base_invalid");
  const env = { ...gitEnv, HOME: jobPath("/task/home") };
  try {
    await verifyReferenceCheckouts(job.development.referenceSources ?? []);
    for (const check of verificationCommands.parse(job.verificationCommands))
      await command("bash", ["-e", "-o", "pipefail", "-c", check], {
        cwd: repo,
        env,
        stderr: true,
      });
    // Always check patch integrity in addition to the repository-specific plan.
    await verifyReferenceCheckouts(job.development.referenceSources ?? []);
    await git(["diff", "--check", job.baseSha]);
  } catch (error) {
    const raw =
      error && typeof error === "object" && "diagnostics" in error
        ? String(error.diagnostics)
        : "Repository verification failed.";
    const safe = (
      raw.trim() || "Repository verification failed with no output."
    )
      .replace(
        /(bearer\s+|(?:token|api[_-]?key|password|secret)[=:]\s*)[^\s]+/gi,
        "$1[redacted]",
      )
      .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@");
    if (job.development)
      await writeFile(jobPath("/task/check-diagnostics"), safe.slice(0, 12000));
    await writeFile(jobPath("/task/failure-code"), "coding_check_failed");
    throw new Error("coding_check_failed");
  }
  await git(["add", "--all"]);
  const patch = await git([
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    job.baseSha,
  ]);
  if (
    !patch &&
    !job.development?.pr &&
    job.development.objective?.kind !== "release"
  ) {
    await writeFile(jobPath("/task/failure-code"), "coding_patch_empty");
    throw new Error("coding_patch_empty");
  }
  await writeFile(jobPath("/task/result.patch"), patch);
}
async function publish(job: Job) {
  if (!job.baseSha) throw new Error("coding_base_invalid");
  await clone(job);
  if ((await readFile(jobPath("/input/patch"), "utf8")).length)
    await git(["apply", "--index", jobPath("/input/patch")]);
  if (await git(["diff", "--cached", "--name-only", "--", ".github"]))
    throw new Error("coding_workflow_change_denied");
  const branch =
    job.development?.pr?.branch ??
    `codex/repodesk-${job.development?.taskId ?? job.taskId}`;
  const diff = await git(["diff", "--cached", "--name-only"]);
  if (job.development?.pr) {
    const remote = (
      await git(["ls-remote", "origin", `refs/heads/${branch}`], repo, true)
    )
      .trim()
      .split(/\s+/)[0];
    if (remote !== job.development.pr.headSha) {
      await writeFile(
        jobPath("/task/failure-code"),
        "coding_remote_head_changed",
      );
      throw new Error("coding_remote_head_changed");
    }
  }
  if (diff)
    await git([
      "-c",
      "user.name=RepoDesk Codex",
      "-c",
      "user.email=codex@users.noreply.github.com",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Implement maintainer-approved RepoDesk task",
    ]);
  const publishedSha = (await git(["rev-parse", "HEAD"])).trim();
  if (job.development?.pr)
    await git([
      "merge-base",
      "--is-ancestor",
      job.development.pr.headSha,
      publishedSha,
    ]);
  await writeFile(
    jobPath("/task/publication-intent.json"),
    JSON.stringify({ publishedSha }),
  );
  if (diff) {
    try {
      await git(
        publicationPushArgs(branch, job.development?.pr?.headSha),
        repo,
        true,
      );
    } catch (error) {
      const output =
        error && typeof error === "object" && "diagnostics" in error
          ? String(error.diagnostics)
          : "";
      // One explicit ref, confirmed non-fast-forward rejection: no remote write occurred.
      if (
        output.includes("[rejected]") &&
        /\((?:non-fast-forward|fetch first|stale info)\)/.test(output)
      )
        await writeFile(
          jobPath("/task/failure-code"),
          "coding_remote_head_changed",
        );
      throw error;
    }
  }
  if (job.development?.pr) {
    if (!job.development.review)
      await markPullRequestReady(
        job.payload.repository,
        {
          ...job.development.pr,
          headSha: publishedSha,
          baseBranch: job.payload.baseBranch,
        },
        process.env.GITHUB_TOKEN ?? "",
      );
    await writeFile(
      jobPath("/task/publication.json"),
      JSON.stringify({ prUrl: job.development.pr.url, publishedSha }),
    );
    return;
  }
  const result = JSON.parse(
    await readFile(jobPath("/input/conversation.json"), "utf8"),
  ).result as { title: string; body: string };
  const response = await fetch(
    `https://api.github.com/repos/${job.payload.repository}/pulls`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        title: result.title,
        head: branch,
        base: job.payload.baseBranch,
        draft: false,
        body: result.body,
      }),
    },
  );
  if (response.status !== 201) throw new Error("coding_publication_unknown");
  const pr = z
    .object({ number: z.number().int().positive(), draft: z.literal(false) })
    .parse(await response.json());
  await writeFile(
    jobPath("/task/publication.json"),
    JSON.stringify({
      prUrl: `https://github.com/${job.payload.repository}/pull/${pr.number}`,
      publishedSha,
    }),
  );
}
// The export container is trusted code with no credentials and a read-only task volume.
async function exportPatch() {
  const file = await open(
    jobPath("/task/result.patch"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw new Error("coding_patch_too_large");
    const patch = await file.readFile("utf8");
    let threadId: string | undefined;
    try {
      const thread = await open(
        jobPath("/task/thread-id"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await thread.stat();
        if (stat.isFile() && stat.size <= 100) {
          const candidate = (await thread.readFile("utf8")).trim();
          if (/^[a-zA-Z0-9-]{1,100}$/.test(candidate)) threadId = candidate;
        }
      } finally {
        await thread.close();
      }
    } catch {}
    let release: Awaited<ReturnType<typeof exportRelease>> | undefined;
    let releaseInput: string | undefined;
    try {
      releaseInput = await readFile(jobPath("/input/release.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (releaseInput)
      release = await exportRelease(repo, JSON.parse(releaseInput));
    process.stdout.write(JSON.stringify({ patch, threadId, release }));
  } finally {
    await file.close();
  }
}
try {
  const mode = process.argv[2];
  if (mode === "export") await exportPatch();
  else {
    const job = jobSchema.parse(
      JSON.parse(await readFile(jobPath("/input/job.json"), "utf8")),
    );
    await rm(jobPath("/task/interruption.json"), { force: true });
    await rm(jobPath("/task/failure-code"), { force: true });
    watchInterruption(
      job.executionId,
      mode,
      jobPath("/task/interruption.json"),
    );
    if (mode === "prepare") {
      // No implementation can have started in this phase; discard a partial clone.
      if (job.recoveryId) await rm(repo, { recursive: true, force: true });
      await writeFile(jobPath("/task/base-sha"), await clone(job));
      try {
        await prepareReferenceCheckouts(
          job.development.referenceSources ?? [],
          process.env.GITHUB_REFERENCE_TOKEN,
        );
      } catch {
        await writeFile(
          jobPath("/task/failure-code"),
          "coding_reference_source_unavailable",
        );
        throw Error("coding_reference_source_unavailable");
      }
      try {
        if ((await readFile(jobPath("/input/checkpoint.patch"), "utf8")).length)
          await git(["apply", "--index", jobPath("/input/checkpoint.patch")]);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    } else if (mode === "setup") await setup(job);
    else if (mode === "implement") await implement(job);
    else if (mode === "check") await check(job);
    else if (mode === "publish") await publish(job);
    else throw new Error("coding_mode_invalid");
  }
} catch {
  // Do not print child errors, repository output or credential-bearing commands.
  process.stderr.write("Coding task failed.\n");
  process.exitCode = 1;
}
