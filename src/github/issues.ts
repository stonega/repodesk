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
import { audit, authorize, runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type { GitHubApp } from "./app.ts";
import type { GitHubApps } from "./registry.ts";

export const issueInput = z
  .object({
    repositoryId: z.number().int().positive(),
    title: z.string().trim().min(1).max(256),
    // Fits the complete review in one Telegram message, without truncation.
    body: z.string().max(3000),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const issuePayload = issueInput.extend({
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(200),
  installationId: z.number().int().positive(),
});
export type IssueInput = z.infer<typeof issueInput>;

export function issueDestination(w: Workspace, input: IssueInput) {
  requireThat(!w.deletion && !w.settings.paused, "access_denied", 403);
  requireThat(w.github?.installationId, "github_repository_not_connected", 409);
  requireThat(w.github.revision === input.revision, "version_conflict", 409);
  const repo = w.github.repositories.find((r) => r.id === input.repositoryId);
  requireThat(repo, "github_repository_not_connected", 409);
  return issuePayload.parse({
    ...input,
    repository: repo.full_name,
    installationId: w.github.installationId,
  });
}

export function issueApproval(
  w: Workspace,
  actor: string,
  input: IssueInput,
  id = randomUUID(),
): Approval {
  const payload = issueDestination(w, issueInput.parse(input));
  const prior = w.approvals.find((a) => a.id === id);
  if (prior) {
    requireThat(
      prior.kind === "github_issue" &&
        prior.actor === actor &&
        prior.hash === fingerprint(payload),
      "github_issue_request_conflict",
      409,
    );
    return prior;
  }
  const approval: Approval = {
    id,
    actor,
    kind: "github_issue",
    target: String(payload.repositoryId),
    version: payload.revision,
    payload,
    hash: fingerprint(payload),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  w.approvals.push(approval);
  audit(w, actor, "github.issue_proposed", id);
  return approval;
}

export function checkIssueApproval(w: Workspace, approval: Approval) {
  requireThat(
    approval.kind === "github_issue" &&
      fingerprint(approval.payload) === approval.hash,
    "approval_changed",
    409,
  );
  requireThat(
    Date.parse(approval.expiresAt) > Date.now(),
    "approval_expired",
    409,
  );
  const payload = issuePayload.parse(approval.payload);
  const { repository: _, installationId: __, ...input } = payload;
  requireThat(
    fingerprint(issueDestination(w, input)) === approval.hash,
    "approval_stale",
    409,
  );
  authorize(w, approval.actor);
  const run = w.runs.find((r) => r.id === approval.runId);
  requireThat(
    run && run.actor === approval.actor && runAllowed(w, run),
    "run_revoked",
    409,
  );
  return payload;
}

/** The application service owns all external writes; extensions can only propose. */
export class GitHubIssues {
  constructor(
    private store: Store,
    private apps: GitHubApps,
  ) {}

  async send(workspaceId: string, id: string) {
    const snapshot = await this.store.read(workspaceId);
    const candidate = snapshot.approvals.find((a) => a.id === id);
    if (candidate?.kind !== "github_issue" || candidate.decision !== "approved")
      return;
    if (candidate.issue) {
      if (
        candidate.issue.state === "sending" &&
        Date.parse(candidate.issue.startedAt) + 60000 < Date.now()
      ) {
        await this.finish(workspaceId, id, {
          state: "unknown",
          error: "github_issue_outcome_unknown",
        });
      }
      return;
    }
    let app: GitHubApp | undefined;
    let token: string;
    try {
      const payload = checkIssueApproval(snapshot, candidate);
      app = await this.apps.get(snapshot.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      token = (
        await app.installationToken(
          payload.installationId,
          [payload.repositoryId],
          "issues",
        )
      ).token;
    } catch (error) {
      await this.failBeforeSend(workspaceId, id, error);
      return;
    }
    // Commit the reservation before the POST, and recheck authority after token minting.
    const reserved = await this.store.change(workspaceId, async (w, sql) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a?.decision !== "approved" || a.issue) return;
      try {
        const payload = checkIssueApproval(w, a);
        const deployment = await this.store.deployment(sql);
        requireThat(
          deployment.active && !deployment.paused,
          "deployment_paused",
          409,
        );
        a.issue = { state: "sending", startedAt: new Date().toISOString() };
        audit(w, a.actor, "github.issue_sending", id);
        return payload;
      } catch (error) {
        this.recordFailure(w, a, error);
      }
    });
    if (!reserved) return;
    try {
      const result = await app.createIssue(
        token,
        reserved.repository,
        reserved.title,
        reserved.body,
      );
      await this.finish(workspaceId, id, { state: "created", ...result });
    } catch (error) {
      const code =
        error instanceof Fault ? error.code : "github_issue_outcome_unknown";
      await this.finish(workspaceId, id, {
        state: code === "github_issue_outcome_unknown" ? "unknown" : "failed",
        error: code,
      });
    }
  }

  private recordFailure(w: Workspace, a: Approval, error: unknown) {
    a.issue = {
      state: "failed",
      startedAt: new Date().toISOString(),
      error: error instanceof Fault ? error.code : "github_unavailable",
    };
    this.notify(w, a);
  }
  private async failBeforeSend(
    workspaceId: string,
    id: string,
    error: unknown,
  ) {
    await this.store.change(workspaceId, (w) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a && !a.issue) this.recordFailure(w, a, error);
    });
  }
  private async finish(
    workspaceId: string,
    id: string,
    result: Omit<NonNullable<Approval["issue"]>, "startedAt">,
  ) {
    await this.store.change(workspaceId, (w) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a?.issue?.state !== "sending") return;
      Object.assign(a.issue, result);
      this.notify(w, a);
    });
  }
  private notify(w: Workspace, a: Approval) {
    audit(w, a.actor, `github.issue_${a.issue?.state}`, a.id);
    const run = w.runs.find((r) => r.id === a.runId);
    if (!run || !runAllowed(w, run)) return;
    const text =
      a.issue?.state === "created"
        ? `GitHub issue created: ${a.issue.url}`
        : a.issue?.state === "unknown"
          ? "GitHub issue outcome is unknown. Check the repository before submitting a new request; this request will not be retried."
          : `GitHub issue was not submitted (${a.issue?.error}). Check the App's Issues: write permission and repository access before creating a new proposal.`;
    deliver(w, a.actor, run.chatId, text, {
      topicId: run.topicId,
      runId: run.id,
      id: `github-issue:${a.id}:result`,
    });
  }
}
