import { ZodError } from "zod";
import { codingFailureMessage } from "../coding/failure-messages.ts";
import { routeDevelopment, selectDevelopment } from "../coding/telegram.ts";
import { type Sql, transaction } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Deployment,
  Fault,
  requireThat,
  timezone,
  type Workspace,
} from "../domain.ts";
import type { GitHubUsers } from "../github/users.ts";
import { requestDeletion } from "../privacy/service.ts";
import { hash, token } from "../setup/credentials.ts";
import type { SetupService } from "../setup/service.ts";
import {
  decide,
  proposeInstruction,
  workflowAction,
} from "../workflows/service.ts";
import { requestAccess } from "../workspaces/access-requests.ts";
import { updateMemberProfile } from "../workspaces/member-profile.ts";
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
import { messageAttachments, messageText } from "./attachments.ts";
import { requestFailureMessage } from "./feedback.ts";
import { closeGroupAttention, followupCandidate } from "./followup.ts";
import { stopGeneration } from "./generation.ts";
import { command, type Update } from "./router.ts";
import { selectTaskControl, taskControl } from "./task-controls.ts";

export class Ingress {
  constructor(
    private store: Store,
    private setup: SetupService,
    private githubUsers?: GitHubUsers,
  ) {}
  async accept(update: Update) {
    const d = await this.store.deployment();
    requireThat(d.bot, "bot_not_configured", 503);
    const botId = d.bot.id;
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
      if (update.stopped_message_generation) {
        const workspaceId = await stopGeneration(
          this.store,
          sql,
          botId,
          update.stopped_message_generation,
        );
        if (workspaceId)
          await sql.query(
            "UPDATE inbox SET workspace_id=$3 WHERE bot_id=$1 AND update_id=$2",
            [d.bot?.id, update.update_id, workspaceId],
          );
        return workspaceId ? { accepted: true } : { ignored: true };
      }
      const workspace = await this.resolve(sql, update, d);
      const callback = update.callback_query;
      const requester = callback?.from ?? msg?.from;
      const requestChat = callback?.message?.chat ?? msg?.chat;
      const accessCallback = callback?.data?.startsWith("request_access:");
      if (accessCallback) {
        let callbackText =
          "This request link is unavailable. Ask your admin for a new link.";
        if (
          workspace &&
          !workspace.deletion &&
          requester &&
          !requester.is_bot &&
          callback?.message?.from?.id === Number(d.bot?.id) &&
          callback.data === `request_access:${workspace.id}` &&
          requestChat &&
          (requestChat.type === "private"
            ? requestChat.id === requester.id
            : workspace.chats.some(
                (c) => c.active && c.id === String(requestChat.id),
              ))
        ) {
          if (eligible(workspace, String(requester.id))) {
            updateMemberProfile(workspace, {
              id: String(requester.id),
              username: requester.username,
              name:
                [requester.first_name, requester.last_name]
                  .filter(Boolean)
                  .join(" ") || undefined,
            });
            await this.store.save(sql, workspace);
            callbackText =
              "You already have access. Send /help to get started.";
          } else {
            try {
              const request = requestAccess(workspace, {
                actor: String(requester.id),
                username: requester.username,
                name:
                  [requester.first_name, requester.last_name]
                    .filter(Boolean)
                    .join(" ") || undefined,
                chatId: String(requestChat.id),
                topicId: callback.message.message_thread_id,
              });
              callbackText =
                request.status === "rejected"
                  ? "Your request was rejected. Contact your admin or try again after 24 hours."
                  : "Access requested. Your workspace admin can now review it.";
              await this.store.save(sql, workspace);
              await this.accessHelp(sql, update, d, workspace);
            } catch (error) {
              if (!(error instanceof Fault)) throw error;
              callbackText =
                "Unable to request access right now. Contact your workspace admin.";
            }
          }
        }
        return { accepted: true, callbackText };
      }
      if (
        !workspace ||
        (msg?.chat.type === "private" &&
          msg.from &&
          !eligible(workspace, String(msg.from.id)) &&
          !(cmd?.name === "start" && cmd.args.startsWith("verify_")))
      ) {
        if (msg?.chat.type === "private")
          await this.accessHelp(sql, update, d, workspace);
        return { ignored: true };
      }
      if (
        msg?.from &&
        cmd &&
        !eligible(workspace, String(msg.from.id)) &&
        !msg.sender_chat &&
        !msg.from.is_bot &&
        msg.chat.type !== "private"
      )
        await this.accessHelp(sql, update, d, workspace);
      await sql.query(
        "UPDATE inbox SET workspace_id=$3 WHERE bot_id=$1 AND update_id=$2",
        [d.bot?.id, update.update_id, workspace.id],
      );
      let callbackErrorText: string | undefined;
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
          await this.handleMessage(sql, workspace, update, d);
      } catch (error) {
        if (!(error instanceof Fault) && !(error instanceof ZodError))
          throw error;
        const actor = msg?.from
          ? String(msg.from.id)
          : callback?.from
            ? String(callback.from.id)
            : undefined;
        const explanation =
          error instanceof Fault &&
          (error.code.startsWith("coding_") || error.code.startsWith("github_"))
            ? codingFailureMessage(error.code)
            : requestFailureMessage(
                error instanceof Fault
                  ? error.code
                  : "invalid_command_arguments",
              );
        if (callback) callbackErrorText = explanation.slice(0, 180);
        if (
          actor &&
          requestChat &&
          (requestChat.type === "private"
            ? String(requestChat.id) === actor
            : !!cmd &&
              workspace.chats.some(
                (c) => c.active && c.id === String(requestChat.id),
              )) &&
          eligible(workspace, actor)
        )
          deliver(workspace, actor, String(requestChat.id), explanation, {
            id: `event:${update.update_id}:error`,
            topicId:
              msg?.message_thread_id ??
              callback?.message?.message_thread_id ??
              0,
            replyTo: msg?.message_id,
          });
      }
      if (
        requester &&
        !requester.is_bot &&
        !msg?.sender_chat &&
        requestChat &&
        (requestChat.type === "private"
          ? requestChat.id === requester.id
          : workspace.chats.some(
              (c) => c.active && c.id === String(requestChat.id),
            ))
      ) {
        updateMemberProfile(workspace, {
          id: String(requester.id),
          username: requester.username,
          name:
            [requester.first_name, requester.last_name]
              .filter(Boolean)
              .join(" ") || undefined,
        });
      }
      const groupMessage = update.message ?? update.edited_message;
      const group =
        groupMessage?.chat ??
        update.my_chat_member?.chat ??
        update.chat_member?.chat;
      const title = (groupMessage?.new_chat_title ?? group?.title)?.trim();
      if (group && title && ["group", "supergroup"].includes(group.type)) {
        const chat = workspace.chats.find((c) => c.id === String(group.id));
        if (chat) chat.title = title;
      }
      await this.store.save(sql, workspace);
      return { accepted: true, callbackText: callbackErrorText };
    });
    if (update.callback_query) {
      try {
        const fallback = /^t[rcd][cs]:/.test(update.callback_query.data ?? "")
          ? ""
          : "Request checked. See the bot or admin panel for status.";
        await (await this.setup.client()).call("answerCallbackQuery", {
          callback_query_id: update.callback_query.id,
          text:
            "callbackText" in result
              ? (result.callbackText ?? fallback)
              : fallback,
        });
      } catch {
        /* Callback acknowledgements have no application effect. */
      }
    }
    return result;
  }
  private async accessHelp(sql: Sql, u: Update, d: Deployment, w?: Workspace) {
    const from = u.callback_query?.from ?? u.message?.from;
    const message = u.callback_query?.message ?? u.message;
    if (!from || from.is_bot || !message || message.sender_chat || w?.deletion)
      return;
    const chatId = String(message.chat.id);
    if (
      message.chat.type === "private"
        ? chatId !== String(from.id)
        : !w?.chats.some((c) => c.active && c.id === chatId)
    )
      return;
    // Serialize each actor's fixed replies so concurrent updates cannot evade throttling.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `access-help:${from.id}`,
    ]);
    await sql.query(
      `INSERT INTO control_deliveries(bot_id,update_id,actor,workspace_id,chat_id,topic_id)
       SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS
       (SELECT 1 FROM control_deliveries WHERE bot_id=$1 AND actor=$3
         AND workspace_id IS NOT DISTINCT FROM $4::uuid
         AND chat_id IS NOT DISTINCT FROM $5
         AND topic_id IS NOT DISTINCT FROM $6
         AND created_at>now()-interval '1 minute')`,
      [
        d.bot?.id,
        u.update_id,
        String(from.id),
        w?.id ?? null,
        chatId,
        message.message_thread_id ?? null,
      ],
    );
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
    const requestedId = u.callback_query?.data?.startsWith("request_access:")
      ? u.callback_query.data.slice(15)
      : cmd?.name === "start" && cmd.args.startsWith("access_")
        ? cmd.args.slice(7)
        : undefined;
    if (requestedId !== undefined && c?.type === "private") {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          requestedId,
        )
      )
        return;
      const row = await sql.query(
        "SELECT data FROM workspaces WHERE id=$1 AND NOT (data ? 'deletion') FOR UPDATE",
        [requestedId],
      );
      return row.rows[0]?.data as Workspace | undefined;
    }
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
      if (!id && c?.type === "private") {
        // Only infer a tenant when there is exactly one configured workspace.
        const rows = await sql.query(
          "SELECT id FROM workspaces WHERE NOT (data ? 'deletion') AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'members') m WHERE m->>'role'='owner' AND m->>'active'='true') LIMIT 2",
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
    if (d.bot && (await selectDevelopment(sql, w, u, d.bot.id))) return true;
    if (d.bot && (await selectTaskControl(sql, w, u, d.bot.id))) return true;
    const msg = u.message;
    const cmd = msg && d.bot ? command(msg, d.bot) : undefined;
    const actor = msg?.from && String(msg.from.id);
    if (
      d.bot &&
      msg &&
      cmd &&
      eligible(w, actor ?? "") &&
      (await taskControl(sql, w, u, d.bot.id, msg, cmd))
    )
      return true;
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
    if (cmd?.name === "github" && actor && msg) {
      authorize(w, actor);
      requireThat(
        !msg.from?.is_bot &&
          !msg.sender_chat &&
          msg.chat.type === "private" &&
          String(msg.chat.id) === actor,
        "use_private_chat",
        403,
      );
      requireThat(this.githubUsers && d.bot, "github_app_not_configured", 409);
      let text: string;
      if (cmd.args === "disconnect") {
        await this.githubUsers.disconnect(sql, w, actor);
        text =
          "GitHub account disconnected. Send /github connect to authorize again.";
      } else if (cmd.args === "sync") {
        const access = await this.githubUsers.sync(sql, w, actor);
        text =
          access.status === "connected"
            ? `GitHub permissions synced for ${access.repositories.length} selected repositories.`
            : "GitHub permissions could not be synced. Repository access is blocked. Send /github connect to authorize again.";
      } else if (!cmd.args || cmd.args === "connect") {
        const url = await this.githubUsers.begin(sql, w, actor, d.bot.id);
        text = `Connect your GitHub account within 10 minutes:\n${url}\nThen return here to confirm your account.`;
      } else text = "Use /github connect, /github sync or /github disconnect.";
      deliver(w, actor, actor, text, { id: `event:${u.update_id}:github` });
      return true;
    }
    const githubCallback = u.callback_query;
    if (githubCallback?.data?.startsWith("github_")) {
      const [action, key] = githubCallback.data.split(":");
      const sender = String(githubCallback.from.id);
      requireThat(
        this.githubUsers &&
          d.bot &&
          !githubCallback.from.is_bot &&
          !githubCallback.message?.sender_chat &&
          githubCallback.message?.chat.type === "private" &&
          String(githubCallback.message.chat.id) === sender,
        "access_denied",
        403,
      );
      requireThat(
        key &&
          /^[A-Za-z0-9_-]{43}$/.test(key) &&
          ["github_confirm", "github_reject"].includes(action ?? ""),
        "invalid_request",
      );
      await this.githubUsers.confirm(
        sql,
        w,
        sender,
        d.bot.id,
        Buffer.from(key, "base64url").toString("hex"),
        action === "github_confirm",
      );
      return true;
    }
    if (!d.active) {
      if (msg?.chat.type === "private" && actor && cmd)
        await this.accessHelp(sql, u, d, w);
      return true;
    }
    if (d.paused) return true;
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
        title: msg.chat.title?.trim() || undefined,
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
  private async handleMessage(
    sql: Sql,
    w: Workspace,
    u: Update,
    d: Deployment,
  ) {
    const msg = u.message ?? u.edited_message;
    if (!msg || msg.from?.is_bot || msg.sender_chat || !msg.from || !d.bot)
      return;
    const actor = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const topic = msg.message_thread_id ?? 0;
    let cmd = command(msg, d.bot);
    const attachments = messageAttachments(msg, d.bot.id);
    const text = messageText(msg);
    const chat = w.chats.find((c) => c.id === chatId && c.active);
    if (msg.chat.type !== "private" && !chat) return;
    if (await routeDevelopment(sql, w, u, d.bot.id, msg, cmd)) return;
    const sourceId = `${msg.chat.type === "private" ? `${d.bot.id}:` : ""}${chatId}:${msg.message_id}`;
    if (u.edited_message) {
      const previous = w.messages.find(
        (s) => s.id === sourceId && s.author === actor,
      );
      if (previous) {
        previous.text = text.slice(0, 12000);
        previous.attachments = attachments.length ? attachments : undefined;
      }
      return;
    }
    if (
      cmd &&
      !["ask", "correct"].includes(cmd.name) &&
      chat &&
      eligible(w, actor)
    )
      closeGroupAttention(w, msg, d.bot.id);
    const followup = !cmd ? followupCandidate(w, msg, d.bot.id) : undefined;
    if (followup) cmd = { name: "ask", args: msg.text?.trim() ?? "" };
    if (
      (eligible(w, actor) && cmd) ||
      (chat?.collection && (text || attachments.length))
    ) {
      if (
        (text || attachments.length) &&
        !w.messages.some((s) => s.id === sourceId)
      )
        w.messages.push({
          id: sourceId,
          chatId,
          topicId: topic,
          author: actor,
          text: text.slice(0, 12000),
          attachments: attachments.length ? attachments : undefined,
          at: new Date(msg.date * 1000).toISOString(),
          expiresAt: new Date(
            Date.now() + w.settings.retentionDays * 86400000,
          ).toISOString(),
          directed: !!cmd && !followup,
        });
      w.messages = w.messages.slice(-2000);
    }
    if (!cmd || !eligible(w, actor)) return;
    const reply = (
      text: string,
      buttons?: Workspace["deliveries"][number]["buttons"],
      format?: "markdown",
    ) =>
      deliver(w, actor, chatId, text, {
        topicId: topic,
        replyTo: msg.message_id,
        buttons,
        format,
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
          `RepoDesk · ${w.settings.name}\nTimezone: ${w.settings.timezone}\n/ask <request>, /recap, /status, /cancel [reference], /automations, /memory, /usage, /privacy\nGitHub: /github connect, /github sync, /github disconnect (private chat)\nAdmins: /linktoken, /capture on|off, /timezone <IANA>, /remember <instruction>\nIn groups, mention me or reply to start; clear follow-ups within five minutes can continue without mentioning me when Telegram delivers ordinary messages. Send photos, image files, UTF-8 text/code files or selectable-text PDFs with a caption describing your request. In private Topics, just send messages to continue the topic's conversation. Use Telegram Topics to separate conversations. Outside Topics, reply to an answer or your own message to continue it; standalone messages start new conversations. For configured Codex repositories, ask for a change in your own words. Reply to a current task question to answer it directly. Other Topic messages go to the assistant, which handles conversation and review requests and passes clear code changes to the matching task; /status checks the bound task and /cancel or stop cancels it. Direct execution follows the repository's saved policy. Context contains only received retained messages. Access is managed in the admin panel. /workspace <id> selects a workspace.`,
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
          `As a Telegram group admin, send \`/link ${raw}\` in the intended group within 10 minutes.`,
          undefined,
          "markdown",
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
            ? "Collection enabled with admin consent. Received group messages, including messages by people who are not workspace members, may appear in team recaps. Old history is unavailable."
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
          `Timezone: ${w.settings.timezone}\nRetention: ${w.settings.retentionDays} days\nAccess: active workspace members\nSettings version: ${w.version}\nUse the admin panel for configuration.`,
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
          createRun(
            w,
            actor,
            `${prior.task.slice(0, 2000)}\nFor this run only: ${body}`,
            chatId,
            topic,
            d.model,
            {
              replyTo: msg.message_id,
              continueFrom: msg.reply_to_message?.message_id,
              botId: d.bot.id,
            },
          );
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
        if (!text && !attachments.length) break;
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
        createRun(
          w,
          actor,
          cmd.name === "recap"
            ? "Create a source-grounded team recap. Include decisions, blockers and next steps. State coverage and gaps."
            : cmd.args.trim() ||
                "Describe the attached content and ask what I would like to do with it if no request is clear.",
          chatId,
          topic,
          d.model,
          {
            replyTo: msg.message_id,
            continueFrom: msg.reply_to_message?.message_id,
            botId: d.bot.id,
            workflowId: msg.chat.type === "private" ? undefined : workflow?.id,
            groupRecap: msg.chat.type !== "private" && cmd.name === "recap",
            followup,
          },
        );
        break;
      }
      default:
        reply("Unknown command. Use /help.");
    }
  }
}
