# Code evidence mistaken for a chat citation

Run `25923fbf-f90d-48c0-a14c-450a8087b500` failed on 2026-09-21 at
10:45:01.675 UTC with `invalid_source_citation`. The persisted transcript shows
completed Code Truth queries and a completed model answer containing
`[source:package.json]`. The manifest tool had returned that file, but its path
was not an authorized chat-message source ID. Final validation rejected the answer
before result delivery; the failure notification was delivered. All four provider
attempts were settled.

The base system prompt instructed the model to cite all factual context using
`[source:EXACT_ID]`, while the Code Truth skill requested repository provenance
without distinguishing its notation from chat citations. The validator accepts
only the run's authorized chat-source IDs. This mismatch encouraged the model to
place a real repository filename in the chat-only citation syntax.

The correction limits the base prompt's bracketed citation rule to chat messages
and explicitly directs code/tool evidence to plain-text provenance. The Code Truth
skill provides a target/network/branch/commit/file/line example and forbids using
filenames or the user's request ID as substitute chat citations for code evidence.
The validator still rejects unknown chat IDs and unverified Telegram links.

Deterministic regression tests cover mixed chat/code references, rejection of the
reported filename citation and unauthorized chat IDs, chat recap requirements,
and the citation instructions supplied to the model. These tests do not establish
live model compliance or semantic grounding of code claims. The historical run
is not changed or replayed; the correction requires the updated prompt and skill
to be installed in the worker before it affects future requests.
