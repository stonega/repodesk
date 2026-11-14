import {
  type GroupRepository,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { githubConnectionRevision } from "../github/config.ts";
import { fingerprint } from "../setup/credentials.ts";

export function groupRepositories(w: Workspace) {
  return w.github?.installationId
    ? w.github.repositories.filter(
        (r) => r.private === false && !r.archived && !r.disabled,
      )
    : [];
}

export function groupRepositoryCurrent(
  w: Workspace,
  chatId: string,
  binding: GroupRepository,
  botId = binding.botId,
) {
  const chat = w.chats.find((c) => c.id === chatId && c.active);
  return (
    !w.deletion &&
    !!chat &&
    chat.repositoryRevision === binding.revision &&
    binding.botId === botId &&
    w.github?.installationId === binding.installationId &&
    githubConnectionRevision(w.github) === binding.connectionRevision &&
    (w.github.repositoryRevisions?.[binding.repositoryId] ?? 0) ===
      binding.repositoryRevision &&
    groupRepositories(w).some(
      (r) => r.id === binding.repositoryId && r.full_name === binding.full_name,
    )
  );
}

/** Absence is also a snapshot: binding a formerly unbound group fences old work. */
export function groupRepositoryAllowed(
  w: Workspace,
  chatId: string,
  snapshot?: GroupRepository,
  botId?: string,
  revision = snapshot?.revision ?? 0,
  requireCurrent = true,
) {
  const chat = w.chats.find((c) => c.id === chatId);
  if ((chat?.repositoryRevision ?? 0) !== revision) return false;
  const current = chat?.repository;
  return snapshot
    ? !!current &&
        fingerprint(current) === fingerprint(snapshot) &&
        (!requireCurrent || groupRepositoryCurrent(w, chatId, current, botId))
    : !current;
}

export function requireGroupRepositoryTarget(
  w: Workspace,
  chatId: string,
  botId: string,
  repositoryId: number,
  snapshot?: GroupRepository,
  revision = snapshot?.revision ?? 0,
) {
  requireThat(
    groupRepositoryAllowed(w, chatId, snapshot, botId, revision),
    "group_repository_changed",
    409,
  );
  requireThat(
    !snapshot || snapshot.repositoryId === repositoryId,
    "group_repository_target_mismatch",
    403,
  );
}

export function saveGroupRepository(
  w: Workspace,
  chatId: string,
  actor: string,
  botId: string,
  revision: number,
  repositoryId: number | null,
) {
  requireThat(
    !w.deletion &&
      (actor === w.operatorId ||
        w.members.some(
          (m) => m.id === actor && m.active && m.role !== "member",
        )),
    "access_denied",
    403,
  );
  const chat = w.chats.find((c) => c.id === chatId);
  requireThat(chat, "not_found", 404);
  requireThat(
    (chat.repositoryRevision ?? 0) === revision,
    "version_conflict",
    409,
  );
  const repository = groupRepositories(w).find((r) => r.id === repositoryId);
  requireThat(
    repositoryId === null || (chat.active && repository),
    "group_repository_unavailable",
    409,
  );
  if (
    (!chat.repository && repositoryId === null) ||
    (chat.repository?.repositoryId === repositoryId &&
      groupRepositoryCurrent(w, chatId, chat.repository, botId))
  )
    return false;
  chat.repositoryRevision = revision + 1;
  chat.repository =
    repository && w.github?.installationId
      ? {
          revision: chat.repositoryRevision,
          botId,
          installationId: w.github.installationId,
          connectionRevision: githubConnectionRevision(w.github),
          repositoryRevision:
            w.github.repositoryRevisions?.[repository.id] ?? 0,
          repositoryId: repository.id,
          full_name: repository.full_name,
          savedBy: actor,
          savedAt: new Date().toISOString(),
        }
      : undefined;
  // Old personal menus cannot change or reintroduce a conflicting target.
  w.repositorySelections = w.repositorySelections?.filter(
    (s) => s.chatId !== chatId,
  );
  for (const delivery of w.deliveries)
    if (delivery.chatId === chatId && delivery.repositoryMenu) {
      delivery.repositoryMenu.consumed = true;
      if (delivery.state === "pending") delivery.state = "cancelled";
    }
  return true;
}
