import type { Delivery, Workspace } from "../domain.ts";
import type { GitHubRepository } from "./app.ts";
import { repositoryAccess } from "./user-access.ts";

export function selectableRepositories(
  w: Workspace,
  actor: string,
  chatId: string,
) {
  if (
    !w.github?.installationId ||
    w.deletion ||
    !w.members.some((m) => m.id === actor && m.active)
  )
    return [];
  return w.github.repositories.filter(
    (r) =>
      !r.archived &&
      !r.disabled &&
      repositoryAccess(w, actor, r.id) &&
      (chatId === actor || r.private === false),
  );
}

function timestamp(value?: string | null) {
  return value ? Date.parse(value) || 0 : 0;
}

function mentionPattern(name: string, full = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_.${full ? "" : "\\/"}-])${escaped}(?=$|[^A-Za-z0-9_.-])`,
    "i",
  );
}

/** Rank only the requester's retained mentions; assistant text cannot supply recency. */
export function recentRepositories(
  w: Workspace,
  actor: string,
  chatId: string,
  query = "",
  now = Date.now(),
) {
  const repositories = selectableRepositories(w, actor, chatId);
  const shortNames = new Map<string, number>();
  for (const r of repositories) {
    const name = r.full_name.split("/")[1]?.toLowerCase() ?? "";
    shortNames.set(name, (shortNames.get(name) ?? 0) + 1);
  }
  const messages = w.messages.filter(
    (m) =>
      m.author === actor &&
      m.role !== "assistant" &&
      timestamp(m.expiresAt) > now &&
      timestamp(m.at) > now - w.settings.retentionDays * 86400000 &&
      timestamp(m.at) <= now,
  );
  const ranked = repositories.map((repository) => {
    const short = repository.full_name.split("/")[1] ?? "";
    const fullPattern = mentionPattern(repository.full_name, true);
    const shortPattern =
      shortNames.get(short.toLowerCase()) === 1
        ? mentionPattern(short)
        : undefined;
    let mentioned = 0;
    for (const message of messages)
      if (fullPattern.test(message.text) || shortPattern?.test(message.text))
        mentioned = Math.max(mentioned, timestamp(message.at));
    for (const selection of w.repositorySelections ?? [])
      if (
        selection.actor === actor &&
        selection.repositoryId === repository.id &&
        selection.installationId === w.github?.installationId &&
        timestamp(selection.at) > now - w.settings.retentionDays * 86400000
      )
        mentioned = Math.max(mentioned, timestamp(selection.at));
    return { repository, mentioned };
  });
  return ranked
    .filter(({ repository }) =>
      repository.full_name.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        b.mentioned - a.mentioned ||
        timestamp(b.repository.pushed_at ?? b.repository.updated_at) -
          timestamp(a.repository.pushed_at ?? a.repository.updated_at) ||
        a.repository.full_name.localeCompare(b.repository.full_name) ||
        a.repository.id - b.repository.id,
    )
    .slice(0, 10)
    .map(({ repository }) => repository);
}

export function selectedRepository(
  w: Workspace,
  actor: string,
  chatId: string,
  topicId: number,
  botId?: string,
  now = Date.now(),
): GitHubRepository | undefined {
  const selection = w.repositorySelections?.find(
    (s) =>
      s.actor === actor &&
      s.chatId === chatId &&
      s.topicId === topicId &&
      s.botId === botId &&
      s.installationId === w.github?.installationId &&
      timestamp(s.at) > now - w.settings.retentionDays * 86400000,
  );
  return selectableRepositories(w, actor, chatId).find(
    (r) => r.id === selection?.repositoryId,
  );
}

/** Recheck every displayed name before a queued menu/confirmation is sent. */
export function repositoryDeliveryAllowed(w: Workspace, delivery: Delivery) {
  if (!delivery.repositoryMenu) return true;
  const current = w.deliveries.find((d) => d.id === delivery.id);
  const menu = current?.repositoryMenu;
  if (!menu || current.state === "cancelled") return false;
  if (
    w.settings.paused ||
    (menu.consumed && !!delivery.buttons?.length) ||
    menu.installationId !== w.github?.installationId ||
    menu.revision !== w.github?.revision ||
    timestamp(menu.expiresAt) <= Date.now()
  )
    return false;
  const available = selectableRepositories(w, delivery.actor, delivery.chatId);
  return menu.repositories.every((r) =>
    available.some(
      (current) => current.id === r.id && current.full_name === r.full_name,
    ),
  );
}
