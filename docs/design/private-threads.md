# Private conversation threads

Implemented locally, updated 2026-09-22. Live Telegram acceptance remains a deployment check.

## Interaction

Telegram native Topics are the primary private-conversation boundary. Messages
with a nonzero `message_thread_id` reuse one backend thread for that topic, bot,
private chat, user and selected workspace. Plain messages, `/ask`, private `/recap`
and `/correct once` use this routing, including follow-ups sent while an answer is
still generating. Users manage conversations in Telegram's native Topics interface;
there is no additional New conversation / Recent conversations interface.

The current topic takes precedence over reply anchors. Replying to an old message,
a missing anchor or a message from another topic does not switch or merge topics.
Native topic identity does not depend on retaining the replied-to message. Expired
content is still excluded; an empty thread may be pruned and recreated on the next
message without restoring erased history. Topic names are presentation only;
renaming a topic does not change its conversation identity.

Outside Topics (no `message_thread_id`), the existing compatibility routing remains:
a standalone private text request starts a new thread; replying to a retained
assistant answer or the user's own request continues that message's thread.
Replying to an older message uses the latest retained conversation, without
branching. Unknown, expired, pre-upgrade or different-workspace reply anchors start
a new thread with a brief explanation. Native-topic threads cannot be selected
from outside Topics through reply fallback. Control commands such as `/help`,
`/status` and `/workspace` do not create threads.

Every final answer replies to the triggering user message in its original topic.
Thinking drafts, streamed previews and native Stop retain that topic ID. Outside
Topics, only bot replies with confirmed remote message IDs can select a thread;
ephemeral drafts and uncertain sends have no confirmed mapping.

Threads belong to a Telegram user within one workspace. `/workspace` determines
the workspace for topic selection and reply lookup. The same Telegram topic in
another workspace gets separate context; switching back resumes the original
workspace's retained topic conversation. Replies cannot switch workspaces or import
another workspace's history. Group conversation routing is described in [group conversations](group-conversations.md);
scheduled workflows retain their separate context rules.

## Persistence and execution

Optional `Workspace.threads` records hold identity, owner, chat, bot, optional
native topic ID and creation time. `Run.threadId` identifies the conversation
independently of a request's run ID. Source records carry thread/run identity and user/assistant role. Incoming
private message IDs include bot and chat IDs; confirmed delivery records map
outgoing Telegram IDs back to their runs. Existing locked workspace JSONB and
atomic inbox/outbox transactions persist all of this without a SQL migration.

Standalone private runs outside Topics receive only their own request as source
context. Native-topic messages and reply continuations assemble retained messages
and visible assistant answers in run insertion order, refreshed when the worker
claims the run. Later queued messages
are excluded. The model receives role-labeled conversation sources in its prompt;
each request keeps a separate Pi execution transcript for recovery. Historical tool
calls and reasoning are not replayed. Approved instructions and pinned skills still
apply. Native Topics use the context management described below; non-topic private
threads and recap/workflow requests retain their existing context behavior. Interactive
group threads reuse discussion memory and compaction; see [group conversations](group-conversations.md).

Runs in the same thread execute in persisted insertion order, including messages
with identical timestamps. A waiting run remains queued and its queue job completes
without spending retries; normal outbox recovery redispatches it. Other threads can
execute concurrently. Failed/cancelled runs release the next turn; awaiting approval
also releases execution so the user can discuss a proposal. Approval rights and
external-write guards are unchanged. Partial visible answers can be retained;
cancelled streams and hidden reasoning cannot become history.

## Discussion records inside a Topic

Implemented locally, 2026-09-22. Short follow-ups continue the recent discussion;
clear new subjects are answered without a create/switch confirmation. Model policy answers directly, keeps context handling silent, and resolves ordinary
ambiguity from the conversation or a reasonable low-risk assumption. It asks only
when missing essential information would otherwise make the answer or action
materially incorrect or unsafe; required approvals remain in place. Ordinary revisions are this-run-only; saving approved instructions remains
a separate explicit action.

The core `record_discussion` tool lets the model silently identify a new substantive
subject or revise an existing record. Each contains a title, short summary, confirmed
decisions, todos, related discussion IDs and links to original source messages.
Relations can overlap; these are not authorization or execution boundaries. The
model decides semantic relevance; the application validates topic ownership, source
IDs, payload limits and replay identity. There is no per-message classifier call,
vector database, or new user-facing conversation management.

Updates are staged on the run, committed with its visible answer, and discarded
on failure/cancellation. Each topic retains up to 100 recent records. Context shows
only the latest eight record titles/IDs at the end of the prompt. The model can
browse/search `query_discussions({query?, id?, cursor?, limit?})` for bounded summaries,
decisions and todos, then fetch original excerpts with
`query_chat_history({discussionId})`. Literal search plus model interpretation is
used; this is not embedding search. An old-message reply is an optional relevance
hint at the end of the prompt and never changes the current Topic.

