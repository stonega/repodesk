# Local Qwen3-ASR voice transcription

RepoDesk includes a built-in **Qwen3-ASR** plugin for Telegram voice notes, audio
messages and audio files sent as documents. It is disabled by default per workspace.
An owning deployment operator enables it from **Plugins → Qwen3-ASR**. Enabling
starts a background model download without holding an HTTP request open. The page
shows Not downloaded, Downloading, Ready, Download failed or Runtime unavailable;
failed/interrupted downloads have an explicit Retry download action.

## Runtime and download

The initial model is **Qwen/Qwen3-ASR-0.6B**, pinned to Hugging Face revision
`5eb144179a02acc5e5ba31e748d22b0cf3e303b0`. Automatic language detection supports
the languages and dialects documented in the [upstream model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B).
The first implementation runs on CPU with PyTorch float32, at most four CPU threads,
one inference at a time across the shared cache. Each request loads the model in
an isolated process and releases its memory afterward. CPU inference may be slow;
measure latency and memory on the deployment host before raising input limits.
GPU selection, live streaming and speaker diarization are outside this version.

The app Docker image includes an isolated Python environment with CPU PyTorch
2.6.0, `qwen-asr` 0.0.6, `huggingface-hub` 0.36.2 and PyAV 16.1.0. These are explicit
runtime dependencies, separate from the Node/Bun package graph. PyAV supplies the
media decoder without a system FFmpeg executable. This increases the image size;
model weights are **not** downloaded during image build or when the plugin is disabled.

Compose shares the `transcription_models` volume between app and worker at
`/var/lib/repodesk-models`. Public weights can be reused across workspaces; audio,
transcripts and Telegram identifiers are never stored in that cache. OS locks
serialize downloads and inference across containers. Completed weights survive
restarts and disable/re-enable. Interrupted downloads show an error and can resume
from the cache on Retry. A worker reconciles enabled workspaces with no downloaded
model after a restart. Removing the volume requires downloading the model again.
Do not include this disposable public-model cache in tenant data exports.

Download uses the fixed public repository and revision without a Hugging Face token.
Inference uses local files only with Hugging Face/Transformers offline mode and
`trust_remote_code=False`. Subprocess environments exclude application credentials.
No hosted transcription API or model account key is required.

For a direct Node deployment, install Python 3.11+, the system `libsndfile1` library,
and an isolated environment using the same dependencies as the Dockerfile:

```sh
python3 -m venv /opt/repodesk-asr
/opt/repodesk-asr/bin/pip install pip==25.3
/opt/repodesk-asr/bin/pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
/opt/repodesk-asr/bin/pip install -r src/transcription/requirements.txt
```

Set `QWEN_ASR_PYTHON=/opt/repodesk-asr/bin/python` and an absolute writable
`QWEN_ASR_DIRECTORY` shared by API and worker. Restart both processes after updating
runtime dependencies. The build copies the Python bridge beside the bundled Node
entry points. Enable the plugin in the panel to download weights.

## Input, authorization and retention

The guarded Telegram attachment loader recognizes native voice/audio messages and
audio documents. A disabled plugin rejects current audio before download. Existing
policies still limit each file to 5 MiB, each request to four attachments and 10 MiB
combined. Decoded audio is mono 16 kHz and limited to **120 seconds**. Invalid files,
no detected speech, excessive duration and an unavailable model receive readable
errors. Unsupported older references do not block a new request.

Private voice notes start a chat request; in groups, reply to the bot or use an
addressed caption. Undirected group recordings are not automatically transcribed.
Voice-only requests ask the assistant to show the transcript and answer spoken
questions. Transcripts are labeled source reference data. Spoken commands do not
execute Telegram controls or grant GitHub/coding authority. Use an explicit text
instruction for an external action; existing approvals and coding grants still apply.
Forwarded and replied-to recordings retain the same reference-only treatment.

Chat requests and text-authorized Codex task requirements use the same loader.
Actor, destination, source retention, bot credentials and current workspace policy
are checked around downloads and before accepting results. Disable/re-enable during
inference invalidates that result. Disabling prevents new decoding; transcripts
already included in retained conversations remain subject to ordinary retention.

Audio bytes travel through process pipes and in-memory decoding only. Processes
are killed on cancellation/timeouts, including descendants. The model output joins
existing transcript/checkpoint retention; raw audio is not copied into repository
checkouts, model caches, routine logs or a new public file endpoint. No SQL migration
is needed; settings are part of the existing workspace plugin aggregate.

## Verification

Deterministic tests use fake transcription/model transports. They cover operator,
tenant, CSRF and revision boundaries; enable/disable/retry; restart reconciliation;
attachment routing, cancellation, revocation and UTF-8 subprocess output. Browser
fixtures cover the catalog and plugin page, unknown/loading settings, pending saves,
download polling and recovery at desktop/mobile widths in both themes.

Build and smoke-test the Docker runtime before release. Real model download and
speech quality are separate acceptance checks from deterministic application tests.
See the [runnable example](../../examples/telegram-audio.md).
