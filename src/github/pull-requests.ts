import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import {
  type Approval,
  Fault,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import {
  audit,
  authorize,
  eligible,
  runAllowed,
} from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type { GitHubApp } from "./app.ts";
import { recordRepositoryRead } from "./metadata-policy.ts";
import { GitHubApps } from "./registry.ts";
import { authorizeRepository } from "./user-access.ts";

export const pullActionInput = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    number: z.number().int().positive().safe(),
    action: z.enum(["merge", "close"]),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const pullActionPayload = pullActionInput.extend({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive().safe(),
  title: z.string().max(256),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseBranch: z.string().min(1).max(255),
});
type PullActionInput = z.infer<typeof pullActionInput>;
type PullActionPayload = z.infer<typeof pullActionPayload>;
export const pullActionGuidance: Readonly<Record<string, string>> = {
  github_app_permissions_missing:
    "Ask the App owner to grant Contents and Pull requests read/write and accept the updated installation permissions in GitHub.",
  github_pr_access_denied:
    "Check the GitHub App's repository access, accepted write permissions and repository rules.",
  github_access_denied:
    "Check the GitHub App's accepted Pull requests permission and repository access.",
  github_pr_maintainer_required:
    "PR actions require an active workspace owner/admin or a configured maintainer of this repository in enabled Codex settings.",
  github_user_access_denied:
    "Your linked GitHub account needs current write/admin access to this repository. Sync or reconnect your GitHub account after access changes.",
  github_pr_changed: "The PR changed. Review it and request a new proposal.",
  github_pr_closed:
    "The PR is already closed or merged. Check its current state in GitHub.",
  github_pr_draft:
    "The PR is a draft. Mark it ready for review in GitHub before requesting a merge.",
  github_pr_not_mergeable:
    "GitHub could not merge the PR. Check conflicts, required reviews/checks and repository rules.",
  github_pr_rejected:
    "GitHub rejected the action. Check repository rules and the selected merge method before requesting a new proposal.",
};
const pullSnapshot = z.object({
  number: z.number().int().positive().safe(),
  title: z.string().max(256),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean(),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  base: z.object({
    ref: z.string().min(1).max(255),
    repo: z.object({
      id: z.number().int().positive().safe(),
      full_name: z.string(),
    }),
  }),
});

function actionDestination(
  w: Workspace,
  actor: string,
  input: PullActionInput,
) {
  authorize(w, actor);
  requireThat(!w.settings.paused, "access_denied", 403);
  requireThat(
    eligible(w, actor, true) ||
      (w.coding?.settings.enabled &&
        w.coding.settings.repositories.some(
          (r) =>
            r.repositoryId === input.repositoryId &&
            r.maintainers.includes(actor),
        )),
    "github_pr_maintainer_required",
    403,
  );
  authorizeRepository(w, actor, input.repositoryId, true);
  requireThat(w.github?.installationId, "github_repository_not_connected", 409);
  requireThat(w.github.revision === input.revision, "version_conflict", 409);
  const repo = w.github.repositories.find((r) => r.id === input.repositoryId);
  requireThat(
    repo && !repo.archived && !repo.disabled,
    "github_repository_not_connected",
    409,
  );
  requireThat(
    input.action === "merge" || !input.mergeMethod,
    "github_pr_invalid_action",
  );
  return {
    ...input,
    mergeMethod:
      input.action === "merge" ? (input.mergeMethod ?? "merge") : undefined,
    repository: repo.full_name,
    installationId: w.github.installationId,
  };
}

export function checkPullApproval(w: Workspace, a: Approval) {
  requireThat(
    a.kind === "github_pull_request" && fingerprint(a.payload) === a.hash,
    "approval_changed",
    409,
  );
  requireThat(Date.parse(a.expiresAt) > Date.now(), "approval_expired", 409);
  const payload = pullActionPayload.parse(a.payload);
  const {
    title,
    headSha,
    baseBranch,
    repository: _,
    installationId: __,
    ...input
  } = payload;
  requireThat(
    fingerprint({
      ...actionDestination(w, a.actor, input),
      title,
      headSha,
      baseBranch,
    }) === a.hash,
    "approval_stale",
    409,
  );
  const run = w.runs.find((r) => r.id === a.runId);
  requireThat(
    run && run.actor === a.actor && !run.workflowId && runAllowed(w, run),
    "run_revoked",
    409,
  );
  return payload;
}

/** Models can propose; this service alone performs approved external writes. */
export class GitHubPullRequests {
  constructor(
    private store: Store,
    private apps: GitHubApp | GitHubApps,
  ) {}
  private async app(operatorId: string) {
    const app =
      this.apps instanceof GitHubApps
        ? await this.apps.get(operatorId)
        : this.apps;
    requireThat(app, "github_app_not_configured", 409);
    return app;
  }
  private async read(
    app: GitHubApp,
    token: string,
    scope: PullActionInput & { repository: string; installationId: number },
    signal?: AbortSignal,
  ) {
    const pull = pullSnapshot.parse(
      await app.repositoryMetadata(
        token,
        scope.repository,
        "pulls",
        new URLSearchParams(),
        scope.number,
        signal,
      ),
    );
    requireThat(
      pull.number === scope.number &&
        pull.base.repo.id === scope.repositoryId &&
        pull.base.repo.full_name.toLowerCase() ===
          scope.repository.toLowerCase(),
      "github_pr_changed",
      409,
    );
    requireThat(pull.state === "open" && !pull.merged, "github_pr_closed", 409);
    requireThat(
      scope.action !== "merge" || !pull.draft,
      "github_pr_draft",
      409,
    );
    return {
      title: pull.title,
      headSha: pull.head.sha,
      baseBranch: pull.base.ref,
    };
  }
  async propose(
    workspaceId: string,
    runId: string,
    callId: string,
    value: unknown,
    revision: number,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ) {
    const input = pullActionInput.parse({ ...(value as object), revision });
    const target = `${runId}:${callId}`;
    const check = (w: Workspace) => {
      signal.throwIfAborted();
      const run = w.runs.find((r) => r.id === runId);
      requireThat(
        run &&
          run.status === "running" &&
          !run.workflowId &&
          runAllowed(w, run),
        "tool_policy_denied",
        403,
      );
      const scope = actionDestination(w, run.actor, input);
      recordRepositoryRead(w, run, input.repositoryId, revision);
      const prior = w.approvals.find(
        (a) => a.kind === "github_pull_request" && a.target === target,
      );
      if (prior) {
        const {
          title: _,
          headSha: __,
          baseBranch: ___,
          ...saved
        } = pullActionPayload.parse(prior.payload);
        requireThat(
          prior.actor === run.actor &&
            fingerprint(saved) === fingerprint(scope),
          "tool_call_conflict",
          409,
        );
      } else
        requireThat(
          !w.approvals.some(
            (a) =>
              a.actor === run.actor &&
              !a.decision &&
              Date.parse(a.expiresAt) > Date.now(),
          ),
          "resolve_existing_proposal_first",
          409,
        );
      return { scope, run, prior };
    };
    signal.throwIfAborted();
    await guard();
    const w = await this.store.read(workspaceId);
    const initial = check(w);
    if (initial.prior) return initial.prior.id;
    const app = await this.app(w.operatorId);
    const token = await app.installationToken(
      initial.scope.installationId,
      [input.repositoryId],
      "pulls_read",
    );
    signal.throwIfAborted();
    await guard();
    check(await this.store.read(workspaceId));
    const snapshot = await this.read(app, token.token, initial.scope, signal);
    await guard();
    return this.store.change(workspaceId, (w) => {
      const { scope, run, prior } = check(w);
      if (prior) return prior.id;
      requireThat(
        fingerprint(scope) === fingerprint(initial.scope),
        "approval_stale",
        409,
      );
      const payload = pullActionPayload.parse({ ...scope, ...snapshot });
      const a: Approval = {
        id: randomUUID(),
        actor: run.actor,
        runId,
        kind: "github_pull_request",
        target,
        version: revision,
        payload,
        hash: fingerprint(payload),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
      w.approvals.push(a);
      const verb = payload.action === "merge" ? "Merge" : "Close";
      deliver(
        w,
        run.actor,
        run.chatId,
        `${verb} ${payload.repository}#${payload.number}?\n${payload.title}\nhttps://github.com/${payload.repository}/pull/${payload.number}\n\nTarget branch: ${payload.baseBranch}${payload.action === "merge" ? `\nMerge method: ${payload.mergeMethod}\nCommit: ${payload.headSha}` : ""}\n\n${payload.action === "merge" ? "Approving merges this commit into the target branch. GitHub may reject it if repository rules are not satisfied." : "Approving closes this PR without merging or deleting its branch."}`,
        {
          runId,
          topicId: run.topicId,
          id: `github-pr:${a.id}:review`,
          buttons: [
            [
              { text: "Approve", callback_data: `approve:${a.id}` },
              { text: "Reject", callback_data: `reject:${a.id}` },
            ],
          ],
        },
      );
      audit(w, run.actor, "github.pr_proposed", a.id);
      return a.id;
    });
  }
  async send(workspaceId: string, id: string) {
    const w = await this.store.read(workspaceId);
    const candidate = w.approvals.find((a) => a.id === id);
    if (
      candidate?.kind !== "github_pull_request" ||
      candidate.decision !== "approved"
    )
      return;
    if (candidate.pullRequest) {
      if (
        candidate.pullRequest.state === "sending" &&
        Date.parse(candidate.pullRequest.startedAt) + 60000 < Date.now()
      )
        await this.finish(workspaceId, id, {
          state: "unknown",
          error: "github_pr_outcome_unknown",
        });
      return;
    }
    let app: GitHubApp;
    let token: string;
    let payload: PullActionPayload;
    try {
      payload = checkPullApproval(w, candidate);
      app = await this.app(w.operatorId);
      token = (
        await app.installationToken(
          payload.installationId,
          [payload.repositoryId],
          payload.action === "merge" ? "merge" : "pulls_write",
        )
      ).token;
      const snapshot = await this.read(app, token, payload);
      requireThat(
        snapshot.headSha === payload.headSha &&
          snapshot.baseBranch === payload.baseBranch &&
          snapshot.title === payload.title,
        "github_pr_changed",
        409,
      );
    } catch (error) {
      await this.store.change(workspaceId, (w) => {
        const a = w.approvals.find((a) => a.id === id);
        if (a?.decision === "approved" && !a.pullRequest)
          this.fail(w, a, error);
      });
      return;
    }
    const reserved = await this.store.change(workspaceId, async (w, sql) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a?.decision !== "approved" || a.pullRequest) return false;
      try {
        checkPullApproval(w, a);
        const deployment = await this.store.deployment(sql);
        requireThat(
          deployment.active && !deployment.paused,
          "deployment_paused",
          409,
        );
        a.pullRequest = {
          state: "sending",
          startedAt: new Date().toISOString(),
        };
        audit(w, a.actor, "github.pr_sending", id);
        return true;
      } catch (error) {
        this.fail(w, a, error);
        return false;
      }
    });
    if (!reserved) return;
    try {
      const result = await app.actOnPullRequest(
        token,
        payload.repository,
        payload.number,
        payload.action,
        payload.headSha,
        payload.mergeMethod,
      );
      await this.finish(workspaceId, id, result);
    } catch (error) {
      const code =
        error instanceof Fault ? error.code : "github_pr_outcome_unknown";
      await this.finish(workspaceId, id, {
        state: code === "github_pr_outcome_unknown" ? "unknown" : "failed",
        error: code,
      });
    }
  }
  private fail(w: Workspace, a: Approval, error: unknown) {
    a.pullRequest = {
      state: "failed",
      startedAt: new Date().toISOString(),
      error: error instanceof Fault ? error.code : "github_unavailable",
    };
    this.notify(w, a);
  }
  private async finish(
    workspaceId: string,
    id: string,
    result: Omit<NonNullable<Approval["pullRequest"]>, "startedAt">,
  ) {
    await this.store.change(workspaceId, (w) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a?.pullRequest?.state !== "sending") return;
      Object.assign(a.pullRequest, result);
      this.notify(w, a);
    });
  }
  private notify(w: Workspace, a: Approval) {
    audit(w, a.actor, `github.pr_${a.pullRequest?.state}`, a.id);
    const run = w.runs.find((r) => r.id === a.runId);
    if (!run || !runAllowed(w, run)) return;
    const p = pullActionPayload.parse(a.payload);
    const result = a.pullRequest;
    const text =
      result?.state === "merged" || result?.state === "closed"
        ? `PR ${result.state}: ${result.url}`
        : result?.state === "unknown"
          ? `PR action outcome is unknown for ${p.repository}#${p.number}. Check the PR in GitHub before making a new request; this action will not be retried.`
          : `PR action was not completed for ${p.repository}#${p.number}. ${pullActionGuidance[result?.error ?? ""] ?? "Access or configuration changed, or GitHub is unavailable. Check permissions and settings before requesting a new proposal."}`;
    deliver(w, a.actor, run.chatId, text, {
      runId: run.id,
      topicId: run.topicId,
      id: `github-pr:${a.id}:result`,
    });
  }
}
