# Telegram media input staging check

Use an explicitly configured staging workspace and an authorized Telegram account.
These manual checks send messages and may incur model charges; local automated tests
use fixtures. See [supported formats and limits](../docs/implementation/telegram-attachments.md).

1. In a private Topic, send a screenshot with the caption “Explain this error.”
   Confirm an image-grounded answer in the same Topic. Send a photo without a caption
   and confirm it also receives an answer.
2. Send the same PNG as a document with “What does this show?” Verify it remains an
   image input. Use a vision-capable configured model.
3. Send `notes.md`, `app.ts` or `data.csv` with a question about its contents. Confirm
   the answer uses the actual file text. Try a small selectable-text PDF as well.
4. In a linked group with collection off, send an unaddressed image: the bot should
   stay quiet. Send a photo captioned `@YOUR_BOT explain this screenshot`, then a file
   replying to the bot. Both should receive answers in the correct group/Topic.
5. Send a ZIP, a scanned PDF and an oversized file. Expect readable format/limit
   feedback. Follow with a text message in the same Topic; it should still work.
6. Queue a file request, revoke its actor before execution, and confirm that no
   file is downloaded or sent to the model. Native Stop and `/cancel` should also
   interrupt pending work and suppress the final reply.
7. With a catalog text-only model, send an image and confirm clear feedback rather
   than an answer that pretends to have seen it.
8. In a staging repository with Direct execution enabled, send a screenshot with
   a specific implementation request. Confirm Codex refers to the image rather
   than asking for the already-supplied screenshot. If it asks for a necessary
   reference, reply with a photo without a caption. Confirm the existing task
   consumes that answer instead of starting a separate Pi conversation. Repeat
   with a captioned image document, a runner restart and multiple tasks in one
   Topic; the latter must offer task selection. Cancel the staging task afterward
   unless publishing its verified draft PR is part of the authorized check.

The bot does not combine album updates into a single request or copy files into a
Codex task checkout. Send one file per request for predictable results.
