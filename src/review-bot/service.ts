import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { deploymentOrigin } from "../admin/site.ts";
import { branchName, codingPayload } from "../coding/config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { decrypt, encrypt, fingerprint } from "../setup/credentials.ts";
import { audit, eligible } from "../workspaces/policy.ts";
import {
  emptyReview,
  type ReviewPage,
  type ReviewTask,
  reviewSave,
  reviewTerminal,
} from "./config.ts";
import { reviewMention } from "./mentions.ts";
import { checkReview, reviewActor, reviewAuthority } from "./policy.ts";

const githubActor = z.object({
  id: z.number().int().positive().safe(),
  type: z.string(),
});
const eventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    id: z.number().int().positive(),
    full_name: z.string(),
  }),
  sender: githubActor,
  pull_request: z
    .object({
      number: z.number().int().positive(),
      draft: z.boolean(),
      head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    })
    .optional(),
  issue: z
    .object({
      number: z.number().int().positive(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  comment: z
    .object({
      id: z.number().int().positive(),
      body: z.string().max(20000),
      user: githubActor,
    })
    .optional(),
});
export function verifyReviewSignature(
  secret: string,
  body: Buffer,
  signature: string,
) {
  requireThat(
    /^sha256=[0-9a-f]{64}$/.test(signature),
    "unauthorized_webhook",
    401,
  );
  const expected = createHmac("sha256", secret).update(body).digest();
  requireThat(
    timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")),
    "unauthorized_webhook",
    401,
  );
}
export class ReviewService {
  constructor(
    readonly store: Store,
    readonly apps: GitHubApps,
    private key: string,
    private origin: string,
  ) {}
  async hookSecret(operatorId: string) {
    const row = (
      await this.store.pool.query(
        "SELECT secret FROM review_bot_hooks WHERE operator_id=$1",
        [operatorId],
      )
    ).rows[0];
    return row
      ? decrypt(this.key, `review-hook:${operatorId}`, row.secret)
      : (await this.apps.get(operatorId))?.config.webhookSecret;
  }
  async view(admin: Admin, workspaceId: string): Promise<ReviewPage> {
    const w = await this.store.read(workspaceId);
    reviewAuthority(w, admin);
    const app = await this.apps.get(w.operatorId);
    const origin = deploymentOrigin(await this.store.deployment(), this.origin);
    return {
      revision: w.reviewBot?.revision ?? 0,
      settings: w.reviewBot?.settings ?? emptyReview,
      botHandle: app ? `${app.config.slug}[bot]` : undefined,
      webhookUrl: `${origin}/github/webhook/${w.operatorId}`,
      webhookConfigured: !!(await this.hookSecret(w.operatorId)),
      repositories: (w.github?.repositories ?? []).flatMap((repo) => {
        const coding =
          w.coding?.settings.enabled &&
          w.coding.settings.repositories.find(
            (r) => r.repositoryId === repo.id,
          );
        return coding
          ? [
              {
                id: repo.id,
                full_name: repo.full_name,
                maintainers: coding.maintainers
                  .filter((id) => eligible(w, id))
                  .map((id) => ({
                    id,
                    name:
                      w.members.find((m) => m.id === id)?.name ??
                      w.members.find((m) => m.id === id)?.username ??
                      id,
                  })),
              },
            ]
          : [];
      }),
      tasks: [...(w.reviewTasks ?? [])].reverse(),
    };
  }
  async configureHook(admin: Admin, workspaceId: string, value: unknown) {
    const input = z
      .object({ secret: z.string().trim().min(32).max(8192).optional() })
      .strict()
      .parse(value);
    requireThat(this.key, "coding_credentials_unavailable", 503);
    const secret = input.secret ?? randomBytes(32).toString("hex");
    await this.store.change(workspaceId, async (w, sql) => {
      reviewAuthority(w, admin);
      requireThat(
        await this.apps.get(w.operatorId),
        "github_app_not_configured",
        409,
      );
      await sql.query(
        "INSERT INTO review_bot_hooks(operator_id,secret) VALUES($1,$2) ON CONFLICT(operator_id) DO UPDATE SET secret=EXCLUDED.secret,updated_at=now()",
        [
          w.operatorId,
          encrypt(this.key, `review-hook:${w.operatorId}`, secret),
        ],
      );
      audit(w, admin.id, "review.webhook_configured", w.id);
    });
    return { secret, url: (await this.view(admin, workspaceId)).webhookUrl };
  }
  async save(admin: Admin, workspaceId: string, value: unknown) {
    const input = reviewSave.parse(value);
    await this.store.change(workspaceId, async (w, sql) => {
      reviewAuthority(w, admin);
      requireThat(
        input.revision === (w.reviewBot?.revision ?? 0),
        "version_conflict",
        409,
      );
      // An App/repository has one review destination, even across the operator's workspaces.
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `review-settings:${w.operatorId}`,
      ]);
      if (input.settings.enabled) {
        requireThat(
          input.settings.repositories.length &&
            w.github?.installationId &&
            w.coding?.settings.enabled,
          "review_repository_required",
          409,
        );
        requireThat(
          await this.hookSecret(w.operatorId),
          "review_webhook_required",
          409,
        );
        for (const target of input.settings.repositories) {
          const coding = w.coding.settings.repositories.find(
            (r) => r.repositoryId === target.repositoryId,
          );
          requireThat(
            w.github.repositories.some((r) => r.id === target.repositoryId) &&
              coding?.maintainers.includes(target.reviewer) &&
              eligible(w, target.reviewer),
            "review_reviewer_required",
            409,
          );
          requireThat(
            !target.allowFixes ||
              coding?.development?.executionMode === "direct",
            "coding_direct_execution_disabled",
            409,
          );
        }
        const others = await sql.query(
          "SELECT data FROM workspaces WHERE id<>$1 AND data->>'operatorId'=$2 AND data#>>'{reviewBot,settings,enabled}'='true'",
          [w.id, w.operatorId],
        );
        for (const { data } of others.rows as { data: Workspace }[])
          requireThat(
            data.deletion ||
              data.github?.installationId !== w.github.installationId ||
              !data.reviewBot?.settings.repositories.some((r) =>
                input.settings.repositories.some(
                  (t) => t.repositoryId === r.repositoryId,
                ),
              ),
            "review_repository_already_configured",
            409,
          );
      }
      w.reviewBot = { revision: input.revision + 1, settings: input.settings };
      for (const task of w.reviewTasks ?? [])
        if (!reviewTerminal(task.state)) task.cancelRequested = true;
      audit(w, admin.id, "review.settings_updated", w.id, w.reviewBot.revision);
    });
    return this.view(admin, workspaceId);
  }
  async cancel(admin: Admin, workspaceId: string, id: string) {
    await this.store.change(workspaceId, (w) => {
      reviewAuthority(w, admin);
      const task = w.reviewTasks?.find((t) => t.id === id);
      requireThat(task, "not_found", 404);
      task.cancelRequested = true;
      audit(w, admin.id, "review.cancel_requested", id);
    });
    return this.view(admin, workspaceId);
  }
  async accept(
    operatorId: string,
    event: string,
    delivery: string,
    signature: string,
    body: Buffer,
  ) {
    z.uuid().parse(operatorId);
    requireThat(
      /^[a-zA-Z0-9-]{1,100}$/.test(delivery),
      "invalid_github_delivery",
      400,
    );
    const secret = await this.hookSecret(operatorId);
    requireThat(secret, "unauthorized_webhook", 401);
    verifyReviewSignature(secret, body, signature);
    if (
      ![
        "pull_request",
        "issue_comment",
        "pull_request_review_comment",
        "installation",
        "installation_repositories",
      ].includes(event)
    )
      return { accepted: true };
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Fault("invalid_github_event");
    }
    const app = await this.apps.get(operatorId);
    requireThat(app, "github_app_not_configured", 409);
    if (event === "installation" || event === "installation_repositories") {
      const data = z
        .object({
          action: z.string(),
          installation: z.object({ id: z.number().int().positive() }),
          repositories_removed: z
            .array(z.object({ id: z.number().int().positive() }))
            .optional(),
        })
        .parse(raw);
      if (["deleted", "suspend", "removed"].includes(data.action))
        for (const w of await this.store.all())
          if (
            w.operatorId === operatorId &&
            w.github?.installationId === data.installation.id
          )
            await this.store.change(w.id, (current) => {
              for (const t of current.reviewTasks ?? [])
                if (
                  !data.repositories_removed ||
                  data.repositories_removed.some(
                    (r) => r.id === t.payload.repositoryId,
                  )
                )
                  t.cancelRequested = true;
            });
      return { accepted: true };
    }
    const data = eventSchema.parse(raw);
    const ids = (
      await this.store.pool.query(
        "SELECT id FROM workspaces WHERE data->>'operatorId'=$1 AND data#>>'{github,installationId}'=$2 AND data#>>'{reviewBot,settings,enabled}'='true'",
        [operatorId, String(data.installation.id)],
      )
    ).rows as { id: string }[];
    for (const { id } of ids)
      await this.store.change(id, async (w, sql) => {
        const target = w.reviewBot?.settings.repositories.find(
          (r) => r.repositoryId === data.repository.id,
        );
        if (
          !target ||
          w.deletion ||
          w.operatorId !== operatorId ||
          w.github?.installationId !== data.installation.id ||
          !w.reviewBot?.settings.enabled ||
          !w.github.repositories.some(
            (r) =>
              r.id === target.repositoryId &&
              r.full_name === data.repository.full_name,
          )
        )
          return;
        const receipt = await sql.query(
          "INSERT INTO review_bot_receipts(workspace_id,app_id,delivery_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [w.id, app.config.id, delivery],
        );
        if (!receipt.rowCount) return;
        w.reviewTasks ??= [];
        const tasks = w.reviewTasks;
        const number =
          data.pull_request?.number ??
          (data.issue?.pull_request ? data.issue.number : undefined);
        if (!number) return;
        if (
          event === "pull_request" &&
          ["closed", "converted_to_draft"].includes(data.action)
        ) {
          for (const t of tasks)
            if (
              t.number === number &&
              t.payload.repositoryId === target.repositoryId &&
              (data.action === "closed" || t.automatic)
            )
              t.cancelRequested = true;
          return;
        }
        let mode: ReviewTask["mode"],
          actor: string,
          statusOnly: boolean | undefined,
          githubUserId: number | undefined,
          text: string,
          source: ReviewTask["sources"][number] | undefined;
        const automatic = event === "pull_request";
        let key = automatic
          ? `auto:${target.repositoryId}:${number}:${data.pull_request?.head.sha}`
          : `comment:${event}:${data.comment?.id}`;
        if (tasks.some((t) => t.key === key)) {
          const resumable =
            automatic && ["reopened", "ready_for_review"].includes(data.action);
          const existing = tasks.filter(
            (t) => t.key === key || t.key.startsWith(`${key}:`),
          );
          if (
            !resumable ||
            existing.some((t) => !t.cancelRequested && t.state !== "cancelled")
          )
            return;
          key = `${key}:${delivery}`;
        }
        if (automatic) {
          if (
            !target.autoReview ||
            data.pull_request?.draft ||
            !["opened", "synchronize", "reopened", "ready_for_review"].includes(
              data.action,
            )
          )
            return;
          mode = "review";
          actor = target.reviewer;
          text = "Review this pull request.";
          for (const t of tasks)
            if (
              t.automatic &&
              t.payload.repositoryId === target.repositoryId &&
              t.number === number &&
              !reviewTerminal(t.state)
            )
              t.cancelRequested = true;
        } else {
          if (
            data.action !== "created" ||
            !target.acceptRequests ||
            !data.comment ||
            data.comment.user.type !== "User" ||
            data.sender.id !== data.comment.user.id
          )
            return;
          const mention = reviewMention(
            data.comment.body,
            `${app.config.slug}[bot]`,
          );
          if (!mention) return;
          try {
            actor = reviewActor(
              w,
              data.comment.user.id,
              target.repositoryId,
              mention.mode === "fix",
            );
          } catch {
            return;
          }
          const active = [...tasks]
            .reverse()
            .find(
              (t) =>
                t.payload.repositoryId === target.repositoryId &&
                t.number === number &&
                !reviewTerminal(t.state),
            );
          if (mention.mode === "cancel") {
            if (active) {
              active.cancelRequested = true;
              audit(w, actor, "review.cancel_requested", active.id);
            }
            return;
          }
          githubUserId = data.comment.user.id;
          source = {
            id: data.comment.id,
            kind: event === "issue_comment" ? "issue" : "review",
            hash: fingerprint(data.comment.body),
            githubId: githubUserId,
          };
          if (
            active?.state === "waiting" &&
            active.actor === actor &&
            ["answer", "fix"].includes(mention.mode)
          ) {
            requireThat(active.revision < 100, "coding_input_capacity", 429);
            active.revision++;
            active.inputs.push({
              revision: active.revision,
              actor,
              sourceId: `github:${source.kind}:${source.id}`,
              text: mention.text,
              kind: "answer",
            });
            active.sources.push(source);
            active.previousAttemptId = active.attemptId;
            active.attemptIds ??= [];
            active.attemptIds.push(active.attemptId);
            active.attemptId = randomUUID();
            active.run = undefined;
            active.state = "queued";
            active.nextPollAt = undefined;
            active.updatedAt = new Date().toISOString();
            return;
          }
          mode = mention.mode === "status" ? "answer" : mention.mode;
          statusOnly = mention.mode === "status";
          if (mode === "fix" && !target.allowFixes) return;
          text = mention.text;
        }
        if (
          tasks.length >= 200 ||
          tasks.filter((t) => !reviewTerminal(t.state)).length >= 20
        )
          throw new Fault("review_capacity_reached", 429);
        const coding = w.coding;
        const repository = coding?.settings.repositories.find(
          (r) => r.repositoryId === target.repositoryId,
        );
        if (
          !coding?.settings.enabled ||
          !repository ||
          !w.github.installationId
        )
          return;
        const at = new Date().toISOString();
        const task: ReviewTask = {
          id: randomUUID(),
          key,
          actor,
          githubUserId,
          payload: codingPayload.parse({
            repositoryId: target.repositoryId,
            repository: data.repository.full_name,
            installationId: data.installation.id,
            githubRevision: w.github.revision,
            configRevision: coding.revision,
            baseBranch: branchName.parse(repository.baseBranch),
            backend: "podman",
            authMode: coding.settings.authMode,
            title: `PR #${number}`,
            body: text.slice(0, 2500),
          }),
          reviewRevision: w.reviewBot.revision,
          number,
          mode,
          statusOnly,
          automatic,
          inputs: [
            {
              revision: 1,
              actor,
              sourceId: source
                ? `github:${source.kind}:${source.id}`
                : `github:auto:${delivery}`,
              text,
              kind: "request",
            },
          ],
          sources: source ? [source] : [],
          revision: 1,
          consumedRevision: 0,
          state: "queued",
          attemptId: randomUUID(),
          headSha: automatic ? data.pull_request?.head.sha : undefined,
          progress: automatic ? undefined : { state: "pending" },
          createdAt: at,
          updatedAt: at,
        };
        try {
          checkReview(w, task);
        } catch {
          return;
        }
        tasks.push(task);
        audit(w, actor, "review.task_accepted", task.id);
      });
    return { accepted: true };
  }
}
