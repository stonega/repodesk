import type {
  TelegramUser,
  ThreadSummary,
} from "../src/admin/thread-history.ts";

export function TelegramUserInfo({
  user,
  linked = false,
}: {
  user: TelegramUser;
  linked?: boolean;
}) {
  return (
    <span className="telegram-user-info">
      {(user.name || !user.username) && (
        <span>{user.name || "Telegram user"}</span>
      )}
      {user.username &&
        (linked ? (
          <a
            href={`https://t.me/${encodeURIComponent(user.username)}`}
            target="_blank"
            rel="noreferrer"
          >
            @{user.username}
          </a>
        ) : (
          <span>@{user.username}</span>
        ))}
      <span className="muted">ID {user.id}</span>
    </span>
  );
}

export function ThreadIdentity({
  thread,
  linked = false,
}: {
  thread: ThreadSummary;
  linked?: boolean;
}) {
  return (
    <span className="thread-identity">
      <span className="thread-chat">
        {thread.group ? (
          <>
            <span>{thread.group.title || "Telegram group"}</span>
            <span className="muted">ID {thread.group.id}</span>
          </>
        ) : (
          <span className="muted">Private chat</span>
        )}
        {thread.topicId > 0 && (
          <span className="muted">Topic {thread.topicId}</span>
        )}
        {thread.kind === "standalone" && (
          <span className="muted">Standalone request</span>
        )}
        {thread.kind === "workflow" && (
          <span className="muted">Scheduled request</span>
        )}
      </span>
      <span className="thread-participants">
        {(thread.group ? thread.participants : [thread.user]).map((user) => (
          <TelegramUserInfo key={user.id} user={user} linked={linked} />
        ))}
        {thread.participantCount > thread.participants.length && (
          <span className="muted">
            +{thread.participantCount - thread.participants.length} more
            participants
          </span>
        )}
      </span>
    </span>
  );
}
