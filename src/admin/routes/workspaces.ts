import { Hono } from "hono";
import { z } from "zod";
import { attemptCost } from "../../agent/limits.ts";
import { modelCapabilities } from "../../agent/runtime.ts";
import { browserPanelRun, browserRunPrivate } from "../../browser/privacy.ts";
import { taskList } from "../../coding/task-store.ts";
import { cancelRequest } from "../../coding/tasks.ts";
import {
  requireThat,
  settingsSchema,
  skillSchema,
  userId,
  workflowSchema,
} from "../../domain.ts";
import { type GitHubMember, githubUsernameSchema } from "../../github/app.ts";
import { assignGitHubAccount } from "../../github/member-account.ts";
import { reconcileCharge, resolveDelivery } from "../../jobs/recovery.ts";
import { requestDeletion } from "../../privacy/service.ts";
import { fingerprint } from "../../setup/credentials.ts";
import {
  changeSkill,
  isPresetSkill,
  saveManagedSkill,
  testSkill,
} from "../../skills/catalog.ts";
import { githubSkillUrl } from "../../skills/github-source.ts";
import { importMarkdown } from "../../skills/import.ts";
import { TelegramError } from "../../telegram/client.ts";
import { groupVisibility } from "../../telegram/visibility.ts";
import {
  decide,
  proposeInstruction,
  saveManagedWorkflow,
  workflowAction,
} from "../../workflows/service.ts";
import { decideAccessRequest } from "../../workspaces/access-requests.ts";
import { issueGroupLink } from "../../workspaces/group-links.ts";
import {
  groupRepositories,
  groupRepositoryCurrent,
  saveGroupRepository,
} from "../../workspaces/group-repository.ts";
import { membersWithProfiles } from "../../workspaces/member-profile.ts";
import {
  audit,
  revokeWork,
  updateMembership,
} from "../../workspaces/policy.ts";
import { createRun, visibleRuns } from "../../workspaces/service.ts";
import { session, throttle } from "../auth.ts";
import { runSummaries } from "../run-history.ts";
import {
  historyPage,
  runThreadKey,
  threadDetail,
  threadGroups,
  threadKey,
  threadSummaries,
} from "../thread-history.ts";
import {
  workflowOwner,
  workflowRepositories,
  workflowView,
} from "../workflow-view.ts";
import {
  type AdminEnv,
  type AdminRouteDeps,
  sessionCookieValue,
  validId,
  version,
  workspaceActor,
  workspaceChange,
} from "./shared.ts";

