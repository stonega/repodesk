# Private forwarded references detached from their notes

Reported 2026-10-29. Local regression and correction; live Telegram acceptance
and deployment remain pending.

The reported Telegram flow forwarded a release message with a `save this` note,
but the resulting request contained only the note. Telegram delivers forwarding
comments and forwarded content as separate messages. Outside native Topics,
RepoDesk's compatibility routing started a thread for every standalone private
message. It preserved the forwarded reference in its own run, but the next note
had no reply anchor and therefore received a separate context. Native Topics
already reuse their conversation identity; the screenshot alone does not establish
which thread fields Telegram supplied for the reported pair.

Ingress now records whether each received source was forwarded and associates
an adjacent forward/comment pair received within one minute. It continues the
retained request's thread in the same workspace, bot, user and private chat.
Both delivery orders are supported, including a forward reaching ingress after
its later comment while the comment's run is executing. Existing ordered execution
and worker refresh supply the reference to the next run without mutating an
in-flight prompt. Forwarded commands remain quoted data.

Native Topics and explicit replies retain precedence. Retained controls, retention expiry,
cancelled/failed requests and access revocation prevent implicit association.
Ordinary messages after the paired note start new conversations. No dependencies,
migrations, external calls or new diagnostics were introduced.

The regression runs through production `Ingress`, persisted workspace records,
`Executor` and attachment loading with fake Telegram/model transports. It checks
forward-first and comment-first delivery, duplicates, ingress/worker reconstruction,
original attribution/media, unchanged in-flight input and final delivery routing,
both outside Topics and inside a Topic. Unit cases cover the association window,
intervening controls, explicit reply/topic boundaries, tenant/bot/member isolation,
source retention and cancelled/failed predecessors.

Validation passed: `bun run check`, `bun run typecheck`, `bun run build`, the Node
runtime contract and 1,264 tests across 136 files in the forwarding-only snapshot
with disposable PostgreSQL. The seven-test Stop suite passed on an isolated rerun
after an initial PostgreSQL setup timeout.

Live acceptance must repeat the reported forwarding-dialog flow and verify both
incoming `message_thread_id` values before attributing any remaining failure to
native Telegram topic assignment. Routine logs must not include message contents.
