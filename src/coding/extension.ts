import { Type } from "typebox";
import type { BuiltinExtension } from "../agent/extensions.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import { requireThat, type Workspace } from "../domain.ts";
import { verifiedRepositoryAccess } from "../github/user-access.ts";
import { fingerprint } from "../setup/credentials.ts";
import { authorize, runAllowed } from "../workspaces/policy.ts";
import { conversationPage } from "./conversation.ts";
import {
  askTask,
  conversationAudience,
  exchangeView,
  taskExchanges,
} from "./conversation-store.ts";
import { developmentStatus } from "./feedback.ts";
import { requireRepositoryTarget } from "./repository-target.ts";
import { taskGet } from "./task-store.ts";
import {
  appendDevelopment,
  cancelDevelopment,
  checkDevelopment,
  correctDevelopmentRepository,
  startDevelopment,
} from "./tasks.ts";

export function codingExtension(
  store: Store,
  workspace: Workspace,
): BuiltinExtension {
  const pinned = { coding: workspace.coding, github: workspace.github };
  const hash = fingerprint(pinned);
  const targets = (workspace.github?.repositories ?? []).map((r) => ({
    repositoryId: r.id,
    repository: r.full_name,
    baseBranch: r.default_branch,
  }));
  return {
    id: "codex-coding",
    version: "1",
    path: "<inline:codex-coding>",
    tools: [
      "start_development_task",
      "send_development_input",
      "ask_development_task",
      "development_task_conversation",
      "development_task_status",
      "cancel_development_task",
    ],
    execution: "read-only",
    enabled: true,
    workspaces: [workspace.id],
    hash,
    toolErrorCodes: [
      "coding_disabled",
      "coding_local_configuration_required",
      "github_user_connection_required",
      "github_user_access_denied",
      "github_user_access_unavailable",
      "github_default_branch_unavailable",
      "github_repository_not_connected",
      "coding_source_required",
      "coding_current_request_required",
      "coding_capacity_reached",
      "extension_configuration_changed",
      "coding_message_conflict",
      "coding_message_capacity",
      "coding_task_stopped",
      "coding_repository_target_unverified",
      "coding_repository_target_ambiguous",
      "coding_repository_target_mismatch",
      "coding_repository_replacement_unsafe",
      "coding_task_conflict",
    ],
    factory: (input) => async (pi) => {
      const accessibleTargets = targets.filter((t) =>
        verifiedRepositoryAccess(workspace, input.actor, t.repositoryId, true),
      );
      const operate = async (action: (w: Workspace, sql: Sql) => unknown) => {
        input.signal.throwIfAborted();
        await input.guard();
        return store.change(workspace.id, async (w, sql) => {
          input.signal.throwIfAborted();
          authorize(w, input.actor);
          const run = w.runs.find((r) => r.id === input.runId);
          requireThat(
            run &&
              run.actor === input.actor &&
              run.status === "running" &&
              runAllowed(w, run),
            "run_revoked",
            409,
          );
          requireThat(
            fingerprint({ coding: w.coding, github: w.github }) === hash,
            "extension_configuration_changed",
            409,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(await action(w, sql)),
              },
            ],
            details: {},
          };
        });
      };
      if (targets.length)
        pi.registerTool({
          name: "start_development_task",
          label: "Start continuous Codex task",
          description: `Start a coding task for a clear implementation/fix request or an explicit request to use Codex. Handle ordinary conversation, explanations, status and PR review with the assistant's available read tools. An existing task in this topic does not authorize another Codex turn. Use query_work_handoff to resolve an existing task before starting new work; send_development_input continues changes to that task/PR and can correct an unchanged task's repository. Relay the authenticated GitHub collaborator's ORIGINAL received message. Codex owns technical decisions and necessary product questions within the coding task. Do not write a technical plan or issue body. Distinguish the repository to MODIFY from repositories supplying documentation, examples or other reference material. For 'add docs to product-land using https://github.com/acme/product/blob/main/docs/README.md', resolve product-land to the connected landing repository; the linked product docs are a reference source. Quote the target name in targetRepository and match its repositoryId. Resolve an unambiguous abbreviation against accessible repositories; ask one plain-language target question only if it remains ambiguous. A target validation failure creates no task: correct the selection rather than retrying the same wrong ID. Source IDs must include this run's request. If github_user_connection_required is returned, tell the user to send /github in this bot's private chat to connect their GitHub account, follow the authorization link, return to confirm the account, then resend their request. Include the /github command explicitly in the reply. Accessible repositories: ${JSON.stringify(accessibleTargets)}.`,
          parameters: Type.Object({
            repositoryId: Type.Integer(),
            targetRepository: Type.String({
              maxLength: 300,
              description:
                "Copy the human's name/owner-name for the repository to MODIFY verbatim, e.g. product-land. Do not quote a documentation URL or reference source. Use an empty string only when the target is implicit in retained conversation context.",
            }),
            sourceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
          }),
          execute: async (_id, args) =>
            operate(async (w, sql) => {
              const deployment = await store.deployment(sql);
              requireThat(deployment.bot, "bot_not_configured", 409);
              const task = await startDevelopment(
                sql,
                w,
                input.runId,
                input.actor,
                Number(args.repositoryId),
                args.sourceIds as string[],
                deployment.bot.id,
                String(args.targetRepository ?? ""),
              );
              return {
                taskId: task.id,
                state: task.state,
                repository: task.payload.repository,
                baseBranch: task.payload.baseBranch,
                message:
                  task.state === "queued" && !task.cancelRequested
                    ? "Original request queued for Codex. Do not add technical decisions or invent completion."
                    : developmentStatus(task),
              };
            }),
        });
      pi.registerTool({
        name: "send_development_input",
        label: "Relay original Codex task input",
        description:
          "Continue an existing coding task only for a clear request to change its code, an answer to its pending question, or an explicit request to use Codex. Resolve the task with query_work_handoff or development_task_status. Compare its repository with the human's MODIFY target, keeping documentation/reference repositories separate. If the human explicitly corrects a wrongly bound target, pass the corrected repositoryId and quote it in targetRepository: the application atomically replaces only an idle task with confirmed no changes or PR, retains original requirements, and rechecks permissions. Never send a repository correction as an ordinary answer to the wrong checkout. If coding_repository_replacement_unsafe is returned, explain that existing work or uncertain state must be inspected; do not cancel/recreate or bypass this safeguard. A shared topic, request to review a PR, explanation or acknowledgement alone must not resume coding. For 'what does checkout mean?' read the task state and explain its actual blocker in plain language. Preserve the received authenticated message verbatim; Codex handles technical choices within the task.",
        parameters: Type.Object({
          taskId: Type.String(),
          sourceId: Type.String(),
          repositoryId: Type.Integer({
            description:
              "The repository to modify after considering the current message; use the task's repository for an ordinary continuation.",
          }),
          targetRepository: Type.String({
            maxLength: 300,
            description:
              "Quote the human's explicit modification target verbatim, or an empty string for an implicit continuation. A corrected repository requires a nonempty quote from this message.",
          }),
        }),
        execute: async (_id, args) =>
          operate(async (w, sql) => {
            let task = await taskGet(sql, w.id, String(args.taskId));
            const source = w.messages.find((s) => s.id === args.sourceId);
            const run = w.runs.find((r) => r.id === input.runId);
            requireThat(
              source &&
                run &&
                (source.runId === run.id ||
                  source.id.endsWith(`:${run.replyTo}`)),
              "coding_current_request_required",
              409,
            );
            if (
              args.repositoryId !== undefined &&
              Number(args.repositoryId) !== task.payload.repositoryId
            ) {
              const deployment = await store.deployment(sql);
              requireThat(
                deployment.bot?.id === task.botId,
                "coding_bot_changed",
                409,
              );
              task = await correctDevelopmentRepository(
                sql,
                w,
                task,
                input.runId,
                input.actor,
                Number(args.repositoryId),
                source.id,
                task.botId,
                String(args.targetRepository ?? ""),
              );
            } else {
              requireRepositoryTarget(
                w,
                task.payload.repositoryId,
                [source.text],
                String(args.targetRepository ?? ""),
              );
              await appendDevelopment(
                sql,
                w,
                task,
                input.actor,
                source,
                `${source.id}:relay`,
              );
            }
            run.codingTaskId = task.id;
            return {
              taskId: task.id,
              revision: task.revision,
              state: task.state,
              repository: task.payload.repository,
              replacesTaskId: task.replacesTaskId,
              receipt: {
                state: "received",
                receivedRevision: task.revision,
                dispatchedRevision: task.consumedRevision,
                readRevision: task.readRevision ?? 0,
                verifiedRevision: task.verifiedRevision,
              },
            };
          }),
      });
      pi.registerTool({
        name: "ask_development_task",
        label: "Ask the Codex task",
        description:
          "Ask Codex a factual question about an existing task's current work, choices or blockers, including while it runs. You may formulate a technical follow-up yourself within the user's request. This is conversation only: it cannot add requirements, make product decisions, implement code or authorize publication. Use send_development_input with the original user source for changes. Resolve the task first; read development_task_conversation for replies. A queued or received message is not yet read or answered. The response is delivered asynchronously in this same conversation; do not invent it or repeatedly poll in one chat run.",
        parameters: Type.Object({
          taskId: Type.String(),
          question: Type.String({ minLength: 1, maxLength: 4000 }),
        }),
        execute: async (callId, args) =>
          operate(async (w, sql) => {
            const task = await taskGet(sql, w.id, String(args.taskId));
            const run = w.runs.find((r) => r.id === input.runId);
            requireThat(run, "run_revoked", 409);
            const message = await askTask(
              sql,
              w,
              task,
              run,
              callId,
              String(args.question),
            );
            run.codingTaskId = task.id;
            return {
              taskId: task.id,
              message: exchangeView(message),
              delivery: "asynchronous",
            };
          }),
      });
      pi.registerTool({
        name: "development_task_conversation",
        label: "Read the Codex task conversation",
        description:
          "Read saved questions, actual Codex answers and message receipts for the current audience's task. Received, read and answered are distinct. Requirement revisions report dispatch and verification separately; a conversation answer never proves a change was implemented. Task completion retains this history. Use bounded pages instead of repeated status polling.",
        parameters: Type.Object({
          taskId: Type.String(),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
        execute: async (_id, args) =>
          operate(async (w, sql) => {
            const task = await taskGet(sql, w.id, String(args.taskId));
            const run = w.runs.find((r) => r.id === input.runId);
            requireThat(run, "run_revoked", 409);
            conversationAudience(w, task, run);
            const messages = await taskExchanges(sql, task);
            const { offset, limit } = conversationPage.parse({
              offset: args.offset,
              limit: args.limit,
            });
            return {
              taskId: task.id,
              state: task.state,
              requirements: {
                receivedRevision: task.revision,
                readRevision: task.readRevision ?? 0,
                dispatchedRevision: task.consumedRevision,
                verifiedRevision: task.verifiedRevision,
              },
              messages: messages
                .slice(offset, offset + limit)
                .map(exchangeView),
              total: messages.length,
              nextOffset:
                offset + limit < messages.length ? offset + limit : undefined,
              progress: task.progress,
              result: task.result?.summary,
              question: task.question?.text,
              pr: task.pr?.url,
            };
          }),
      });
      for (const cancel of [false, true])
        pi.registerTool({
          name: cancel ? "cancel_development_task" : "development_task_status",
          label: cancel ? "Stop continuous task" : "Continuous task status",
          description: cancel
            ? "Stop the user's continuous Codex task immediately when requested."
            : "Read the actual task state, repository, branch, recorded blocker and pending question before explaining status or task terms such as checkout. Waiting means blocked, not preparing or queued. A repository mismatch needs application routing; never ask the user to provide a checkout, container or filesystem path.",
          parameters: Type.Object({ taskId: Type.String() }),
          execute: async (_id, args) =>
            operate(async (w, sql) => {
              const task = cancel
                ? await cancelDevelopment(
                    sql,
                    w,
                    input.actor,
                    String(args.taskId),
                  )
                : await taskGet(sql, w.id, String(args.taskId));
              checkDevelopment(w, task, input.actor, cancel);
              const run = w.runs.find((r) => r.id === input.runId);
              requireThat(run, "run_revoked", 409);
              requireThat(
                task.chatId === run.chatId && task.topicId === run.topicId,
                "access_denied",
                403,
              );
              return {
                taskId: task.id,
                state: task.state,
                repository: task.payload.repository,
                baseBranch: task.payload.baseBranch,
                summary: task.result?.summary,
                hasChanges: task.hasChanges,
                replacesTaskId: task.replacesTaskId,
                replacementTaskId: task.replacementTaskId,
                revision: task.revision,
                consumedRevision: task.consumedRevision,
                readRevision: task.readRevision ?? 0,
                verifiedRevision: task.verifiedRevision,
                question: task.question?.text,
                pr: task.pr?.url,
                error: task.error,
              };
            }),
        });
    },
  };
}
