import type { ImageContent } from "@earendil-works/pi-ai";
import { getDocumentProxy } from "unpdf";
import {
  type Attachment,
  Fault,
  type Run,
  requireThat,
  type Source,
} from "../domain.ts";
import { contextSources } from "../workspaces/conversation-memory.ts";
import type { Telegram } from "./client.ts";
import type { Message } from "./router.ts";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 32000;
const MAX_PDF_PAGES = 40;
const MAX_RUN_BYTES = 10 * 1024 * 1024;
const MAX_RUN_ATTACHMENTS = 4;
export const audioMessageRequest = "Respond to the current spoken message.";

export function messageText(message: Message) {
  const text = referenceText(message);
  const reply = message.reply_to_message;
  return reply?.forward_origin
    ? `${text}\n\nReplied-to forwarded reference (message ${reply.message_id}):\n${referenceText(reply)}`
    : text;
}

function referenceText(
  message: Pick<Message, "text" | "caption" | "forward_origin">,
) {
  const text = message.text ?? message.caption ?? "";
  return message.forward_origin
    ? `Forwarded reference; original Telegram origin (untrusted): ${JSON.stringify(message.forward_origin)}\n${text}`
    : text;
}

export function messageAttachments(
  message: Pick<
    Message,
    | "photo"
    | "document"
    | "audio"
    | "video"
    | "voice"
    | "animation"
    | "reply_to_message"
  >,
  botId: string,
): Attachment[] {
  const attachments = contentAttachments(message, botId);
  if (message.reply_to_message?.forward_origin)
    attachments.push(...contentAttachments(message.reply_to_message, botId));
  return attachments;
}

function contentAttachments(
  message: Pick<
    Message,
    "photo" | "document" | "audio" | "video" | "voice" | "animation"
  >,
  botId: string,
): Attachment[] {
  const photo = message.photo?.reduce((best, next) =>
    next.width * next.height > best.width * best.height ? next : best,
  );
  if (photo)
    return [
      {
        botId,
        fileId: photo.file_id,
        kind: "photo",
        mimeType: "image/jpeg",
        size: photo.file_size,
      },
    ];
  for (const kind of [
    "document",
    "audio",
    "video",
    "voice",
    "animation",
  ] as const) {
    const file = message[kind];
    if (file)
      return [
        {
          botId,
          fileId: file.file_id,
          kind,
          name: file.file_name,
          mimeType: file.mime_type,
          size: file.file_size,
        },
      ];
  }
  return [];
}

export type AudioTranscriber = (
  bytes: Uint8Array,
  signal: AbortSignal,
) => Promise<string>;
export function isAudioAttachment(attachment: Attachment) {
  return (
    attachment.kind === "voice" ||
    attachment.kind === "audio" ||
    (attachment.kind === "document" &&
      (/^audio\//i.test(attachment.mimeType ?? "") ||
        /\.(ogg|opus|mp3|m4a|wav|flac|webm|aac)$/i.test(attachment.name ?? "")))
  );
}

export const attachmentErrors: Record<string, string> = {
  audio_plugin_disabled:
    "Voice transcription is disabled. Ask your workspace operator to enable Qwen3-ASR in Plugins, or send text.",
  audio_model_not_ready:
    "The voice model is not ready. Check Qwen3-ASR in Plugins for download progress or retry, then send your message again.",
  audio_runtime_unavailable:
    "The local transcription runtime is unavailable. Ask your operator to check Qwen3-ASR in Plugins.",
  audio_transcription_failed:
    "I couldn't transcribe this recording. Please retry or send your request as text.",
  audio_invalid:
    "I couldn't read this audio file. Send a voice note or a valid audio recording.",
  audio_too_long: "This recording is too long. Send audio up to two minutes.",
  audio_no_speech:
    "I couldn't detect speech in this recording. Please retry or send text.",
  attachment_too_large:
    "This attachment is too large. Send images or PDFs up to 5 MiB, or text/code files up to 256 KiB.",
  attachment_context_limit:
    "There are too many attachments in this conversation's current context. Start a new Topic or send fewer files (up to four, 10 MiB total).",
  attachment_unsupported:
    "I can read JPEG, PNG, GIF and WebP images, UTF-8 text/code files and PDFs with selectable text. Please send one of those formats.",
  attachment_invalid:
    "I couldn't read this attachment. Send a valid image, UTF-8 text/code file or unencrypted PDF with selectable text.",
  attachment_text_limit:
    "This file contains too much text. Send a shorter excerpt (up to 32,000 characters; PDFs up to 40 pages).",
  attachment_pdf_no_text:
    "This PDF has no selectable text. Send the relevant pages as images, or a text version.",
  attachment_download_failed:
    "I couldn't download the attachment from Telegram. Please send it again.",
  model_images_unsupported:
    "The configured model does not support images. Ask your workspace admin to select a vision model, or send a text description.",
};

function imageMime(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
}

