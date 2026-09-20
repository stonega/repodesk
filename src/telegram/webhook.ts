import { ZodError } from "zod";
import { type Sql, transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Deployment,
  Fault,
  requireThat,
  timezone,
  type Workspace,
} from "../domain.ts";
import { requestDeletion } from "../privacy/service.ts";
import { hash, token } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import {
  decide,
  proposeInstruction,
  workflowAction,
} from "../workflows/service.ts";
import {
  audit,
  authorize,
  eligible,
  revokeWork,
} from "../workspaces/policy.ts";
import {
  cancelRun,
  createRun,
  deliver,
  enrollOwner,
  visibleRuns,
} from "../workspaces/service.ts";
import { command, type Update } from "./router.ts";
export class Ingress {
  constructor(
    private store: Store,
    private setup: SetupService,
  ) {}
  async accept(update: Update) {
    const d = await this.store.deployment();
    requireThat(d.bot, "bot_not_configured", 503);
    const msg = update.message;
    const cmd = msg ? command(msg, d.bot) : undefined;
    let verifiedAdmin = false;
    if (
      cmd?.name === "link" &&
      msg?.from &&
      !msg.sender_chat &&
      ["group", "supergroup"].includes(msg.chat.type)
    ) {
      const membership = await (await this.setup.client()).call<{
        status: string;
      }>("getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
      verifiedAdmin = ["creator", "administrator"].includes(membership.status);
    }
    const result = await transaction(this.store.pool, async (sql) => {
      const accepted = await sql.query(
        "INSERT INTO inbox(bot_id,update_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [d.bot?.id, update.update_id],
      );
      if (!accepted.rowCount) return { duplicate: true };
      const workspace = await this.resolve(sql, update, d);
      if (
        !workspace ||
        (msg?.chat.type === "private" &&
          msg.from &&
          !eligible(workspace, String(msg.from.id)) &&
          !cmd?.args.startsWith("verify_"))
      ) {
        if (
          msg?.chat.type === "private" &&
          msg.from &&
          !msg.from.is_bot &&
          !msg.sender_chat
        )
          await sql.query(
            "INSERT INTO control_deliveries(bot_id,update_id,actor) SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM control_deliveries WHERE actor=$3 AND created_at>now()-interval '1 minute')",
            [d.bot?.id, update.update_id, String(msg.from.id)],
          );
        return { ignored: true };
      }
      await sql.query(
        "UPDATE inbox SET workspace_id=$3 WHERE bot_id=$1 AND update_id=$2",
        [d.bot?.id, update.update_id, workspace.id],
      );
      try {
        if (workspace.deletion) return { ignored: true };
        const handled = await this.handleControl(
          sql,
          workspace,
          update,
          d,
          verifiedAdmin,
        );
        if (!handled && d.active && !d.paused)
          await this.handleMessage(workspace, update, d);
      } catch (error) {
        if (!(error instanceof Fault) && !(error instanceof ZodError))
          throw error;
        const actor = msg?.from && String(msg.from.id);
        if (actor && msg.chat.type === "private" && eligible(workspace, actor))
          deliver(
            workspace,
            actor,
            actor,
            `Unable to complete: ${error instanceof Fault ? error.code : "invalid_command_arguments"}. Use /help or contact your workspace admin.`,
            { id: `event:${update.update_id}:error` },
          );
      }
      await this.store.save(sql, workspace);
      return { accepted: true };
    });
    if (update.callback_query) {
      try {
        await (await this.setup.client()).call("answerCallbackQuery", {
          callback_query_id: update.callback_query.id,
          text: "Request checked. See the bot or admin panel for status.",
        });
      } catch {
        /* Callback acknowledgements have no application effect. */
      }
    }
    return result;
  }
  private async resolve(
    sql: Sql,
    u: Update,
    d: Deployment,
  ): Promise<Workspace | undefined> {
    const message = u.message ?? u.edited_message;
    const actor = message?.from?.id ?? u.callback_query?.from.id;
    const c =
      message?.chat ??
      u.my_chat_member?.chat ??
      u.chat_member?.chat ??
      u.callback_query?.message?.chat;
    const cmd = message && d.bot ? command(message, d.bot) : undefined;
    let id: string | undefined;
    if (
      cmd?.name === "start" &&
      cmd.args.startsWith("verify_") &&
      c?.type === "private"
    ) {
      const digest = hash(cmd.args.slice(7));
      const rows = await sql.query(
        "SELECT id FROM workspaces WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'tokens') t WHERE t->>'hash'=$1 AND t->>'kind'='identity')",
        [digest],
      );
      id = rows.rows[0]?.id;
    } else if (cmd?.name === "link" && c?.type !== "private") {
      const digest = hash(cmd.args);
      id = (
        await sql.query(
          "SELECT id FROM workspaces WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'tokens') t WHERE t->>'hash'=$1 AND t->>'kind'='group')",
          [digest],
        )
      ).rows[0]?.id;
    } else if (c && c.type !== "private")
      id = (
        await sql.query(
          "SELECT workspace_id FROM chat_bindings WHERE chat_id=$1",
          [String(c.id)],
        )
      ).rows[0]?.workspace_id;
    else if (actor) {
      if (
        cmd?.name === "workspace" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          cmd.args,
        )
      ) {
        const target = await this.store.read(cmd.args, sql);
        if (!eligible(target, String(actor))) return undefined;
        await sql.query(
          "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
          [String(actor), target.id],
        );
        id = target.id;
      } else
        id = (
          await sql.query(
            "SELECT workspace_id FROM telegram_selections WHERE actor=$1",
            [String(actor)],
          )
        ).rows[0]?.workspace_id;
      if (!id) {
        const rows = await sql.query(
          "SELECT id FROM workspaces WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'members') m WHERE m->>'id'=$1 AND m->>'active'='true') ORDER BY id",
          [String(actor)],
        );
        if (rows.rows.length === 1) id = rows.rows[0]?.id;
      }
    }
    return id ? this.store.read(id, sql, true) : undefined;
  }
  private async handleControl(
    sql: Sql,
    w: Workspace,
    u: Update,
    d: Deployment,
    verifiedAdmin: boolean,
  ) {
    const msg = u.message;
    const cmd = msg && d.bot ? command(msg, d.bot) : undefined;
    const actor = msg?.from && String(msg.from.id);
    if (
      cmd?.name === "start" &&
      cmd.args.startsWith("verify_") &&
      actor &&
      msg?.chat.type === "private"
    ) {
      const entry = w.tokens.find(
        (t) =>
          t.kind === "identity" &&
          t.hash === hash(cmd.args.slice(7)) &&
          Date.parse(t.expiresAt) > Date.now(),
      );
      requireThat(entry?.adminId, "verification_expired", 403);
      const admin = (
        await sql.query(
          "SELECT id,telegram_id,operator FROM admins WHERE id=$1 FOR UPDATE",
          [entry.adminId],
        )
      ).rows[0];
      requireThat(
        admin && (!admin.telegram_id || admin.telegram_id === actor),
        "identity_already_linked",
        409,
      );
      if (
        w.operatorId === admin.id &&
        !w.members.some((m) => m.role === "owner")
      )
        enrollOwner(w, actor);
      else authorize(w, actor);
      await sql.query("UPDATE admins SET telegram_id=$2 WHERE id=$1", [
        admin.id,
        actor,
      ]);
      await sql.query("DELETE FROM sessions WHERE admin_id=$1", [admin.id]);
      await sql.query(
        "INSERT INTO telegram_selections(actor,workspace_id) VALUES($1,$2) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
        [actor, w.id],
      );
      w.tokens = w.tokens.filter((t) => t !== entry);
      deliver(
        w,
        actor,
        actor,
        `Identity verified for ${w.settings.name}. Sign in again to the panel. Timezone: ${w.settings.timezone}. Confirm with /timezone ${w.settings.timezone}.`,
      );
      return true;
    }
    if (!d.active || d.paused) return true;
    if (cmd?.name === "link" && actor && msg) {
      authorize(w, actor, true);
      requireThat(verifiedAdmin, "telegram_admin_required", 403);
      const entry = w.tokens.find(
        (t) =>
          t.kind === "group" &&
          t.hash === hash(cmd.args) &&
          t.actor === actor &&
          Date.parse(t.expiresAt) > Date.now(),
      );
      requireThat(entry, "link_expired", 403);
      const chatId = String(msg.chat.id);
      requireThat(
        !w.chats.some((c) => c.active && c.id !== chatId),
        "one_group_per_workspace",
        409,
      );
      const inserted = await sql.query(
        "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING chat_id",
        [chatId, w.id],
      );
      if (!inserted.rowCount) {
        const existing = (
          await sql.query(
            "SELECT workspace_id FROM chat_bindings WHERE chat_id=$1",
            [chatId],
          )
        ).rows[0];
        requireThat(
          existing?.workspace_id === w.id,
          "group_already_claimed",
          409,
        );
      }
      w.chats = w.chats.filter((c) => c.id !== chatId);
      w.chats.push({
        id: chatId,
        active: true,
        collection: false,
        linkedAt: new Date().toISOString(),
        visibleAll: !!d.bot?.visibleAll,
      });
      w.tokens = w.tokens.filter((t) => t !== entry);
      audit(w, actor, "chat.linked", chatId);
      deliver(
        w,
        actor,
        chatId,
        "Group linked. Only directed messages are retained. An admin can explicitly enable received-message collection with /capture on.",
        { topicId: msg.message_thread_id },
      );
      return true;
    }
    const membership = u.my_chat_member ?? u.chat_member;
    if (membership) {
      const changed = String(membership.new_chat_member.user.id);
      const status = membership.new_chat_member.status;
      if (["left", "kicked"].includes(status)) {
        if (changed === d.bot?.id) {
          const chat = w.chats.find((c) => c.id === String(membership.chat.id));
          if (chat) chat.active = false;
        } else {
          const member = w.members.find((m) => m.id === changed);
          if (member) member.active = false;
        }
        revokeWork(w);
        audit(w, changed, "membership.removed", String(membership.chat.id));
      }
      return true;
    }
    if (u.callback_query) {
      const callback = u.callback_query;
      const [action, id] = callback.data?.split(":") ?? [];
      if (id && ["approve", "reject"].includes(action ?? "")) {
        const sender = String(callback.from.id);
        requireThat(!callback.from.is_bot, "access_denied", 403);
        decide(w, sender, id, action === "approve");
        deliver(
          w,
          sender,
          sender,
          `Proposal ${action === "approve" ? "approved" : "rejected"}.`,
        );
      }
      return true;
    }
    if (msg?.migrate_to_chat_id) {
      // Migration suspends delivery until a workspace admin verifies and links the new destination.
      const old = w.chats.find((c) => c.id === String(msg.chat.id));
      if (old) old.active = false;
      await sql.query("DELETE FROM chat_bindings WHERE workspace_id=$1", [
        w.id,
      ]);
      revokeWork(w);
      audit(
        w,
        "telegram",
        "chat.migration_requires_relink",
        String(msg.chat.id),
      );
      return true;
    }
    return false;
  }
  private async handleMessage(w: Workspace, u: Update, d: Deployment) {
    const msg = u.message ?? u.edited_message;
    if (!msg || msg.from?.is_bot || msg.sender_chat || !msg.from || !d.bot)
      return;
    const actor = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const topic = msg.message_thread_id ?? 0;
    const cmd = command(msg, d.bot);
    const chat = w.chats.find((c) => c.id === chatId && c.active);
    if (msg.chat.type !== "private" && !chat) return;
    const sourceId = `${chatId}:${msg.message_id}`;
    if (u.edited_message) {
      const previous = w.messages.find(
        (s) => s.id === sourceId && s.author === actor,
      );
      if (previous && msg.text) previous.text = msg.text.slice(0, 12000);
      return;
    }
    if ((eligible(w, actor) && cmd) || (chat?.collection && msg.text)) {
      if (msg.text && !w.messages.some((s) => s.id === sourceId))
        w.messages.push({
          id: sourceId,
          chatId,
          topicId: topic,
          author: actor,
          text: msg.text.slice(0, 12000),
          at: new Date(msg.date * 1000).toISOString(),
          expiresAt: new Date(
            Date.now() + w.settings.retentionDays * 86400000,
          ).toISOString(),
          directed: !!cmd,
        });
      w.messages = w.messages.slice(-2000);
    }
    if (!cmd || !eligible(w, actor)) return;
    const reply = (
      text: string,
      buttons?: Workspace["deliveries"][number]["buttons"],
    ) =>
      deliver(w, actor, chatId, text, {
        topicId: topic,
        replyTo: msg.message_id,
        buttons,
        id: `event:${u.update_id}:reply`,
      });
    const offer = (approval: { id: string }, text: string) =>
      reply(text, [
        [
          { text: "Approve", callback_data: `approve:${approval.id}` },
          { text: "Reject", callback_data: `reject:${approval.id}` },
        ],
      ]);
    switch (cmd.name) {
      case "start":
      case "help":
        reply(
          `DeepX Agent · ${w.settings.name}\nTimezone: ${w.settings.timezone}\n/ask <request>, /recap, /status, /cancel <run>, /automations, /memory, /usage, /privacy\nAdmins: /linktoken, /capture on|off, /timezone <IANA>, /remember <instruction>\nContext contains only received retained messages. Access is managed in the admin panel. /workspace <id> selects a workspace.`,
        );
        break;
      case "workspace":
        reply(`Selected ${w.settings.name} (${w.id})`);
        break;
      case "timezone":
        authorize(w, actor, true);
        w.settings.timezone = timezone.parse(cmd.args);
        w.version++;
        audit(w, actor, "timezone.confirmed", w.id, w.version);
        reply(`Timezone confirmed: ${w.settings.timezone}`);
        break;
      case "linktoken": {
        authorize(w, actor, true);
        requireThat(msg.chat.type === "private", "use_private_chat");
        const raw = token();
        w.tokens.push({
          hash: hash(raw),
          actor,
          kind: "group",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
        reply(
          `As a Telegram group admin, send /link ${raw} in the intended group within 10 minutes.`,
        );
        break;
      }
      case "capture": {
        authorize(w, actor, true);
        requireThat(
          chat && ["on", "off"].includes(cmd.args),
          "use_in_linked_group_with_on_or_off",
        );
        requireThat(
          cmd.args !== "on" || chat.visibleAll,
          "disable_bot_privacy_and_revalidate_visibility_first",
        );
        chat.collection = cmd.args === "on";
        chat.consentBy = actor;
        chat.consentAt = new Date().toISOString();
        audit(w, actor, "chat.collection_changed", chat.id);
        reply(
          chat.collection
            ? "Collection enabled with admin consent. Received group messages, including messages by people outside the whitelist, may appear in team recaps. Old history is unavailable."
            : "Collection disabled. Only directed messages will be stored.",
        );
        break;
      }
      case "status": {
        const runs = visibleRuns(w, actor)
          .filter((r) => r.chatId === chatId)
          .slice(-5);
        reply(
          runs.map((r) => `${r.id}: ${r.status}`).join("\n") || "No runs yet.",
        );
        break;
      }
      case "cancel":
        cancelRun(w, actor, cmd.args);
        reply("Cancellation recorded. Messages already sent cannot be undone.");
        break;
      case "automations": {
        const [action, id] = cmd.args.split(/\s+/);
        if (id && ["pause", "resume", "delete", "run"].includes(action ?? "")) {
          const f = w.workflows.find((f) => f.id === id);
          requireThat(f, "not_found", 404);
          workflowAction(
            w,
            actor,
            id,
            action as "pause" | "resume" | "delete" | "run",
            f.version,
            d.model,
          );
          reply(`Workflow ${action} applied.`);
        } else
          reply(
            w.workflows
              .filter(
                (f) =>
                  f.status !== "deleted" &&
                  (f.spec.chatId === chatId ||
                    (f.owner === actor && msg.chat.type === "private")),
              )
              .map(
                (f) =>
                  `${f.id} · ${f.spec.name} · ${f.status} · ${f.nextAt ?? "not scheduled"}`,
              )
              .join("\n") ||
              "No workflows. Ask me to propose a daily or weekly recap; approve its exact preview before it runs.",
          );
        break;
      }
      case "remember": {
        const scope = msg.chat.type === "private" ? "personal" : "workspace";
        const approval = proposeInstruction(
          w,
          actor,
          cmd.args,
          scope,
          sourceId,
        );
        offer(approval, `Save this ${scope} instruction?\n${cmd.args}`);
        break;
      }
      case "memory": {
        const [action, id, ...body] = cmd.args.split(/\s+/);
        if (action === "edit" && id) {
          const i = w.instructions.find((i) => i.id === id && i.active);
          requireThat(i, "not_found", 404);
          requireThat(
            i.scope !== "personal" ||
              (i.author === actor && msg.chat.type === "private"),
            "access_denied",
            403,
          );
          offer(
            proposeInstruction(
              w,
              actor,
              body.join(" "),
              i.scope,
              sourceId,
              i.workflowId,
              i.id,
            ),
            `Replace ${i.scope} instruction v${i.version}?\n${body.join(" ")}`,
          );
        } else if (action === "forget" && id) {
          const i = w.instructions.find((i) => i.id === id && i.active);
          requireThat(i, "not_found", 404);
          authorize(w, actor, i.scope !== "personal");
          requireThat(
            i.scope !== "personal" || i.author === actor,
            "access_denied",
            403,
          );
          i.active = false;
          i.body = "";
          i.version++;
          audit(w, actor, "instruction.forgotten", id, i.version);
          reply("Instruction forgotten for future runs.");
        } else
          reply(
            w.instructions
              .filter(
                (i) =>
                  i.active &&
                  (i.scope === "workspace" ||
                    (msg.chat.type === "private" && i.author === actor)),
              )
              .map((i) => `${i.id} (${i.scope}, v${i.version}): ${i.body}`)
              .join("\n") ||
              "No saved instructions. Use /remember to propose one.",
          );
        break;
      }
      case "usage": {
        const attempts = w.runs.flatMap((r) => r.attempts);
        reply(
          `Recorded usage: $${attempts.reduce((sum, a) => sum + (a.actual ?? a.reserved), 0).toFixed(4)} including reservations. Monthly cap: $${w.settings.monthlyBudgetUsd}. Unknown charges remain reserved.`,
        );
        break;
      }
      case "settings":
        reply(
          `Timezone: ${w.settings.timezone}\nRetention: ${w.settings.retentionDays} days\nAccess: ${w.policy.mode}\nSettings version: ${w.version}\nUse the admin panel for configuration.`,
        );
        break;
      case "privacy":
        if (cmd.args === "delete") {
          requireThat(msg.chat.type === "private", "use_private_chat");
          offer(
            requestDeletion(w, actor),
            "Delete all content and disable this workspace? This is irreversible. Provider retention follows your provider account policy.",
          );
        } else
          reply(
            `Messages and derived context are retained up to ${w.settings.retentionDays} days. Group collection: ${chat?.collection ? "enabled with consent" : "directed only"}. No old Telegram history. Admins can request workspace deletion in the panel or with /privacy delete in private.`,
          );
        break;
      case "correct": {
        const previous = w.deliveries.find(
          (d) =>
            d.chatId === chatId &&
            d.topicId === topic &&
            d.remoteId === msg.reply_to_message?.message_id,
        );
        const prior = previous?.runId
          ? w.runs.find((r) => r.id === previous.runId)
          : undefined;
        requireThat(prior, "reply_to_a_run_to_correct");
        const [mode, ...parts] = cmd.args.split(/\s+/);
        const body = parts.join(" ");
        if (mode === "once" && body) {
          const run = createRun(
            w,
            actor,
            `${prior.task.slice(0, 2000)}\nFor this run only: ${body}`,
            chatId,
            topic,
            d.model,
            { replyTo: msg.reply_to_message?.message_id },
          );
          reply(`Correction queued for this run only: ${run.id}`);
        } else if (mode === "save" && body) {
          requireThat(prior.workflowId, "source_run_has_no_workflow");
          offer(
            proposeInstruction(
              w,
              actor,
              body,
              "workflow",
              prior.id,
              prior.workflowId,
            ),
            `Apply this correction to future workflow runs?\n${body}`,
          );
        } else
          reply(
            "Reply to a run with /correct once <correction> for one output, or /correct save <correction> to propose a change to its workflow.",
          );
        break;
      }
      case "recap":
      case "ask": {
        if (!msg.text) {
          reply(
            "This pilot supports text only. Send a text request with /ask.",
          );
          break;
        }
        const previousDelivery = w.deliveries.find(
          (d) =>
            d.chatId === chatId &&
            d.topicId === topic &&
            d.remoteId === msg.reply_to_message?.message_id,
        );
        const previousRun = previousDelivery?.runId
          ? w.runs.find((r) => r.id === previousDelivery.runId)
          : undefined;
        const workflow = previousRun?.workflowId
          ? w.workflows.find(
              (f) =>
                f.id === previousRun.workflowId &&
                f.owner === actor &&
                f.status === "active",
            )
          : undefined;
        const run = createRun(
          w,
          actor,
          cmd.name === "recap"
            ? "Create a source-grounded team recap. Include decisions, blockers and next steps. State coverage and gaps."
            : cmd.args,
          chatId,
          topic,
          d.model,
          {
            replyTo: msg.reply_to_message?.message_id,
            workflowId: workflow?.id,
          },
        );
        reply(`Queued ${run.id}. Use /status or /cancel ${run.id}.`);
        break;
      }
      default:
        reply("Unknown command. Use /help.");
    }
  }
}
