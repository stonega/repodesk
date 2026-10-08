import { randomUUID } from "node:crypto";
import { branchName } from "../coding/config.ts";
import { developmentRun } from "../coding/development.ts";
import type {
  LocalDeviceAuth,
  LocalRunner,
  LocalStatus,
} from "../coding/local/protocol.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { ModelProviders } from "../models/service.ts";
import { decrypt, fingerprint } from "../setup/credentials.ts";
import { type ReviewTask, reviewTerminal } from "./config.ts";
import { progressMarker, ReviewGitHub, reviewMarker } from "./github.ts";
import { checkReview } from "./policy.ts";

const reason = (error: unknown) =>
  error instanceof Fault ? error.code : "review_failed";
const busy = (t: ReviewTask) =>
  ["starting", "running", "ready", "publishing", "auth_required"].includes(
    t.state,
  );
export class ReviewExecutor {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private runner?: LocalRunner,
    private key?: string,
  ) {}
  async tick(workspaceId: string) {
    await this.prune(workspaceId);
    const w = await this.store.read(workspaceId);
    for (const task of w.reviewTasks ?? [])
      if (
        (!reviewTerminal(task.state) ||
          (task.state === "unknown" &&
            task.publicationReserved &&
            task.mode === "review" &&
            !task.reviewId)) &&
        Date.parse(task.nextPollAt ?? "1970-01-01") <= Date.now()
      )
        await this.advance(workspaceId, task.id);
  }
  private async guard(workspaceId: string, task: ReviewTask) {
    const w = await this.store.read(workspaceId);
    checkReview(w, task);
    const d = await this.store.deployment();
    requireThat(d.active && !d.paused, "deployment_paused", 409);
    return w;
  }
  private async github(workspaceId: string, task: ReviewTask, write = false) {
    const w = await this.guard(workspaceId, task);
    const app = await this.apps.get(w.operatorId);
    requireThat(app, "github_app_not_configured", 409);
    const token = await app.installationToken(
      task.payload.installationId,
      [task.payload.repositoryId],
      write ? "review" : "coding_read",
    );
    await this.guard(workspaceId, task);
    return new ReviewGitHub(app, token.token, task.payload.repository);
  }
  private async sources(task: ReviewTask, github: ReviewGitHub) {
    const context: string[] = [];
    for (const source of task.sources) {
      const current = await github.source(source.kind, source.id);
      requireThat(
        current.user.id === source.githubId &&
          fingerprint(current.body) === source.hash &&
          (source.kind === "issue"
            ? current.issue_url
            : current.pull_request_url) ===
            `https://api.github.com/repos/${task.payload.repository}/${source.kind === "issue" ? "issues" : "pulls"}/${task.number}`,
        "review_source_changed",
        409,
      );
      context.push(JSON.stringify(current));
      if (current.in_reply_to_id) {
        const parent = await github.source("review", current.in_reply_to_id);
        requireThat(
          parent.pull_request_url ===
            `https://api.github.com/repos/${task.payload.repository}/pulls/${task.number}`,
          "review_source_changed",
          409,
        );
        context.push(
          `Referenced review comment (data): ${JSON.stringify(parent)}`,
        );
      }
    }
    return context.join("\n").slice(0, 16000);
  }
  private async update(
    workspaceId: string,
    id: string,
    lease: string,
    action: (task: ReviewTask, w: Workspace) => void,
  ) {
    return this.store.change(workspaceId, (w) => {
      const t = w.reviewTasks?.find((t) => t.id === id);
      if (!t || t.lease !== lease) return undefined;
      action(t, w);
      t.updatedAt = new Date().toISOString();
      return structuredClone(t);
    });
  }
  private async reserve(
    workspaceId: string,
    task: ReviewTask,
    lease: string,
    state: ReviewTask["state"],
  ) {
    return this.store.change(workspaceId, async (w, sql) => {
      const t = w.reviewTasks?.find((t) => t.id === task.id);
      if (!t || t.lease !== lease || t.cancelRequested) return false;
      checkReview(w, t);
      const d = await this.store.deployment(sql);
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      t.state = state;
      if (state === "publishing") t.publicationReserved = true;
      t.updatedAt = new Date().toISOString();
      return true;
    });
  }
  async advance(workspaceId: string, id: string) {
    const lease = randomUUID();
    const task = await this.store.change(workspaceId, async (w, sql) => {
      const t = w.reviewTasks?.find((t) => t.id === id);
      if (
        !t ||
        (reviewTerminal(t.state) &&
          !(
            t.state === "unknown" &&
            t.publicationReserved &&
            t.mode === "review" &&
            !t.reviewId
          )) ||
        Date.parse(t.leaseUntil ?? "1970-01-01") > Date.now()
      )
        return;
      if (
        t.state === "queued" &&
        !t.statusOnly &&
        w.reviewTasks?.some(
          (other) =>
            other.id !== t.id &&
            other.number === t.number &&
            other.payload.repositoryId === t.payload.repositoryId &&
            busy(other),
        )
      )
        return;
      if (t.state === "queued" && !t.statusOnly) {
        const development = await sql.query(
          "SELECT 1 FROM coding_tasks WHERE workspace_id=$1 AND data->'payload'->>'repositoryId'=$2 AND data->'pr'->>'number'=$3 AND data->>'state' IN ('queued','working','publishing','auth_required') LIMIT 1",
          [w.id, String(t.payload.repositoryId), String(t.number)],
        );
        if (development.rowCount) return;
      }
      const d = await this.store.deployment(sql);
      if (!d.active || d.paused || w.settings.paused) {
        if (
          ["queued", "waiting", "auth_required"].includes(t.state) ||
          reviewTerminal(t.state)
        )
          return;
        t.cancelRequested = true;
        t.error = "review_paused";
      }
      t.lease = lease;
      t.leaseUntil = new Date(Date.now() + 60000).toISOString();
      return structuredClone(t);
    });
    if (!task) return;
    try {
      if (task.cancelRequested) {
        if (
          task.publicationReserved &&
          ["publishing", "unknown"].includes(task.state) &&
          task.mode === "review"
        ) {
          const github = await this.github(workspaceId, {
            ...task,
            cancelRequested: false,
          });
          const reviewId = await github.find(
            task.number,
            "review",
            reviewMarker(task),
            task.headSha,
          );
          await this.update(workspaceId, id, lease, (t) => {
            t.reviewId = reviewId;
            t.state = reviewId ? "completed" : "unknown";
            t.error = reviewId ? undefined : "review_publication_unknown";
          });
          return;
        }
        if (
          this.runner &&
          [
            "starting",
            "running",
            "ready",
            "auth_required",
            "publishing",
          ].includes(task.state)
        ) {
          try {
            const status = await this.runner.status(
              workspaceId,
              task.attemptId,
            );
            if (status.state === "publishing" || task.state === "publishing") {
              await this.poll(workspaceId, task, lease);
              return;
            }
            await this.runner.cancel(workspaceId, task.attemptId);
          } catch (error) {
            if (reason(error) !== "coding_task_not_found") throw error;
          }
        }
        await this.update(workspaceId, id, lease, (t) => {
          t.state = "cancelled";
        });
        return;
      }
      await this.guard(workspaceId, task);
      if (task.statusOnly) {
        await this.update(workspaceId, id, lease, (t, w) => {
          const candidates = [...(w.reviewTasks ?? [])]
            .reverse()
            .filter(
              (other) =>
                !other.statusOnly &&
                other.number === t.number &&
                other.payload.repositoryId === t.payload.repositoryId,
            );
          const current =
            candidates.find((other) => !reviewTerminal(other.state)) ??
            candidates[0];
          const summary = current
            ? `The ${current.mode} task is ${current.cancelRequested ? "stopping" : current.state.replaceAll("_", " ")}.${current.result?.question ? `\n${current.result.question}` : ""}${current.publishedSha ? `\nPublished commit: ${current.publishedSha}` : ""}`
            : "There is no recorded Review Bot task for this PR.";
          t.result = {
            status: "analysis",
            intent: "analyze",
            evidenceRevision: t.revision,
            evidence: t.inputs.at(-1)?.text ?? "status",
            publishRequested: false,
            summary,
            question: null,
            title: "PR task status",
            body: "",
            verificationCommands: [],
          };
          t.state = "completed";
        });
        return;
      }
      if (
        task.state === "unknown" ||
        (task.state === "publishing" && task.mode === "review")
      ) {
        const github = await this.github(workspaceId, task);
        const reviewId = await github.find(
          task.number,
          "review",
          reviewMarker(task),
          task.headSha,
        );
        await this.update(workspaceId, id, lease, (t) => {
          t.state = reviewId ? "completed" : "unknown";
          t.reviewId = reviewId;
          t.error = reviewId ? undefined : "review_publication_unknown";
        });
        return;
      }
      requireThat(this.runner, "coding_runner_not_configured", 409);
      await this.progress(workspaceId, task, lease);
      if (task.state === "waiting") return;
      if (task.state === "queued" || task.state === "starting")
        await this.start(workspaceId, task, lease);
      else if (task.state === "ready")
        await this.publish(workspaceId, task, lease);
      else await this.poll(workspaceId, task, lease);
    } catch (error) {
      const code = reason(error);
      await this.update(workspaceId, id, lease, (t) => {
        t.error = code;
        if (code === "coding_device_auth_required") t.state = "auth_required";
        else if (
          [
            "coding_runner_busy",
            "coding_runner_unavailable",
            "github_unavailable",
          ].includes(code) &&
          !["publishing"].includes(t.state)
        ) {
          // Reads and stable-ID runner starts can be retried; remote writes cannot.
        } else if (
          t.publicationReserved &&
          ["publishing", "unknown"].includes(t.state)
        ) {
          t.state = "unknown";
          t.error = "review_publication_unknown";
        } else
          t.state = [
            "review_configuration_changed",
            "review_cancelled",
            "access_denied",
            "github_user_access_denied",
            "review_source_changed",
            "coding_configuration_changed",
          ].includes(code)
            ? "cancelled"
            : "failed";
      });
      // Revoke an already running local attempt even when the permission check failed.
      if (
        this.runner &&
        ["starting", "running", "ready", "auth_required"].includes(
          task.state,
        ) &&
        ![
          "coding_runner_busy",
          "coding_runner_unavailable",
          "github_unavailable",
          "coding_device_auth_required",
        ].includes(code)
      )
        try {
          await this.runner.cancel(workspaceId, task.attemptId);
        } catch {}
    } finally {
      const current = (await this.store.read(workspaceId)).reviewTasks?.find(
        (t) => t.id === id,
      );
      if (current?.lease === lease) {
        try {
          await this.progress(workspaceId, current, lease);
        } catch {}
        await this.update(workspaceId, id, lease, (t) => {
          t.lease = undefined;
          t.leaseUntil = undefined;
          t.nextPollAt = new Date(Date.now() + 5000).toISOString();
        });
      }
    }
  }
  private async start(workspaceId: string, task: ReviewTask, lease: string) {
    const runner = this.runner;
    requireThat(runner, "coding_runner_not_configured", 409);
    if (task.state === "starting") {
      try {
        await this.poll(workspaceId, task, lease);
        return;
      } catch (error) {
        if (reason(error) !== "coding_task_not_found") throw error;
      }
    }
    const github = await this.github(workspaceId, task);
    const pull = await github.pull(task.number);
    requireThat(
      pull.state === "open" && !pull.merged && (!task.automatic || !pull.draft),
      "coding_pr_closed",
      409,
    );
    if (task.automatic && task.headSha !== pull.head.sha) {
      await this.update(workspaceId, task.id, lease, (t) => {
        t.state = "cancelled";
        t.error = "review_head_changed";
      });
      return;
    }
    if (task.mode === "fix")
      requireThat(
        pull.head.repo?.full_name === task.payload.repository &&
          pull.base.ref === task.payload.baseBranch,
        "coding_pr_target_changed",
        409,
      );
    const sources = await this.sources(task, github);
    const w = await this.guard(workspaceId, task);
    const previousReview = [...(w.reviewTasks ?? [])]
      .reverse()
      .find(
        (t) =>
          t.id !== task.id &&
          t.number === task.number &&
          t.payload.repositoryId === task.payload.repositoryId &&
          t.mode === "review" &&
          t.result,
      );
    if (task.run?.review && task.run.review.headSha !== pull.head.sha) {
      await this.update(workspaceId, task.id, lease, (t) => {
        t.state = "queued";
        t.run = undefined;
        t.attemptIds ??= [];
        t.attemptIds.push(t.attemptId);
        t.attemptId = randomUUID();
        t.previousAttemptId = undefined;
      });
      return;
    }
    const run =
      task.run ??
      developmentRun.parse({
        taskId: task.id,
        revision: task.revision,
        mode: task.mode === "fix" ? "work" : "analysis",
        inputs: task.inputs,
        context: `PR title: ${pull.title.slice(0, 200)}\nDescription: ${(pull.body ?? "").slice(0, 8000)}\nAddressed comments (reference): ${sources}\nPrevious review (reference, may describe an older commit): ${JSON.stringify(previousReview?.result ?? null).slice(0, 8000)}\nPrevious task result: ${JSON.stringify(task.result ?? null).slice(0, 6000)}`,
        previousAttemptId: task.previousAttemptId,
        review: {
          number: task.number,
          headSha: pull.head.sha,
          baseSha: pull.base.sha,
          action: task.mode,
        },
        pr:
          task.mode === "fix"
            ? {
                number: task.number,
                url: `https://github.com/${task.payload.repository}/pull/${task.number}`,
                branch: branchName.parse(pull.head.ref),
                headSha: pull.head.sha,
              }
            : undefined,
      });
    // Persist the entire stable-ID start payload before dispatch. Replays stay identical.
    const saved = await this.update(workspaceId, task.id, lease, (t) => {
      t.run = run;
      t.headSha = run.review?.headSha;
      t.baseSha = run.review?.baseSha;
      t.payload.baseBranch = branchName.parse(pull.base.ref);
      t.consumedRevision = run.revision;
    });
    if (!saved || !(await this.reserve(workspaceId, saved, lease, "starting")))
      return;
    let providerApiKey: string | undefined;
    if (w.coding?.providerApiKey) {
      requireThat(this.key, "coding_credentials_unavailable", 503);
      providerApiKey = decrypt(
        this.key,
        `coding-provider:${w.id}`,
        w.coding.providerApiKey,
      );
    }
    const codingModel =
      w.coding?.settings.authMode === "provider_key"
        ? w.coding.settings.model
        : undefined;
    const selection =
      task.mode === "fix"
        ? codingModel
        : (w.reviewBot?.settings.model ?? codingModel);
    const sharedProvider = selection
      ? await new ModelProviders(this.store, this.key ?? "").runner(
          w,
          selection,
        )
      : {};
    if (
      sharedProvider.modelProvider &&
      !(await this.update(workspaceId, task.id, lease, (t) => {
        t.runnerModel = sharedProvider.modelProvider;
      }))
    )
      return;
    await runner.start({
      workspaceId,
      taskId: task.attemptId,
      payload: {
        ...saved.payload,
        ...(selection ? { authMode: "provider_key" as const } : {}),
      },
      readToken: github.token,
      providerApiKey,
      ...sharedProvider,
      development: run,
    });
    await this.update(workspaceId, task.id, lease, (t) => {
      t.state = "running";
      t.error = undefined;
    });
  }
  private async poll(workspaceId: string, task: ReviewTask, lease: string) {
    const runner = this.runner;
    requireThat(runner, "coding_runner_not_configured", 409);
    let status: LocalStatus;
    try {
      status = await runner.status(workspaceId, task.attemptId);
    } catch (error) {
      if (
        task.state === "auth_required" &&
        reason(error) === "coding_task_not_found"
      ) {
        const device = runner as LocalRunner & Partial<LocalDeviceAuth>;
        if (
          device.deviceStatus &&
          (await device.deviceStatus(workspaceId)).state === "connected"
        )
          await this.update(workspaceId, task.id, lease, (t) => {
            t.state = "queued";
          });
        return;
      }
      throw error;
    }
    if (status.state === "auth_required") {
      const device = runner as LocalRunner & Partial<LocalDeviceAuth>;
      if (
        device.deviceStatus &&
        runner.resumeAuth &&
        (await device.deviceStatus(workspaceId)).state === "connected"
      ) {
        await runner.resumeAuth(workspaceId, task.attemptId);
        status = await runner.status(workspaceId, task.attemptId);
      }
    }
    await this.update(workspaceId, task.id, lease, (t) => {
      if (
        ["preparing", "running"].includes(status.state) &&
        t.state !== "publishing"
      )
        t.state = "running";
      t.tokens = status.tokens;
      t.usageUnknown = status.usageUnknown;
      if (
        status.state === "failed" &&
        status.error === "coding_remote_head_changed" &&
        task.mode === "fix"
      ) {
        t.attemptIds ??= [];
        t.attemptIds.push(t.attemptId);
        t.attemptId = randomUUID();
        t.run = undefined;
        t.previousAttemptId = undefined;
        t.headSha = undefined;
        t.publicationReserved = undefined;
        t.state = "queued";
        t.error = "review_head_changed";
        return;
      }
      if (status.state === "auth_required") {
        t.state = "auth_required";
        t.error = "coding_device_auth_required";
      } else if (["failed", "cancelled", "unknown"].includes(status.state)) {
        t.state = status.state as ReviewTask["state"];
        t.error = status.error;
      } else if (status.state === "ready" || status.state === "succeeded") {
        requireThat(status.result, "coding_result_invalid", 409);
        t.result = status.result;
        if (
          status.state === "succeeded" &&
          task.mode === "fix" &&
          task.state === "publishing"
        ) {
          requireThat(
            status.prUrl === task.run?.pr?.url && status.publishedSha,
            "coding_publication_unknown",
            409,
          );
          t.state = "completed";
          t.publishedSha = status.publishedSha;
          t.prUrl = status.prUrl;
        } else if (status.result.status === "needs_input") {
          t.state = "waiting";
          t.progress ??= { state: "pending" };
        } else {
          requireThat(
            task.mode !== "fix" ||
              (status.state === "ready" &&
                status.checkPassed &&
                status.result.status === "completed"),
            "coding_check_failed",
            409,
          );
          t.state = "ready";
        }
      }
    });
  }
  private async publish(workspaceId: string, task: ReviewTask, lease: string) {
    const github = await this.github(workspaceId, task, true);
    await this.sources(task, github);
    const pull = await github.pull(task.number);
    requireThat(
      pull.state === "open" && !pull.merged && (!task.automatic || !pull.draft),
      "coding_pr_closed",
      409,
    );
    if (pull.head.sha !== task.headSha) {
      if (task.mode === "fix")
        await this.runner?.cancel(workspaceId, task.attemptId);
      await this.update(workspaceId, task.id, lease, (t) => {
        t.state = t.automatic ? "cancelled" : "queued";
        t.error = "review_head_changed";
        t.run = undefined;
        t.previousAttemptId = undefined;
        t.attemptIds ??= [];
        t.attemptIds.push(t.attemptId);
        t.attemptId = randomUUID();
        t.headSha = undefined;
      });
      return;
    }
    if (task.mode === "fix") {
      requireThat(
        pull.head.repo?.full_name === task.payload.repository &&
          pull.head.ref === task.run?.pr?.branch &&
          pull.base.ref === task.payload.baseBranch,
        "coding_pr_target_changed",
        409,
      );
      const w = await this.guard(workspaceId, task);
      const app = await this.apps.get(w.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      const token = await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        "publish",
      );
      if (!(await this.reserve(workspaceId, task, lease, "publishing"))) return;
      await this.runner?.publish(workspaceId, task.attemptId, token.token);
    } else if (task.mode === "review") {
      const payload = await github.review(task);
      // File reads may race a force-push. Recheck immediately before the reservation.
      requireThat(
        (await github.pull(task.number)).head.sha === task.headSha,
        "review_head_changed",
        409,
      );
      if (!(await this.reserve(workspaceId, task, lease, "publishing"))) return;
      const review = await github.publishReview(task, payload);
      await this.update(workspaceId, task.id, lease, (t) => {
        t.reviewId = review.id;
        t.state = "completed";
        t.error = undefined;
      });
    } else
      await this.update(workspaceId, task.id, lease, (t) => {
        t.state = "completed";
      });
  }
  private body(task: ReviewTask) {
    const states: Record<ReviewTask["state"], string> = {
      queued: "Your request is queued.",
      starting: "Preparing the PR checkout…",
      running:
        task.mode === "fix"
          ? "Working on the requested changes and checks…"
          : "Reviewing the PR…",
      auth_required:
        "This task is paused until Codex is reconnected in RepoDesk.",
      waiting: `I need your input: ${task.result?.question ?? "Please clarify the requested change."}\nReply here and mention the bot to continue.`,
      ready:
        task.mode === "fix"
          ? "Checks are complete. Preparing the result…"
          : "Preparing the review result…",
      publishing: "Publishing the result…",
      completed: task.result?.summary ?? "Your request is complete.",
      failed: `I couldn’t finish this request (${task.error ?? "review_failed"}). Check the task in RepoDesk before retrying.`,
      cancelled: "This task has stopped.",
      unknown: task.publicationReserved
        ? "The publication outcome needs an operator’s check. I will not repeat the write automatically."
        : "The execution outcome needs an operator’s check before this task can continue.",
    };
    return `**Review Bot** — PR #${task.number}\n\n${states[task.state]}${task.publishedSha ? `\n\nCommit: [${task.publishedSha.slice(0, 7)}](https://github.com/${task.payload.repository}/commit/${task.publishedSha})` : ""}\n\n${progressMarker(task)}`;
  }
  private async progress(workspaceId: string, task: ReviewTask, lease: string) {
    if (!task.progress) return;
    const safe = { ...task, cancelRequested: false };
    const github = await this.github(workspaceId, safe, true);
    await this.sources(task, github);
    const body = this.body(task);
    if (task.progress.body === body && task.progress.state === "sent") return;
    if (
      ["sending", "unknown"].includes(task.progress.state) &&
      !task.progress.id
    ) {
      const id = await github.find(
        task.number,
        "progress",
        progressMarker(task),
      );
      await this.update(workspaceId, task.id, lease, (t) => {
        if (t.progress) {
          t.progress.id = id;
          t.progress.state = id ? "sent" : "unknown";
        }
      });
      if (!id) return;
      task = { ...task, progress: { ...task.progress, id, state: "sent" } };
    }
    const reserved = await this.store.change(workspaceId, async (w, sql) => {
      const t = w.reviewTasks?.find((t) => t.id === task.id);
      if (!t || t.lease !== lease || !t.progress) return false;
      checkReview(w, { ...t, cancelRequested: false });
      const d = await this.store.deployment(sql);
      requireThat(d.active && !d.paused, "deployment_paused", 409);
      t.progress.state = "sending";
      return true;
    });
    if (!reserved) return;
    try {
      const sent = await github.progress(task, body);
      await this.update(workspaceId, task.id, lease, (t) => {
        if (t.progress) t.progress = { state: "sent", id: sent.id, body };
      });
    } catch {
      await this.update(workspaceId, task.id, lease, (t) => {
        if (t.progress) t.progress.state = "unknown";
      });
    }
  }
  private async prune(workspaceId: string) {
    const snapshot = await this.store.read(workspaceId);
    if (!snapshot.reviewTasks?.length && !snapshot.reviewCleanup?.length)
      return;
    const cleanup = await this.store.change(workspaceId, (w) => {
      const cutoff = Date.now() - w.settings.retentionDays * 86400000;
      const removed = (w.reviewTasks ?? []).filter(
        (t) => w.deletion || Date.parse(t.createdAt) < cutoff,
      );
      w.reviewCleanup = [
        ...new Set([
          ...(w.reviewCleanup ?? []),
          ...removed.flatMap((t) => [...(t.attemptIds ?? []), t.attemptId]),
        ]),
      ];
      if (w.deletion) {
        delete w.reviewTasks;
        delete w.reviewBot;
      } else
        w.reviewTasks = (w.reviewTasks ?? []).filter(
          (t) => !removed.some((r) => r.id === t.id),
        );
      return [...w.reviewCleanup];
    });
    for (const attemptId of cleanup) {
      if (!this.runner?.erase) continue;
      try {
        try {
          await this.runner.cancel(workspaceId, attemptId);
        } catch (error) {
          if (reason(error) !== "coding_task_not_found") throw error;
        }
        await this.runner.erase(workspaceId, attemptId);
        await this.store.change(workspaceId, (w) => {
          w.reviewCleanup = w.reviewCleanup?.filter((id) => id !== attemptId);
        });
      } catch {
        /* Keep the content-free cleanup intent for a later worker tick. */
      }
    }
    await this.store.pool.query(
      "DELETE FROM review_bot_receipts WHERE workspace_id=$1 AND accepted_at<now()-interval '30 days'",
      [workspaceId],
    );
  }
}