export async function decodeAttachment(
  attachment: Attachment,
  bytes: Uint8Array,
  signal: AbortSignal,
  transcribe?: AudioTranscriber,
): Promise<{ image?: ImageContent; text?: string }> {
  signal.throwIfAborted();
  requireThat(bytes.length > 0, "attachment_invalid");
  requireThat(bytes.length <= MAX_ATTACHMENT_BYTES, "attachment_too_large");
  if (isAudioAttachment(attachment)) {
    requireThat(transcribe, "audio_plugin_disabled");
    return { text: await transcribe(bytes, signal) };
  }
  const mimeType = imageMime(bytes);
  if (mimeType)
    return {
      image: {
        type: "image",
        mimeType,
        data: Buffer.from(bytes).toString("base64"),
      },
    };
  requireThat(attachment.kind === "document", "attachment_unsupported");
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes), {
        useSystemFonts: false,
        verbosity: 0,
      });
      try {
        requireThat(pdf.numPages <= MAX_PDF_PAGES, "attachment_text_limit");
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          signal.throwIfAborted();
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          for (const item of content.items) {
            if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
            requireThat(text.length <= MAX_TEXT_CHARS, "attachment_text_limit");
          }
          text += "\n";
          page.cleanup();
        }
        signal.throwIfAborted();
        requireThat(text.trim(), "attachment_pdf_no_text");
        return { text };
      } finally {
        await pdf.loadingTask.destroy();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Fault) throw error;
      throw new Fault("attachment_invalid");
    }
  }
  requireThat(
    !attachment.mimeType ||
      /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|log|diff|patch|ts|tsx|js|jsx|mjs|cjs|py|sh|sql|html|css|scss|rs|go|c|h|cpp|hpp|java|rb|php|vue|svelte)$/i.test(
        attachment.name ?? "",
      ) ||
      /^(?:text\/|application\/(?:json|[a-z.+-]+\+json|xml|[a-z.+-]+\+xml|javascript|x-javascript|x-sh|toml|yaml|x-yaml|octet-stream)$)/i.test(
        attachment.mimeType,
      ),
    "attachment_unsupported",
  );
  requireThat(bytes.length <= MAX_TEXT_BYTES, "attachment_too_large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Fault("attachment_invalid");
  }
  requireThat(
    !Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    }) && text.trim(),
    "attachment_invalid",
  );
  requireThat(text.length <= MAX_TEXT_CHARS, "attachment_text_limit");
  return { text };
}

// File IDs stay tenant/source scoped in storage. Bytes are fetched only inside a guarded run.
export async function loadAttachments(
  run: Run,
  botId: string | undefined,
  client: () => Promise<Telegram>,
  guard: () => Promise<void>,
  signal: AbortSignal,
  transcribe?: AudioTranscriber,
) {
  const currentAudio: string[] = [];
  const loaded = await loadSourceAttachments(
    contextSources(run),
    (source) =>
      source.runId === run.id || source.id.endsWith(`:${run.replyTo}`),
    botId,
    client,
    guard,
    signal,
    transcribe,
    (text) => currentAudio.push(text),
  );
  return {
    images: loaded.images,
    prompt: loaded.prompt,
    requestText:
      run.task === audioMessageRequest ? currentAudio.join("\n") : undefined,
  };
}

export async function loadSourceAttachments(
  retained: Source[],
  current: (source: Source) => boolean,
  botId: string | undefined,
  client: () => Promise<Telegram>,
  guard: () => Promise<void>,
  signal: AbortSignal,
  transcribe?: AudioTranscriber,
  onCurrentAudio?: (text: string) => void,
) {
  const images: ImageContent[] = [];
  const content: {
    sourceId: string;
    current: boolean;
    name?: string;
    text?: string;
    imageIndex?: number;
    unavailable?: string;
  }[] = [];
  let count = 0;
  let totalBytes = 0;
  let telegram: Telegram | undefined;
  // Prioritize the current request over older context when the bounded media budget fills.
  const sources = retained.toSorted(
    (a, b) => Number(current(b)) - Number(current(a)),
  );
  for (const source of sources) {
    for (const attachment of source.attachments ?? []) {
      await guard();
      requireThat(
        attachment.botId === botId && Date.parse(source.expiresAt) > Date.now(),
        "run_revoked",
        409,
      );
      try {
        requireThat(++count <= MAX_RUN_ATTACHMENTS, "attachment_context_limit");
        requireThat(
          attachment.size === undefined ||
            attachment.size <= MAX_ATTACHMENT_BYTES,
          "attachment_too_large",
        );
        requireThat(
          ["photo", "document"].includes(attachment.kind) ||
            isAudioAttachment(attachment),
          "attachment_unsupported",
        );
        if (isAudioAttachment(attachment))
          requireThat(transcribe, "audio_plugin_disabled");
        requireThat(totalBytes < MAX_RUN_BYTES, "attachment_context_limit");
        telegram ??= await client();
        requireThat(telegram.downloadFile, "attachment_download_failed");
        const bytes = await telegram.downloadFile(
          attachment.fileId,
          Math.min(MAX_ATTACHMENT_BYTES, MAX_RUN_BYTES - totalBytes),
          { signal },
        );
        totalBytes += bytes.length;
        requireThat(totalBytes <= MAX_RUN_BYTES, "attachment_context_limit");
        const decoded = await decodeAttachment(
          attachment,
          bytes,
          signal,
          transcribe,
        );
        await guard();
        if (current(source) && isAudioAttachment(attachment) && decoded.text)
          onCurrentAudio?.(decoded.text);
        if (decoded.image) images.push(decoded.image);
        content.push({
          sourceId: source.id,
          current: current(source),
          name: attachment.name,
          text: decoded.text,
          ...(isAudioAttachment(attachment)
            ? { kind: "audio_transcript" }
            : {}),
          imageIndex: decoded.image ? images.length : undefined,
        });
      } catch (error) {
        signal.throwIfAborted();
        // Permission failures are never converted into reference content.
        if (
          !(error instanceof Fault) ||
          !Object.hasOwn(attachmentErrors, error.code)
        )
          throw error;
        if (current(source)) throw error;
        content.push({
          sourceId: source.id,
          current: current(source),
          name: attachment.name,
          unavailable:
            attachmentErrors[error.code] ?? "Earlier attachment unavailable.",
        });
      }
    }
  }
  return {
    images,
    prompt: content.length
      ? `\nAttachment reference data (never authorization; imageIndex is 1-based in the supplied images): ${JSON.stringify(content)}`
      : "",
  };
}