Records conservatively track all source dependencies supplied when recorded, with
content hashes. Edits, deletion and retention invalidate derived records. References
from other Topics are not automatically promoted into the current Topic's discussion
catalog. Internal summaries/decisions are fallible data, not approved instructions,
authorization, schedules, or claims that proposed actions actually happened.

## Stable context and automatic compaction

The prompt order is fixed summary (when present), chronological source messages,
then current request, coverage, reply hint and discussion directory. Growing the
source array preserves the historical prefix; changing per-turn metadata stays at
the end. Model instructions and tool definitions stay stable during ordinary turns.
Ordinary private-thread requests use a stable hashed workspace/thread session key
for Pi/provider cache routing, while execution/checkpoint identity remains the run
ID. Summary executions use their own run session. This improves cache eligibility
but does not guarantee provider cache hits. Actual
input/output/cache-read/cache-write token usage is retained on accounting attempts.

For native Topics, a conservative serialized-byte estimate includes the system,
prompt and application tool schemas. Output reserve is the lesser of model maximum
output and 15% of context capacity (at least 1,024 tokens before applying the model
maximum). Compaction starts at 80% of the remaining capacity and selects older
messages toward a 40% target, always retaining the two most recent runs. Additional
extension context/tools remain subject to the final runtime capacity guard.

The same configured model summarizes older sources and the previous frozen summary
using a dedicated tool-free Pi execution. It preserves subjects, goals, constraints,
decisions, proposed versus confirmed work, questions and todos. Each summary call
is bounded by model capacity; unusually long backlogs may require multiple batches.
The summary output is validated for size and citation identity before being stored
atomically on the thread and pinned to the current run. Later short turns reuse it
unchanged and append messages until the next threshold crossing. Original messages
remain stored under the existing retention policy and are retrieved only as needed.

Summarization has separate durable checkpoints and no extension hooks/tools or
Telegram previews. It shares the requesting run's dollar, turn and time budgets,
lease, cancellation and current-access guards. At least one provider turn is left
for the answer. A completed summary checkpoint is reused after a crash; ambiguous
provider charges remain reserved and are never automatically replayed. Invalid or
oversized summaries are rejected. If budget, minimal recent context or extension
input cannot fit, the run reports the appropriate limit rather than discarding
recent messages or inventing a summary. Completed earlier summary batches remain
valid even if a later batch or the ordinary answer fails.

Summaries carry source hashes and all underlying source IDs, including dependencies
of the preceding summary. They are invalidated when sources change or expire, and
are erased with workspace deletion. Retention correctness takes precedence over
cache reuse. No hidden reasoning is stored or replayed.

## History retrieval

`query_chat_history({query?, threadId?, discussionId?, before?, cursor?, limit?})` is a core read-only
capability for private threaded runs, available with existing published skills.
It does not require rewriting immutable skill versions. Group and scheduled runs
cannot use it. User/workspace identity comes from the current execution, never tool
arguments. Current membership, eligibility, run fence and source retention are
checked at invocation, including cached tool calls.

`query` is case-insensitive literal text search. `threadId` retrieves a selected
owned thread; `before` filters ISO timestamps. Results contain source/thread IDs,
role, date, up to 1,000 characters around a match and a Telegram message ID when
known. Default limit is 10, maximum 20. Results are newest first; use `nextCursor`
with the same filters to page through equal timestamps without losing messages.
An unavailable cursor requires a fresh search. This is not semantic/vector search.

Retrieved excerpts enter only the current run's authorized citation set. They
provide reference material and cannot authorize actions or merge threads. Generated
answers inherit the earliest retention boundary of their sources. Sweeps remove
derived answers transitively when sources disappear; workspace deletion removes
threads, messages and execution history. Empty threads are pruned. History capacity
shares the pilot's 2,000-source-message cap, including assistant answers.

## Upgrade and verification

Old records remain readable and are not guessed or merged into native topic
threads. The first post-upgrade message in a topic creates its native mapping;
pre-upgrade reply-thread history remains available through explicit history search.
Only messages created with thread identity are searchable through the tool.
Restart API and worker together after updating. There are no new dependencies,
account connections, webhook changes or automatic deployment steps.

Unit and isolated PostgreSQL tests cover native topic continuity, conflicting reply
anchors, topic/user/bot/workspace isolation, topic-preserving streaming and delivery,
concurrent duplicate ingress, own-message replies, older-answer continuation,
persistence across ingress instances, ordering, source citation authorization,
bounded/paginated search, expiration and deletion. Topic-memory tests additionally
cover stable prompt prefixes, overlapping discussion records, semantic-tool wiring,
compaction thresholds, accounting, failure/cancellation and checkpoint recovery. See the
[local and manual example](../../examples/private-threads.md).
