# Voice notes and audio recordings

RepoDesk can transcribe Telegram voice notes and audio recordings locally with the
optional **Qwen3-ASR** plugin. Your workspace operator enables it in
**Plugins → Qwen3-ASR**. Enabling automatically downloads the model. Wait for
**Ready** before sending audio; a failed download offers **Retry download**.

Send a voice note in a private conversation. RepoDesk responds to what you say
just as it would to a typed message. It shows a transcript when you ask for one. In a linked group, reply to the
bot with your recording or address it in the recording's caption. Ordinary group
recordings do not start transcription automatically. Audio files sent as documents
are supported too.

Each recording can be up to **two minutes** and **5 MiB**. A request can include up
to four files and 10 MiB total. Invalid files, recordings with no detected speech
and files over these limits receive an error. If a technical term or repository
name is misheard, send the corrected text in the same conversation.

The plugin uses Qwen3-ASR-0.6B with automatic language detection. Transcription runs
on your RepoDesk server's CPU; response time depends on that server. Nearby
recordings reuse the loaded model, and recent transcripts are briefly cached to
avoid repeating transcription when earlier audio appears in the conversation. No separate
transcription API key is needed. The downloaded public model is cached and reused
when you restart RepoDesk or disable and re-enable the plugin.

Recordings provide reference material. Spoken commands do not run bot controls or
authorize GitHub changes. For example, send an explicit text request such as
“Use this recording as requirements for the change in owner/repository” and attach
the recording. Your normal repository access and action approvals still apply.

Disabling the plugin stops new transcription and keeps its cached model. Existing
conversation transcripts follow the workspace's normal retention settings. See
[Memory and privacy](memory-and-privacy.md) and
[Telegram usage](telegram-experience.md).
