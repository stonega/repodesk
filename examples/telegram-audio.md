# Telegram audio journey

Use a dedicated test bot/workspace. These steps send messages only when the
operator performs them; local setup does not send Telegram messages.

1. Build and start the updated app and worker with the shared model volume.
2. Open **Plugins → Qwen3-ASR** as the workspace's deployment operator.
3. Enable the plugin. Check that Downloading appears and eventually becomes Ready.
   If network access fails, restore connectivity and use Retry download.
4. In private Telegram, send a short voice note asking a repository question.
   Check that the bot answers the question naturally in the correct conversation/topic,
   without a queued acknowledgement or unsolicited transcript. Ask explicitly for
   a transcript and check that it is provided when requested.
5. Send a mixed-language recording with a repository name and correct any misheard
   term in a text reply. Check that the follow-up stays in the same conversation.
   Send a second short voice note: the current recording should drive the answer,
   with the earlier one only supplying context. Compare cold/warm response times
   on the deployment host; neither an earlier successful transcript nor local
   deterministic fixtures establish recognition accuracy for the new recording.
6. In a linked group, reply to the bot with a voice note. An ordinary undirected
   recording should not trigger a transcription reply.
7. Send an explicit text-authorized coding request with an audio recording as its
   requirements. Check that Codex receives transcript reference data and that
   existing repository grants and publication rules apply.
8. Disable the plugin and send a new voice note. Check the disabled feedback and
   that it is not downloaded or transcribed. Re-enable and check cached model reuse.
9. Try an invalid recording, a recording over two minutes, a file over 5 MiB and
   cancellation during transcription. Confirm readable errors and no late response.
10. Restart app/worker and check the model remains Ready without downloading again.

Voice-only or forwarded instructions must not authorize external writes or execute
bot controls. No real API credentials or private recordings belong in test fixtures.