export function workspaceRoutes(deps: AdminRouteDeps) {
  const { store, setup, github, selfCheck } = deps;
  const app = new Hono<AdminEnv>();
  const change = workspaceChange(store);

  app.use("/api/admin/workspaces/:id/*", async (c, next) => {
    const w = await store.read(validId(c.req.param("id") ?? ""));
    const admin = c.get("session").admin;
    const actor = workspaceActor(w, admin);
    if (actor === admin.id) {
      const resource = c.req.path.split("/").slice(5).join("/");
      requireThat(
        /^(overview|settings|members|access-requests|chats|skills|workflows)(\/.*)?$/.test(
          resource,
        ) ||
          (resource === "self-check" && c.req.method === "POST") ||
          (c.req.method === "GET" && resource === "approvals") ||
          (c.req.method === "POST" && /^approvals\/[^/]+$/.test(resource)) ||
          (c.req.method === "GET" &&
            /^(runs|threads)(?:\/[^/]+)?$/.test(resource)),
        "access_denied",
        403,
      );
    }
    await next();
  });

  app.post("/api/admin/workspaces/:id/self-check", async (c) => {
    const admin = c.get("session").admin;
    const id = validId(c.req.param("id"));
    await throttle(store.pool, `self-check:${admin.id}`);
    return c.json(
      await selfCheck.reply(
        admin,
        id,
        await c.req.json(),
        c.req.raw.signal,
        async () => {
          const current = await session(store.pool, sessionCookieValue(c));
          requireThat(
            current?.admin.id === admin.id,
            "authentication_required",
            401,
          );
          workspaceActor(await store.read(id), current.admin);
        },
      ),
    );
  });

  app.get("/api/admin/workspaces/:id/:resource", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const take = <T>(items: T[]) => ({
      items: items.slice(offset, offset + 100),
      total: items.length,
      offset,
    });
    switch (c.req.param("resource")) {
      case "overview": {
        const admin = c.get("session").admin;
        const operatorView = actor === w.operatorId;
        const deployment =
          admin.operator && w.operatorId === admin.id
            ? await store.deployment()
            : undefined;
        return c.json({
          id: w.id,
          settings: w.settings,
          version: w.version,
          counts: {
            members: w.members.filter((m) => m.active).length,
            runs: w.runs.length,
            threads: threadGroups(w).size,
            workflows: w.workflows.filter((f) => f.status !== "deleted").length,
            ...(operatorView
              ? {
                  codingTasks: (await taskList(store.pool, w.id)).length,
                }
              : {}),
          },
          connections: deployment
            ? {
                bot: {
                  configured: !!deployment.credentials.bot && !!deployment.bot,
                  username: deployment.credentials.bot
                    ? deployment.bot?.username
                    : undefined,
                },
                github: {
                  connected: !!w.github?.installationId,
                  account: w.github?.account,
                  repositories: w.github?.repositories.length ?? 0,
                },
              }
            : undefined,
        });
      }
      case "settings": {
        const deployment = await store.deployment();
        return c.json({
          version: w.version,
          settings: w.settings,
          model: deployment.model,
          capabilities: modelCapabilities(deployment.model, deployment) ?? null,
        });
      }
      case "members": {
        const search = (c.req.query("search") ?? "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase();
        const members = membersWithProfiles(w).filter((member) =>
          `${member.id} ${member.username ?? ""} ${member.name ?? ""} ${member.github?.login ?? ""} ${member.githubAccount?.login ?? ""}`
            .toLowerCase()
            .includes(search),
        );
        return c.json({ version: w.memberVersion, ...take(members) });
      }
      case "access-requests": {
        const deployment = await store.deployment();
        return c.json({
          version: w.memberVersion,
          items: (w.accessRequests ?? []).filter((r) => r.status === "pending"),
          ...setup.accessLinks.view(w, deployment.bot),
        });
      }
      case "chats":
        return c.json(take(w.chats));
      case "workflows":
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          repositorySources: workflowRepositories(w, actor),
          ...take(
            w.workflows
              .filter((f) => f.status !== "deleted")
              .map((f) =>
                workflowView(w, f, c.get("session").admin.telegramId),
              ),
          ),
        });
      case "approvals":
        return c.json(
          take(
            w.approvals.filter(
              (a) =>
                !a.browserRead &&
                !(
                  a.runId &&
                  w.runs.some(
                    (r) => r.id === a.runId && browserRunPrivate(w, r),
                  )
                ) &&
                a.kind !== "workflow" &&
                a.actor === actor &&
                !a.decision,
            ),
          ),
        );
      case "skills":
        return c.json(
          take(
            w.skills.map((s) => ({
              ...s,
              preset: isPresetSkill(w, s),
              dependents: w.workflows
                .filter((f) => f.spec.skillId === s.id)
                .map((f) => ({
                  id: f.id,
                  name: f.spec.name,
                  version: f.skillVersion,
                  status: f.status,
                })),
            })),
          ),
        );
      case "instructions":
        return c.json(
          take(
            w.instructions.filter(
              (i) => i.active && (i.scope !== "personal" || i.author === actor),
            ),
          ),
        );
      case "threads": {
        const page = historyPage.parse(c.req.query());
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          ...threadSummaries(w, page.offset, page.limit),
        });
      }
      case "runs": {
        const page = z
          .object({
            offset: z.coerce
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .default(0),
            limit: z.coerce.number().int().min(1).max(100).default(25),
          })
          .parse(c.req.query());
        return c.json({
          mode: actor === w.operatorId ? "operator" : "member",
          items: runSummaries(w, page.offset, page.limit),
          total: w.runs.length,
          ...page,
        });
      }
      case "usage": {
        const attempts = [...w.runs, ...(w.adminChecks ?? [])].flatMap((r) =>
          r.attempts.map((a) => ({ ...a, runId: r.id, model: r.model })),
        );
        return c.json({
          budget: w.settings.monthlyBudgetUsd,
          totalUsd: attempts.reduce((n, a) => n + attemptCost(a), 0),
          ...take(attempts.toReversed()),
        });
      }
      case "audit":
        return c.json(take(w.audit.toReversed()));
      case "deletion":
        return c.json(
          w.deletion ?? {
            status: "not_requested",
            retentionDays: w.settings.retentionDays,
          },
        );
      default:
        return c.json({ error: "not_found" }, 404);
    }
  });

  app.put("/api/admin/workspaces/:id/settings", async (c) => {
    const input = z
      .object({ version, settings: settingsSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        requireThat(w.version === input.version, "version_conflict", 409);
        w.settings = input.settings;
        w.version++;
        revokeWork(w);
        audit(w, actor, "settings.updated", w.id, w.version);
        return { version: w.version, settings: w.settings };
      }),
    );
  });
  app.post(
    "/api/admin/workspaces/:id/access-requests/:request/decision",
    async (c) => {
      const input = z
        .object({ decision: z.enum(["approved", "rejected"]), version })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("request"));
      return c.json(
        await change(c, async (w, actor, sql) => {
          const request = decideAccessRequest(
            w,
            actor,
            id,
            input.decision,
            input.version,
          );
          if (request.status === "approved")
            await sql.query(
              "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO NOTHING",
              [request.actor, w.id],
            );
          return request;
        }),
      );
    },
  );
  app.get("/api/admin/workspaces/:id/members/github", async (c) => {
    const id = validId(c.req.param("id"));
    const w = await store.read(id);
    workspaceActor(w, c.get("session").admin);
    const directory = await github.memberDirectory(w);
    const current = await store.read(id);
    workspaceActor(current, c.get("session").admin);
    requireThat(
      (current.github?.revision ?? 0) === directory.revision &&
        current.github?.installationId === w.github?.installationId,
      "github_connection_changed",
      409,
    );
    return c.json(directory);
  });
  app.post("/api/admin/workspaces/:id/members", async (c) => {
    const input = z
      .object({
        id: userId,
        role: z.enum(["admin", "member"]),
        active: z.boolean(),
        githubId: z.number().int().positive().safe().nullable().optional(),
        githubUsername: githubUsernameSchema.optional(),
        githubRevision: z.number().int().nonnegative().optional(),
        version,
      })
      .strict()
      .refine(
        (input) =>
          input.githubUsername === undefined || input.githubId === undefined,
      )
      .parse(await c.req.json());
    let account: GitHubMember | null = null;
    let githubRevision = input.githubRevision;
    const githubChanged =
      input.githubId !== undefined || input.githubUsername !== undefined;
    if (githubChanged) {
      const w = await store.read(validId(c.req.param("id")));
      workspaceActor(w, c.get("session").admin);
      requireThat(w.memberVersion === input.version, "version_conflict", 409);
      if (input.githubId === null) githubRevision ??= w.github?.revision ?? 0;
      if (input.githubUsername !== undefined) {
        githubRevision ??= w.github?.revision ?? 0;
        requireThat(
          (w.github?.revision ?? 0) === githubRevision,
          "github_connection_changed",
          409,
        );
        account = await github.memberAccount(w, input.githubUsername);
      } else if (input.githubId != null) {
        const directory = await github.memberDirectory(w);
        requireThat(
          directory.revision === githubRevision,
          "github_connection_changed",
          409,
        );
        account =
          directory.members.find((m) => m.id === input.githubId) ?? null;
        requireThat(account, "github_member_not_found", 409);
      }
    }
    return c.json(
      await change(c, (w, actor) => {
        updateMembership(w, actor, input.version, input);
        if (githubChanged) {
          requireThat(
            (w.github?.revision ?? 0) === githubRevision,
            "github_connection_changed",
            409,
          );
          const member = w.members.find((m) => m.id === input.id);
          requireThat(member, "not_found", 404);
          assignGitHubAccount(w, member, account);
          audit(
            w,
            actor,
            "github.account_assigned",
            `${input.id}:${account?.id ?? "none"}`,
          );
        }
        return w.members;
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/chats/link-token", async (c) => {
    const deployment = await store.deployment();
    requireThat(deployment.bot, "bot_not_configured", 409);
    const bot = deployment.bot;
    return c.json(
      await change(c, (w) => issueGroupLink(w, c.get("session").admin, bot)),
      201,
    );
  });
  app.get("/api/admin/workspaces/:id/chats/:chat/repository", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    workspaceActor(w, c.get("session").admin);
    const chat = w.chats.find((chat) => chat.id === c.req.param("chat"));
    requireThat(chat, "not_found", 404);
    const deployment = await store.deployment();
    return c.json({
      revision: chat.repositoryRevision ?? 0,
      binding: chat.repository,
      available:
        !chat.repository ||
        (!!deployment.bot &&
          groupRepositoryCurrent(
            w,
            chat.id,
            chat.repository,
            deployment.bot.id,
          )),
      repositories: groupRepositories(w).map(({ id, full_name }) => ({
        id,
        full_name,
      })),
    });
  });
  app.put("/api/admin/workspaces/:id/chats/:chat/repository", async (c) => {
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        repositoryId: z.number().int().positive().nullable(),
      })
      .strict()
      .parse(await c.req.json());
    await store.change(validId(c.req.param("id")), async (w, sql) => {
      const actor = workspaceActor(w, c.get("session").admin);
      const deployment = await store.deployment(sql);
      requireThat(deployment.bot, "bot_not_configured", 409);
      const changed = saveGroupRepository(
        w,
        c.req.param("chat"),
        actor,
        deployment.bot.id,
        input.revision,
        input.repositoryId,
      );
      if (changed) {
        revokeWork(w);
        audit(
          w,
          actor,
          "chat.repository_saved",
          c.req.param("chat"),
          input.revision + 1,
        );
      }
    });
    return c.json({ ok: true });
  });
  app.post("/api/admin/workspaces/:id/chats/:chat/action", async (c) => {
    const input = z
      .object({ action: z.enum(["collect", "directed", "unlink"]) })
      .strict()
      .parse(await c.req.json());
    const id = c.req.param("chat");
    await store.change(validId(c.req.param("id")), async (w, sql) => {
      const actor = workspaceActor(w, c.get("session").admin);
      const chat = w.chats.find((c) => c.id === id);
      requireThat(chat, "not_found", 404);
      if (input.action === "collect") {
        requireThat(chat.active, "bot_visibility_required");
        chat.collection = true;
        chat.consentAt = new Date().toISOString();
        chat.consentBy = actor;
      } else chat.collection = false;
      if (input.action === "unlink") {
        chat.active = false;
        chat.repository = undefined;
        chat.repositoryRevision = (chat.repositoryRevision ?? 0) + 1;
        w.tokens = w.tokens.filter((entry) => entry.kind !== "group");
        await sql.query(
          "DELETE FROM chat_bindings WHERE workspace_id=$1 AND chat_id=$2",
          [w.id, id],
        );
      }
      revokeWork(w);
      audit(w, actor, `chat.${input.action}`, id);
    });
    return c.json({ ok: true });
  });
  app.post("/api/admin/workspaces/:id/chats/:chat/visibility", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    workspaceActor(w, c.get("session").admin);
    const linkedChat = w.chats.find((chat) => chat.id === c.req.param("chat"));
    requireThat(linkedChat, "not_found", 404);
    const deployment = await store.deployment();
    requireThat(deployment.bot, "bot_not_configured", 409);
    const client = await setup.client(deployment);
    const visibleAll = await groupVisibility(
      client,
      linkedChat.id,
      deployment.bot.id,
    );
    const details = await client
      .call<{ title?: string }>("getChat", { chat_id: linkedChat.id })
      .catch((error: unknown) => {
        // Inactive groups may be inaccessible; keep their last known name.
        if (!(error instanceof TelegramError)) throw error;
        return undefined;
      });
    return c.json(
      await change(c, (w, actor) => {
        const chat = w.chats.find((chat) => chat.id === c.req.param("chat"));
        requireThat(chat, "not_found", 404);
        if (details?.title?.trim()) chat.title = details.title.trim();
        chat.visibleAll = visibleAll;
        audit(w, actor, "chat.visibility_checked", chat.id);
        return chat;
      }),
    );
  });
  app.get("/api/admin/workspaces/:id/workflows/:workflow", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const id = validId(c.req.param("workflow"));
    const operatorView = actor === w.operatorId;
    const workflow = w.workflows.find(
      (f) => f.id === id && f.status !== "deleted",
    );
    requireThat(workflow, "not_found", 404);
    return c.json({
      mode: operatorView ? "operator" : "member",
      workflow: workflowView(w, workflow, c.get("session").admin.telegramId),
      repositorySources: workflowRepositories(w, actor),
    });
  });
  app.post("/api/admin/workspaces/:id/workflows", async (c) => {
    const input = workflowSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveManagedWorkflow(w, workflowOwner(w, actor, input), input, actor),
      ),
      201,
    );
  });
  app.put("/api/admin/workspaces/:id/workflows/:workflow", async (c) => {
    const input = z
      .object({ version, spec: workflowSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveManagedWorkflow(
          w,
          workflowOwner(w, actor, input.spec, c.req.param("workflow")),
          input.spec,
          actor,
          c.req.param("workflow"),
          input.version,
          new Date(),
          c.get("session").admin.telegramId ?? actor,
        ),
      ),
    );
  });
  app.post(
    "/api/admin/workspaces/:id/workflows/:workflow/action",
    async (c) => {
      const input = z
        .object({
          version,
          action: z.enum(["pause", "resume", "delete", "run"]),
        })
        .strict()
        .parse(await c.req.json());
      const d = await store.deployment();
      return c.json(
        await change(c, (w, actor) =>
          workflowAction(
            w,
            workflowOwner(w, actor, undefined, c.req.param("workflow")),
            c.req.param("workflow"),
            input.action,
            input.version,
            d.model,
            actor,
          ),
        ),
      );
    },
  );
  app.post("/api/admin/workspaces/:id/approvals/:approval", async (c) => {
    const input = z
      .object({ approve: z.boolean() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        const approval = w.approvals.find(
          (a) => a.id === c.req.param("approval"),
        );
        requireThat(
          !approval?.browserRead &&
            !(
              approval?.runId &&
              w.runs.some(
                (r) => r.id === approval.runId && browserRunPrivate(w, r),
              )
            ),
          "approval_denied",
          403,
        );
        return decide(
          w,
          actor,
          c.req.param("approval"),
          input.approve,
          new Date(),
          w.approvals.find((a) => a.id === c.req.param("approval"))?.kind ===
            "workflow"
            ? actor
            : undefined,
        );
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/instructions", async (c) => {
    const input = z
      .object({
        body: z.string().min(1).max(4000),
        scope: z.enum(["personal", "workspace", "workflow"]),
        workflowId: z.string().optional(),
        replaceId: z.string().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        proposeInstruction(
          w,
          actor,
          input.body,
          input.scope,
          "admin_panel",
          input.workflowId,
          input.replaceId,
        ),
      ),
      201,
    );
  });
  app.delete(
    "/api/admin/workspaces/:id/instructions/:instruction",
    async (c) => {
      const input = z
        .object({ version })
        .strict()
        .parse(await c.req.json());
      await change(c, (w, actor) => {
        const i = w.instructions.find(
          (i) => i.id === c.req.param("instruction"),
        );
        requireThat(
          i && (i.scope !== "personal" || i.author === actor),
          "not_found",
          404,
        );
        requireThat(i.version === input.version, "version_conflict", 409);
        i.active = false;
        i.body = "";
        i.version++;
        audit(w, actor, "instruction.forgotten", i.id, i.version);
      });
      return c.json({ ok: true });
    },
  );
  app.post("/api/admin/workspaces/:id/skills/github/discover", async (c) => {
    const input = z
      .object({ url: githubSkillUrl })
      .strict()
      .parse(await c.req.json());
    const id = validId(c.req.param("id"));
    const actor = workspaceActor(await store.read(id), c.get("session").admin);
    return c.json(await github.skills.discover(id, actor, input.url));
  });
  app.post("/api/admin/workspaces/:id/skills/github/import", async (c) => {
    const id = validId(c.req.param("id"));
    const actor = workspaceActor(await store.read(id), c.get("session").admin);
    return c.json(
      await github.skills.import(id, actor, await c.req.json()),
      201,
    );
  });
  app.post(
    "/api/admin/workspaces/:id/skills/:skill/github/check",
    async (c) => {
      const input = z
        .object({ version })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("id"));
      const actor = workspaceActor(
        await store.read(id),
        c.get("session").admin,
      );
      return c.json(
        await github.skills.check(
          id,
          actor,
          validId(c.req.param("skill")),
          input.version,
        ),
      );
    },
  );
  app.post(
    "/api/admin/workspaces/:id/skills/:skill/github/update",
    async (c) => {
      const input = z
        .object({
          version,
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          replaceLocal: z.boolean().default(false),
        })
        .strict()
        .parse(await c.req.json());
      const id = validId(c.req.param("id"));
      const actor = workspaceActor(
        await store.read(id),
        c.get("session").admin,
      );
      return c.json(
        await github.skills.update(
          id,
          actor,
          validId(c.req.param("skill")),
          input.version,
          input.commit,
          input.replaceLocal,
        ),
      );
    },
  );
  app.post("/api/admin/workspaces/:id/skills/import", async (c) => {
    const input = z
      .object({ markdown: z.string().max(16384) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveManagedSkill(w, actor, importMarkdown(input.markdown)),
      ),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/skills", async (c) => {
    const spec = skillSchema.parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => saveManagedSkill(w, actor, spec)),
      201,
    );
  });
  app.put("/api/admin/workspaces/:id/skills/:skill", async (c) => {
    const input = z
      .object({ version, spec: skillSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        saveManagedSkill(
          w,
          actor,
          input.spec,
          c.req.param("skill"),
          input.version,
        ),
      ),
    );
  });
  app.post("/api/admin/workspaces/:id/skills/:skill/action", async (c) => {
    const input = z
      .object({
        version,
        action: z.enum(["publish", "enable", "disable", "archive", "rollback"]),
        pin: z.number().int().positive().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) => {
        const id = c.req.param("skill");
        const skill = w.skills.find((s) => s.id === id);
        let expected = input.version;
        // Approve the displayed instructions when enabling legacy catalog entries.
        if (
          input.action === "enable" &&
          skill &&
          !isPresetSkill(w, skill) &&
          (!skill.published.length ||
            fingerprint(skill.draft) !== fingerprint(skill.published.at(-1)))
        ) {
          expected = changeSkill(w, actor, id, expected, "publish").version;
        }
        return changeSkill(w, actor, id, expected, input.action, input.pin);
      }),
    );
  });
  app.post("/api/admin/workspaces/:id/skills/:skill/test", async (c) => {
    const input = z
      .object({ sample: z.string().max(4000) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await change(c, (w, actor) =>
        testSkill(w, actor, c.req.param("skill"), input.sample),
      ),
    );
  });
  app.get("/api/admin/workspaces/:id/threads/:thread", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const id = threadKey.parse(c.req.param("thread"));
    const page = historyPage.parse(c.req.query());
    return c.json({
      mode: actor === w.operatorId ? "operator" : "member",
      ...threadDetail(w, id, page.offset, page.limit),
    });
  });
  app.get("/api/admin/workspaces/:id/runs/:run", async (c) => {
    const w = await store.read(validId(c.req.param("id")));
    const actor = workspaceActor(w, c.get("session").admin);
    const runId = validId(c.req.param("run"));
    const run = w.runs.find((r) => r.id === runId);
    requireThat(run, "not_found", 404);
    return c.json({
      mode: actor === w.operatorId ? "operator" : "member",
      threadId: runThreadKey(w, run),
      run: {
        ...browserPanelRun(w, run),
        deliveries: browserRunPrivate(w, run)
          ? []
          : w.deliveries.filter(
              (d) => d.runId === run.id || d.cancellationRunId === run.id,
            ),
      },
    });
  });
  app.post("/api/admin/workspaces/:id/runs", async (c) => {
    const input = z
      .object({
        task: z.string().min(1).max(4000),
        chatId: z.string(),
        topicId: z.number().int().nonnegative().default(0),
      })
      .strict()
      .parse(await c.req.json());
    const d = await store.deployment();
    requireThat(d.active && !d.paused, "deployment_inactive", 409);
    return c.json(
      await change(c, (w, actor) =>
        createRun(w, actor, input.task, input.chatId, input.topicId, d.model),
      ),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/runs/:run/cancel", async (c) =>
    c.json(
      await change(c, async (w, actor, sql) =>
        browserPanelRun(
          w,
          await cancelRequest(sql, w, actor, c.req.param("run")),
        ),
      ),
    ),
  );
  app.post("/api/admin/workspaces/:id/runs/:run/retry", async (c) => {
    const d = await store.deployment();
    return c.json(
      await change(c, (w, actor) => {
        const r = visibleRuns(w, actor).find(
          (r) => r.id === c.req.param("run"),
        );
        requireThat(
          r && ["failed", "cancelled", "partial"].includes(r.status),
          "run_not_retryable",
          409,
        );
        requireThat(
          !browserRunPrivate(w, r),
          "browser_private_task_required",
          403,
        );
        return createRun(w, actor, r.task, r.chatId, r.topicId, d.model, {
          workflowId: r.workflowId,
        });
      }),
      201,
    );
  });
  app.post("/api/admin/workspaces/:id/deletion", async (c) =>
    c.json(await change(c, (w, actor) => requestDeletion(w, actor)), 201),
  );
  app.post("/api/admin/workspaces/:id/runs/:run/reconcile", async (c) => {
    const input = z
      .object({
        attemptId: z.string(),
        actualUsd: z.number().min(0).max(100),
        reference: z.string().min(3).max(100),
      })
      .strict()
      .parse(await c.req.json());
    await change(c, (w, actor) =>
      reconcileCharge(
        w,
        actor,
        c.req.param("run"),
        input.attemptId,
        input.actualUsd,
        input.reference,
      ),
    );
    return c.json({ ok: true });
  });
  app.post(
    "/api/admin/workspaces/:id/deliveries/:delivery/resolve",
    async (c) => {
      const input = z
        .object({
          action: z.enum(["confirm_sent", "abandon"]),
          remoteId: z.number().int().positive().optional(),
        })
        .strict()
        .parse(await c.req.json());
      await change(c, (w, actor) =>
        resolveDelivery(
          w,
          actor,
          c.req.param("delivery"),
          input.action,
          input.remoteId,
        ),
      );
      return c.json({ ok: true });
    },
  );
  return app;
}
