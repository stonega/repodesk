import { requireThat, type Workspace } from "../domain.ts";
import {
  recentRepositories,
  repositoryDeliveryAllowed,
  selectableRepositories,
  selectedRepository,
} from "../github/repository-context.ts";
import { audience } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type { Message, Update } from "./router.ts";

export function repositoryMenu(
  w: Workspace,
  u: Update,
  msg: Message,
  botId: string,
  query: string,
) {
  const actor = String(msg.from?.id),
    chatId = String(msg.chat.id),
    topicId = msg.message_thread_id ?? 0;
  audience(w, actor, chatId);
  requireThat(!w.settings.paused, "workspace_paused", 409);
  const selected = selectedRepository(w, actor, chatId, topicId, botId);
  const repositories = recentRepositories(w, actor, chatId, query);
  const available = selectableRepositories(w, actor, chatId);
  const text = !w.github?.installationId
    ? "No GitHub repositories are connected. Ask your workspace admin to connect and select repositories in the admin panel."
    : !available.length
      ? "No active repositories are available here. Check your GitHub access or ask your workspace admin; private repositories are available only in private chat."
      : !repositories.length
        ? "No matching active repositories. Try /repos <name>."
        : `Choose a repository for this conversation.\nRecently mentioned first, then latest GitHub activity.\nShowing ${repositories.length} of ${available.length} active repositories. Use /repos <name> to search.`;
  const buttons = repositories.map((r) => [
    {
      text: `${r.id === selected?.id ? "✓ " : ""}${r.full_name}`,
      callback_data: `repo:${u.update_id}:${r.id}`,
    },
  ]);
  if (selected)
    buttons.push([
      { text: "Clear selection", callback_data: `repo:${u.update_id}:clear` },
    ]);
  // New menus replace older controls in this actor/chat/topic, without editing Telegram history.
  for (const d of w.deliveries)
    if (
      d.repositoryMenu &&
      d.botId === botId &&
      d.actor === actor &&
      d.chatId === chatId &&
      d.topicId === topicId
    ) {
      d.repositoryMenu.consumed = true;
      if (d.state === "pending") d.state = "cancelled";
    }
  const id = deliver(
    w,
    actor,
    chatId,
    `${selected ? `Selected: ${selected.full_name}\n` : ""}${text}`,
    {
      id: `repos:${botId}:${u.update_id}`,
      topicId,
      replyTo: msg.message_id,
      buttons: buttons.length ? buttons : undefined,
    },
  );
  const delivery = w.deliveries.find((d) => d.id === id);
  if (delivery && w.github?.installationId) {
    delivery.botId = botId;
    delivery.repositoryMenu = {
      installationId: w.github.installationId,
      revision: w.github.revision,
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      repositories: [
        ...repositories,
        ...(selected && !repositories.some((r) => r.id === selected.id)
          ? [selected]
          : []),
      ].map(({ id, full_name }) => ({ id, full_name })),
    };
  }
}

export function selectRepository(w: Workspace, u: Update, botId: string) {
  const c = u.callback_query;
  if (!c?.data?.startsWith("repo:")) return false;
  requireThat(
    !c.from.is_bot &&
      c.message &&
      !c.message.sender_chat &&
      String(c.message.from?.id) === botId,
    "access_denied",
    403,
  );
  const match = /^repo:(\d+):(clear|[1-9]\d*)$/.exec(c.data);
  requireThat(match, "repository_menu_expired", 409);
  const actor = String(c.from.id),
    chatId = String(c.message.chat.id),
    topicId = c.message.message_thread_id ?? 0;
  audience(w, actor, chatId);
  const delivery = w.deliveries.find(
    (d) => d.id === `repos:${botId}:${match[1]}`,
  );
  requireThat(
    delivery &&
      delivery.actor === actor &&
      delivery.chatId === chatId &&
      delivery.topicId === topicId &&
      delivery.botId === botId &&
      delivery.state === "sent" &&
      delivery.remoteId === c.message.message_id,
    "access_denied",
    403,
  );
  requireThat(
    delivery.repositoryMenu &&
      !delivery.repositoryMenu.consumed &&
      repositoryDeliveryAllowed(w, delivery),
    "repository_menu_expired",
    409,
  );
  const repository =
    match[2] === "clear"
      ? undefined
      : delivery.repositoryMenu.repositories.find(
          (r) => r.id === Number(match[2]),
        );
  requireThat(match[2] === "clear" || repository, "access_denied", 403);
  requireThat(
    delivery.buttons?.flat().some((b) => b.callback_data === c.data),
    "access_denied",
    403,
  );
  w.repositorySelections = (w.repositorySelections ?? []).filter(
    (s) =>
      Date.parse(s.at) > Date.now() - w.settings.retentionDays * 86400000 &&
      !(
        s.actor === actor &&
        s.chatId === chatId &&
        s.topicId === topicId &&
        s.botId === botId
      ),
  );
  if (repository)
    w.repositorySelections.push({
      actor,
      chatId,
      topicId,
      botId,
      installationId: delivery.repositoryMenu.installationId,
      repositoryId: repository.id,
      at: new Date().toISOString(),
    });
  w.repositorySelections = w.repositorySelections.slice(-1000);
  delivery.repositoryMenu.consumed = true;
  const id = deliver(
    w,
    actor,
    chatId,
    repository
      ? `Selected ${repository.full_name} for this conversation. Send your question or change request.`
      : "Repository selection cleared for this conversation.",
    { id: `repos:${botId}:${u.update_id}:selected`, topicId },
  );
  const confirmation = w.deliveries.find((d) => d.id === id);
  if (confirmation && repository) {
    confirmation.botId = botId;
    confirmation.repositoryMenu = {
      ...delivery.repositoryMenu,
      repositories: [repository],
    };
  }
  return true;
}
