# Source-grounded preferences

Preferences are reference memories with retained human evidence, scope and
revisions. They can help future answers and repository tasks while current
instructions, access checks and explicit action requests remain authoritative.

## Learning and recall defaults

Preference derivation and automatic preference recall in Pi and Codex are enabled
by default. Existing workspaces with no saved settings use the same defaults.
Explicit saved settings, including disabled learning/recall, are preserved. A
workspace owner/admin can change settings or restore the defaults:

```text
Configure preference learning: derive=true recall=pi_and_coding
```

Use `recall=pi` for conversation recall or `recall=off` to stop automatic preference
recall. `derive=false` stops collecting decision cases and inferred candidates.
These workspace settings are separate from historical-memory enable/disable
controls. They do not expose private records to other members or groups.

Derivation reuses the existing idle conversation extraction call and its budget.
It may save a task-scoped candidate with human source IDs. A candidate stays a
hypothesis until explicitly accepted. One decision never silently becomes a
general team rule. Different group members' conflicting preferences are disputed
and excluded from automatic recall.

## Save, inspect and revise

Use these text forms, replacing `pref:ID` with the exact identifier returned when
you ask what is remembered:

```text
Remember preference: Keep diagnostic summaries concise
What preferences do you remember, with their sources and revisions?
Correct preference pref:ID: Keep routine summaries concise; explain failures in detail
Add preference exception pref:ID: Include the full reproduction when debugging
Forget preference pref:ID
```

`Accept preference pref:ID` explicitly accepts the candidate's existing wording
and applicability. A correction or exception creates a new revision; it does not
overwrite the original evidence. Mention the full repository name or domain in
the preference itself when requesting that restriction. Ambiguous records must
be identified before a mutation. Group members control their own evidence;
changing another member's or mixed-author evidence requires an owner/admin.

Private records stay within your workspace, bot and private actor, across your
Topics. Group records stay in the same group and Topic. Repository applicability
also requires current read access. Selected records include their scope,
exceptions, revision and sources in a bounded context pack.

Corrections and forgetting invalidate old packs. Coding continuations discard
affected checkpoints and derived local summaries before using fresh context.
Forgetting removes the revision lineage and dependent local memories while
keeping content-free replay protection for retained sources. Original messages
follow their ordinary retention policy. Confirmed GitHub effects and messages
already delivered to Telegram are not withdrawn.

These records do not become [persistent instructions](memory-and-privacy.md),
change skills or authorize publishing. External [Nowledge Mem](nowledge-mem.md)
retains its own save and deletion rules.
