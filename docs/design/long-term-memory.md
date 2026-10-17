# Long-term conversation memory

Implemented locally, 2026-10-17. Real model recall quality and Telegram acceptance
remain release checks. This is application-managed historical recall around Pi,
inspired by Codex's two-stage memory pipeline; it is separate from approved
instructions, skills, conversation compaction and the Codex coding runner's state.

## Visibility

Memory lives in the existing locked workspace JSONB record, so every read and
write remains tenant-scoped without a separate filesystem store or vector service.
Private scope is workspace + bot + private chat + user, across that user's Topics
and retained conversations. Shared scope is workspace + bot + group + Topic,
including topic zero, across participants' retained directed conversations.
Neither scope imports the other. Scheduled workflows do not use these memories.

Current membership, linked group state, bot identity, retained source contents and
current repository read grants constrain recall. Generated records preserve source
IDs and hashes. A memory is reference data: it cannot approve a write, change a
skill, create a schedule, or replace approved instructions. Group records preserve
speaker IDs; an individual's statement is not a team decision or another person's
authorization. Ordinary group traffic is not collected by this feature, and it
cannot recover Telegram history that the application never received.

## Background pipeline

An independent worker loop checks once per minute. It claims one workspace memory
job at a time, under the existing workspace transaction lock. Only successful
interactive conversations with retained user and assistant messages qualify.
Queued, running and approval-waiting conversations are skipped. The default idle
window is 30 minutes. Recent source batches have a 24,000-byte ceiling. Existing
validated memory can accompany a newer batch. Older source dependencies remain
tracked for retention and invalidation without resending their full contents to
the model; a batch that cannot fit a user/assistant pair is skipped.

1. Extraction uses one tool-free Pi call to produce a title and a source-linked
   historical summary, at most 4,000 UTF-8 bytes. It prioritizes actual user
   requests, corrections, scoped preferences, decisions and unfinished work,
   distinguishing proposals, observed results and uncertainty. Empty output is a
   valid no-op. The output is JSON-validated and common credential patterns are
   redacted. Inputs are redacted before JSON serialization as well.
2. Consolidation uses one further tool-free Pi call over at most 48 candidate
   records in the same visibility scope, producing an index of at most 4,500 bytes
   and 12 exact memory IDs. IDs and input snapshots are validated before commit.
   Explicit notes and source pruning can also trigger consolidation independently
   of extraction. No tools, extension hooks, previews, Telegram sends or external
   write capabilities are available to these calls.

Jobs persist their phase, source snapshot, ownership token, two-minute lease and
separate model checkpoint. Valid completed checkpoints resume after a restart.
Failures back off for an hour, with at most three claims for an unchanged input;
unknown provider outcomes stop automatic replay. Each tick has a 90-second
deadline and follows worker shutdown. New messages can create a new extraction
snapshot. Background work does not block ingress, deliveries or heartbeats.

Both calls use the originating successful request's pinned model/provider and
remaining request/workspace dollar budgets. Their attempts, usage and charges are
attached to that request as `memory_extract` and `memory_consolidate`; its recorded
total can therefore increase after its visible answer completes. Background
checkpoints remain separate from the conversation transcript. Model and provider
configuration changes stop stale work.

## Recall and user control

A new interactive request receives a compact index of valid memories as historical
data, alongside its ordinary conversation context. If consolidation is pending, a
bounded directory of up to eight valid records is used. The index is frozen for a
running request; changed/removed sources are checked again during execution.

`query_memories({query?, id?, limit?})` browses or literally searches authorized
records, with at most 12 results. It returns titles, summaries, speaker IDs,
original thread IDs, up to 20 source IDs per record, a source-overflow marker and
dates. Returned source IDs enter the request's authorized citation set; all source
dependencies remain tracked for retention. Usage is recorded once per tool call.
Original excerpts remain available through `query_chat_history`.

`manage_memory({action, sourceId, memoryId?, title?})` accepts explicit remember,
forget, enable-memory and disable-memory requests in the current human message.
Common direct Chinese and English request forms are recognized; quoted history,
tool output, explanation questions and negative remember requests are insufficient.
Remember saves the actual message, rather than a model-invented preference.
Internal changes are durable when the tool succeeds, even if a later answer fails.
They do not bypass the separate approval process for persistent instructions.

Private users control their own scope. A group participant can add an attributed
note or forget a record whose statements all belong to that participant. Forgetting
other participants' or mixed-speaker records, and toggling group recall, requires
an active workspace owner/admin. Turning recall off retains stored records but
stops reading and generating them in that scope; enabling it restores eligible
recall. Tool replays recheck current access and state.

## Retention and forgetting

Records retain source IDs and content hashes. Edits, removed/expired sources and
revoked access make them unavailable. Answers derived from recalled sources inherit
their earliest retention boundary. Privacy sweeps invalidate derived answers and
memory checkpoints transitively. Workspace deletion purges all memory state.
Inactive records are pruned after 30 days without usage, and the workspace retains
at most 256 records. These limits never extend original message retention.

Forgetting removes the selected record and records with overlapping dependencies,
invalidates its index and in-flight recall, and keeps content-free source-ID
tombstones while the originals are retained. This prevents automatic extraction
from restoring the forgotten information. It does not delete the original chat
messages; ordinary explicitly requested history retrieval remains a separate feature.
Common credential redaction is defense in depth, not proof that every possible
secret format or mistaken inference is detectable.

## Verification

Deterministic unit and isolated PostgreSQL tests cover personal/shared boundaries,
bot/topic/workspace isolation, direct-request validation, group ownership,
disable/enable, source edits/retention/deletion, JSONB round trips, credential
redaction, budget failures, unknown charges, concurrent claims, checkpoint recovery,
usage replay and source removal during extraction/consolidation. See
[the example](../../examples/long-term-memory.md). Local tests establish contracts;
real extraction fidelity and recall usefulness still require model evaluation.
