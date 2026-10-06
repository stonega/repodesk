# Telegram image and attachment input

Implemented locally, 2026-10-06. Live Telegram/provider behavior still needs the
[manual staging check](../../examples/telegram-attachments.md).

## Supported input

- Telegram photos, including messages with no caption. The largest photo variant
  is selected. Images sent as documents are supported too.
- JPEG, PNG, GIF and WebP images, identified from bytes. Images reach Pi as base64
  image content blocks, paired with their source ID in the text prompt.
- UTF-8 text/code files, including Markdown, JSON, CSV and ordinary source files.
- Unencrypted PDFs with selectable text, extracted with pinned `unpdf` 1.8.1
  (its serverless PDF.js distribution). No PDF scripts, rendering, remote font
  retrieval, OCR, audio transcription, archive extraction or Office-file parsing.

Limits are application policies: 5 MiB per image/PDF, 256 KiB per text/code file,
32,000 extracted text characters per file, and 40 PDF pages. A request uses at most
four files and 10 MiB of downloaded data from its unsummarized conversation context.
Current input has priority. Older inaccessible/unsupported or over-limit references
are marked unavailable; a bad earlier file does not block a new text request.
Files are never silently truncated. Scanned PDFs, oversized files, unsupported
formats and download failures get readable feedback. Send scanned pages as images.
Album messages are independent Telegram updates; album aggregation is not implemented.

## Routing and authorization

Private images/files start a request with their caption, or a brief default request
when no caption exists. Native Topics and reply anchors retain their existing
conversation behavior. In linked groups, use a caption command/mention or reply to
the bot. Caption entities use Telegram's UTF-16 offsets. Unaddressed media does not
open a follow-up window; group collection consent may retain its metadata.

Authenticated, deduplicated ingress retains caption and file metadata on the tenant's
source record. It performs no file download. The worker checks current run policy,
source retention, bot identity and bot credential generation before/after fetching
and decoding. Files are downloaded only from validated Bot API relative paths;
redirects, arbitrary URLs and traversal are rejected. Metadata and streamed bytes
both enforce limits, even without Content-Length. Downloads share run cancellation
and have a 15-second timeout. File URLs/tokens never enter prompts or routine logs.

Known model IDs retain Pi catalog input capabilities. Text-only models get a clear
image-support error before provider dispatch. Custom OpenAI-compatible endpoints
receive image blocks using Chat Completions syntax and must support vision; a
provider rejection remains a provider failure. Per-call reservations use text bytes
plus a conservative allowance of 32,768 input tokens per image, rather than counting
base64 as text tokens. Actual usage settles through the existing accounting path.
Existing dollar budgets, context limits and cancellation still apply.

Pi downloads remain in memory; no attachment directory or public file endpoint
is created. User transcript checkpoints retain supplied image blocks and extracted
text for safe resumption, under the existing tenant retention/deletion policy.
Source metadata changes invalidate derived memory hashes. No SQL migration or new
Telegram update subscription is needed; restart updated API and worker together.

## Codex task media

Direct Codex tasks also receive authorized source images as app-server image input
blocks, with source IDs and image order identified in reference text. Text/code
files and selectable PDF text use the same guarded decoder and media limits as Pi.
The worker resolves original sources for both initial requirements and follow-ups;
it checks current task access, source retention and bot credential generation before
and after downloads and immediately before runner dispatch. Application attempt
records retain source references without copying image bytes.

Photo-only and captioned answers use the same task reply/Topic bindings and task
selection as text. A photo-only answer retains its empty caption. During intake,
its preceding authenticated text supplies the schema-pinned intent evidence;
images remain reference data and cannot grant new actions. A standalone image
follow-up does not inherit this answer exception. Legacy reviewed issue tasks
still accept text issue requirements.

The private runner record retains bounded image content for repairs, authentication
pauses and restart recovery. New isolated attempts reload authorized retained
sources, including when the old Codex session is unavailable. Runner expiry and
task erasure scrub this media with the other task content. Images are not added to
the repository checkout or patch. The runner accepts bounded data URLs and uses
larger bounded HTTP and JSONL buffers to accommodate base64 media. Update app,
worker, supervisor and task image together; no SQL migration is required. Existing
cancelled tasks are not restarted.

## Local verification

Unit tests exercise real local PDF text extraction, byte-signature image handling,
caption commands/mentions, streaming size caps, rejected paths, cancellation,
checkpoint restoration, vision reservations and text-only model rejection.
Isolated PostgreSQL integration tests cover deduplicated photo-only input, captioned
code files, Topics, group routing, denied actors, queued/during-download revocation
and recovery after unsupported files. Tests use fake Telegram/model transports.
Codex tests cover original screenshot handoff, captioned image documents, photo-only
answers, edits, selection between tasks, duplicates, guarded downloads, runner
restart/erasure and image payloads larger than the old JSONL limit. The pinned real
Codex protocol proof checks image delivery at a local fake Responses endpoint;
container smoke checks image forwarding through continuation and repair.
