import { createHash, randomUUID } from "node:crypto";
import type { DevelopmentTask } from "../coding/development.ts";
import { codingFailureMessage } from "../coding/failure-messages.ts";
import {
  releaseFlagAuthorized,
  releaseVersionAuthorized,
} from "../coding/objective.ts";
import {
  taskEvent,
  taskGet,
  taskInputs,
  taskSave,
} from "../coding/task-store.ts";
import { notifyDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { hashMemory } from "../memory/state.ts";
import { ReleaseGitHub } from "./github.ts";
import { type PreparedRelease, preparedRelease } from "./types.ts";

type Guard = (
  w: Workspace,
  sql: Sql,
  task: DevelopmentTask,
) => Promise<unknown>;
export const releasePayloadHash = (p: PreparedRelease) =>
  hashMemory([
    p.targetSha,
    p.inputRevision,
    p.proposal.tag,
    p.proposal.name,
    p.proposal.body,
    p.proposal.draft,
    p.proposal.prerelease,
    p.proposal.ciRequired,
    p.proposal.procedures,
    p.proposal.assets.map((a) => [a.name, a.path]),
    p.proposal.unsupported,
    p.procedures.map((d) => [d.path, d.digest]),
    p.assets.map((a) => [a.name, a.digest]),
  ]);

/** Advances only application-owned effects of an already verified repository task. */
export class RepositoryReleases {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private transport?: typeof fetch,
  ) {}

  async advance(workspaceId: string, taskId: string, guard: Guard) {
    const lease = randomUUID();
    const task = await this.store.change(workspaceId, async (w, sql) => {
      const t = await taskGet(sql, workspaceId, taskId);
      if (
        t.objective?.kind !== "release" ||
        !t.release ||
        !t.release.publishAuthorized ||
        t.state !== "review" ||
        t.revision !== t.release.revision ||
        t.cleanupAttemptId ||
        t.attemptId ||
        t.release.state === "published" ||
        t.release.state === "blocked" ||
        t.cancelRequested ||
        t.contentRemoved ||
        Date.parse(t.release.nextPollAt ?? "1970-01-01") > Date.now() ||
        Date.parse(t.leaseUntil ?? "1970-01-01") > Date.now()
      )
        return;
      try {
        await guard(w, sql, t);
      } catch {
        t.cancelRequested = true;
        t.state = "cancelled";
        await taskSave(sql, t);
        return;
      }
      requireThat(
        t.revision === t.release.revision,
        "coding_release_revision_changed",
        409,
      );
      t.lease = lease;
      t.leaseUntil = new Date(Date.now() + 120000).toISOString();
      await taskSave(sql, t);
      return structuredClone(t);
    });
    if (!task?.release) return false;
    const update = async (
      action: (
        w: Workspace,
        sql: Sql,
        t: DevelopmentTask,
      ) => Promise<void> | void,
    ) =>
      this.store.change(workspaceId, async (w, sql) => {
        const t = await taskGet(sql, workspaceId, taskId);
        requireThat(
          t.lease === lease &&
            t.release &&
            t.release.revision === task.release?.revision &&
            t.revision === task.revision,
          "coding_release_stale",
          409,
        );
        await guard(w, sql, t);
        await action(w, sql, t);
        t.leaseUntil = new Date(Date.now() + 120000).toISOString();
        await taskSave(sql, t);
      });
    try {
      const p = preparedRelease.parse(task.release.prepared);
      let assetBytes = 0;
      for (const file of p.assets) {
        const bytes = Buffer.from(file.data, "base64");
        assetBytes += bytes.length;
        requireThat(
          bytes.toString("base64") === file.data &&
            createHash("sha256").update(bytes).digest("hex") === file.digest &&
            assetBytes <= 1024 * 1024,
          "coding_release_asset_invalid",
          409,
        );
      }
      const inputs = await taskInputs(this.store.pool, task);
      requireThat(
        releaseVersionAuthorized(inputs, p.proposal.tag),
        "coding_release_intent_required",
        403,
      );
      requireThat(
        task.objective?.kind === "release",
        "coding_release_intent_required",
        403,
      );
      requireThat(
        !task.objective.version ||
          task.objective.version.replace(/^v/, "") ===
            p.proposal.tag.replace(/^v/, ""),
        "coding_release_version_conflict",
        409,
      );
      requireThat(
        !p.proposal.draft ||
          releaseFlagAuthorized(inputs, "draft", p.proposal.tag),
        "coding_release_draft_not_requested",
        409,
      );
      requireThat(
        !p.proposal.prerelease ||
          releaseFlagAuthorized(inputs, "prerelease", p.proposal.tag),
        "coding_release_channel_not_requested",
        409,
      );
      requireThat(
        p.proposal.unsupported.length === 0,
        "coding_release_unsupported_step",
        409,
      );
      const w = await this.store.read(workspaceId);
      const app = await this.apps.get(w.operatorId);
      requireThat(app, "github_app_not_configured", 409);
      const credential = await app.installationToken(
        task.payload.installationId,
        [task.payload.repositoryId],
        "release",
      );
      const github = this.transport
        ? new ReleaseGitHub(
            task.payload.repository,
            credential.token,
            this.transport,
          )
        : app.releaseClient(task.payload.repository, credential.token);
      if (task.release.state === "waiting_merge" && task.release.pr) {
        const pr = await github.mergedPull(
          task.release.pr.number,
          task.release.pr.headSha,
        );
        requireThat(
          pr.base.ref === task.payload.baseBranch,
          "coding_release_target_changed",
          409,
        );
        if (!pr.merged) {
          await update((_w, _sql, t) => {
            if (t.release)
              t.release.nextPollAt = new Date(Date.now() + 60000).toISOString();
          });
          return true;
        }
        await update(async (_w, sql, t) => {
          await taskEvent(
            sql,
            t,
            `release-merge:${t.revision}:${pr.merge_commit_sha}`,
            { pr: task.release?.pr, sha: pr.merge_commit_sha },
          );
          t.state = "queued";
          t.phase = "work";
          t.pr = undefined;
          t.release = undefined;
          t.releasePrerequisite = undefined;
          t.previousAttemptId = undefined;
        });
        return true;
      }
      if (p.proposal.ciRequired) {
        const readCredential = await app.installationToken(
          task.payload.installationId,
          [task.payload.repositoryId],
          "release_read",
        );
        const ci = await (this.transport
          ? new ReleaseGitHub(
              task.payload.repository,
              readCredential.token,
              this.transport,
            )
          : app.releaseClient(task.payload.repository, readCredential.token)
        ).ci(p.targetSha);
        if (
          ci === "failed" &&
          (task.releaseCiFailure?.sha !== p.targetSha ||
            task.releaseCiFailure.revision !== task.revision)
        ) {
          await update((_w, _sql, t) => {
            t.releaseCiFailure = { sha: p.targetSha, revision: t.revision };
            if (t.result)
              t.result.summary = `Required remote checks failed at ${p.targetSha}. Inspect the repository CI configuration and reproduce/repair the failure within this release goal. If the failure is an unavailable application prerequisite, return the environment blocker; do not claim completion with unchanged failing CI.`;
            t.release = undefined;
            t.state = "queued";
            t.phase = "work";
          });
          return true;
        }
        requireThat(ci !== "failed", "coding_release_ci_failed", 409);
        if (ci === "pending") {
          await update((_w, _sql, t) => {
            if (t.release) {
              t.release.state = "waiting_ci";
              t.release.nextPollAt = new Date(Date.now() + 60000).toISOString();
            }
          });
          return true;
        }
      }
      const action = async (
        id: string,
        inspect: () => Promise<unknown>,
        execute: () => Promise<void>,
      ) => {
        const target = hashMemory([
          task.payload.repositoryId,
          p.proposal.tag.replace(/^v/, ""),
          id,
        ]);
        const payload = releasePayloadHash(p);
        let state = "reserved";
        await update(async (_w, sql, t) => {
          requireThat(!t.cancelRequested, "coding_cancelled", 409);
          await sql.query(
            "INSERT INTO repository_release_actions(workspace_id,task_id,action_id,target_hash,payload_hash,state) VALUES($1,$2,$3,$4,$5,'reserved') ON CONFLICT DO NOTHING",
            [workspaceId, taskId, id, target, payload],
          );
          const row = (
            await sql.query(
              "SELECT task_id,payload_hash,state FROM repository_release_actions WHERE workspace_id=$1 AND target_hash=$2 FOR UPDATE",
              [workspaceId, target],
            )
          ).rows[0];
          requireThat(
            row?.task_id === taskId && row.payload_hash === payload,
            "coding_release_target_conflict",
            409,
          );
          state = row.state;
        });
        const existing = await inspect();
        if (!existing) {
          requireThat(
            state === "reserved",
            "coding_release_outcome_unknown",
            409,
          );
          requireThat(
            (await github.branch(task.payload.baseBranch)) === p.targetSha,
            "coding_release_target_changed",
            409,
          );
          await update(async (_w, sql) => {
            await sql.query(
              "UPDATE repository_release_actions SET state='dispatched',updated_at=now() WHERE workspace_id=$1 AND task_id=$2 AND action_id=$3",
              [workspaceId, taskId, id],
            );
          });
          await execute();
        }
        const receipt = existing ?? (await inspect());
        requireThat(receipt, "coding_release_outcome_unknown", 409);
        await update(async (_w, sql) => {
          await sql.query(
            "UPDATE repository_release_actions SET state='confirmed',data=$4,updated_at=now() WHERE workspace_id=$1 AND task_id=$2 AND action_id=$3",
            [
              workspaceId,
              taskId,
              id,
              JSON.stringify({
                receipt,
                origin:
                  existing && state === "reserved"
                    ? "pre-existing"
                    : "task-created",
              }),
            ],
          );
        });
      };
      await action(
        "tag",
        async () => {
          const commit = await github.tag(p.proposal.tag);
          requireThat(
            !commit || commit === p.targetSha,
            "coding_release_tag_conflict",
            409,
          );
          return commit ? { commit } : undefined;
        },
        () => github.createTag(p.proposal.tag, p.targetSha),
      );
      await action(
        "release",
        async () => {
          const found = await github.readRelease(p.proposal.tag);
          requireThat(
            !found ||
              (found.tag_name === p.proposal.tag &&
                found.name === p.proposal.name &&
                (found.body ?? "") === p.proposal.body &&
                found.draft === p.proposal.draft &&
                found.prerelease === p.proposal.prerelease),
            "coding_release_payload_conflict",
            409,
          );
          return found ? { id: found.id, url: found.html_url } : undefined;
        },
        () => github.createRelease(p),
      );
      const release = await github.readRelease(p.proposal.tag);
      requireThat(release, "coding_release_outcome_unknown", 409);
      for (const file of p.assets)
        await action(
          `asset:${file.name}`,
          async () => {
            const found = (await github.assets(release.id)).find(
              (a) => a.name === file.name,
            );
            requireThat(
              !found ||
                (found.state === "uploaded" &&
                  found.digest === `sha256:${file.digest}` &&
                  found.size === Buffer.from(file.data, "base64").length),
              "coding_release_asset_conflict",
              409,
            );
            return found ? { id: found.id, digest: found.digest } : undefined;
          },
          () => github.upload(release.id, file),
        );
      await update(async (w, sql, t) => {
        requireThat(t.release, "coding_release_stale", 409);
        t.release.state = "published";
        t.release.url = release.html_url;
        t.release.error = undefined;
        t.state = "review";
        // Upload bytes have served their purpose. Keep hashes and external receipts.
        for (const file of t.release.prepared.assets) file.data = "";
        await taskEvent(sql, t, `release-complete:${t.revision}`, {
          url: release.html_url,
          tag: p.proposal.tag,
          sha: p.targetSha,
        });
        notifyDevelopment(
          w,
          t,
          `${release.draft ? "Draft release created" : "Release confirmed"}: ${release.html_url}`,
          `release:${t.revision}`,
        );
      });
    } catch (error) {
      const code =
        error instanceof Fault ? error.code : "coding_release_outcome_unknown";
      await this.store.change(workspaceId, async (w, sql) => {
        const t = await taskGet(sql, workspaceId, taskId);
        if (t.lease !== lease || !t.release) return;
        t.release.state =
          code === "coding_release_outcome_unknown" ? "unknown" : "blocked";
        t.release.error = code;
        t.release.nextPollAt = new Date(Date.now() + 60000).toISOString();
        try {
          await guard(w, sql, t);
          notifyDevelopment(
            w,
            t,
            `Release is ${t.release.state}; confirmed steps are retained. ${codingFailureMessage(code)}`,
            `release-blocked:${t.revision}:${code}`,
          );
        } catch {
          /* No delivery after revocation. */
        }
        await taskSave(sql, t);
      });
    } finally {
      await this.store.change(workspaceId, async (_w, sql) => {
        const t = await taskGet(sql, workspaceId, taskId);
        if (t.lease === lease) {
          t.lease = undefined;
          t.leaseUntil = undefined;
          await taskSave(sql, t);
        }
      });
    }
    return true;
  }
}
