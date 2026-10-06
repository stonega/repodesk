import { expect, test } from "bun:test";
import type { Attachment } from "../../src/domain.ts";
import { Fault } from "../../src/domain.ts";
import {
  decodeAttachment,
  loadAttachments,
  MAX_ATTACHMENT_BYTES,
  messageAttachments,
} from "../../src/telegram/attachments.ts";
import { TelegramClient } from "../../src/telegram/client.ts";
import { command, updateSchema } from "../../src/telegram/router.ts";
import { memoryReferences } from "../../src/workspaces/conversation-memory.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const signal = new AbortController().signal;
const attachment: Attachment = {
  botId: "999",
  fileId: "file",
  kind: "document",
  name: "notes.txt",
  mimeType: "text/plain",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNFEAAAAASUVORK5CYII=",
  "base64",
);
const bot = { id: "999", username: "test_bot" };
const message = {
  message_id: 1,
  date: 1,
  from: { id: 101, is_bot: false },
  chat: { id: 101, type: "private" as const },
};

// A local, selectable-text PDF; no downloads or parser mocks.
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(value.length);
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = value.length;
  value += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}

test("schema keeps photos, documents and caption entities; caption routing uses UTF-16 offsets", () => {
  const photo = updateSchema.parse({
    update_id: 1,
    message: {
      ...message,
      photo: [
        { file_id: "small", width: 100, height: 100 },
        { file_id: "large", width: 800, height: 600 },
      ],
    },
  }).message;
  if (!photo) throw Error("missing photo");
  expect(messageAttachments(photo, bot.id)[0]?.fileId).toBe("large");
  expect(command(photo, bot)).toEqual({ name: "ask", args: "" });
  const document = updateSchema.parse({
    update_id: 2,
    message: {
      ...message,
      chat: { id: -100100, type: "supergroup" },
      document: {
        file_id: "document",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 123,
      },
      caption: "👋 @test_bot explain",
      caption_entities: [{ type: "mention", offset: 3, length: 9 }],
    },
  }).message;
  if (!document) throw Error("missing document");
  expect(command(document, bot)).toEqual({ name: "ask", args: "👋  explain" });
  expect(messageAttachments(document, bot.id)[0]).toMatchObject({
    botId: "999",
    fileId: "document",
    kind: "document",
    name: "report.pdf",
    size: 123,
  });
  expect(
    command({ ...document, caption_entities: undefined }, bot),
  ).toBeUndefined();
  expect(
    command(
      {
        ...document,
        caption: "/ask inspect",
        caption_entities: [{ type: "bot_command", offset: 0, length: 4 }],
      },
      bot,
    ),
  ).toEqual({ name: "ask", args: "inspect" });
});

test("decodes actual image bytes, UTF-8 code and selectable PDF text", async () => {
  expect(
    await decodeAttachment(
      { ...attachment, mimeType: "image/png" },
      png,
      signal,
    ),
  ).toEqual({
    image: {
      type: "image",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  });
  expect(
    await decodeAttachment(
      attachment,
      Buffer.from("export const answer = 42;\n你好"),
      signal,
    ),
  ).toEqual({ text: "export const answer = 42;\n你好" });
  expect(
    (
      await decodeAttachment(
        { ...attachment, mimeType: "application/pdf" },
        pdf("Release notes"),
        signal,
      )
    ).text,
  ).toContain("Release notes");
});

test("rejects binary, oversized, unsupported and corrupt files without truncation", async () => {
  for (const [file, data, code] of [
    [attachment, Buffer.from([255, 0, 1]), "attachment_invalid"],
    [
      attachment,
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
      "attachment_too_large",
    ],
    [attachment, Buffer.from("a".repeat(32001)), "attachment_text_limit"],
    [
      { ...attachment, kind: "voice" },
      Buffer.from("OggS"),
      "attachment_unsupported",
    ],
    [
      { ...attachment, name: "archive.zip", mimeType: "application/zip" },
      Buffer.from("PK"),
      "attachment_unsupported",
    ],
    [
      { ...attachment, mimeType: "application/pdf" },
      Buffer.from("%PDF-corrupt"),
      "attachment_invalid",
    ],
    [attachment, pdf(""), "attachment_pdf_no_text"],
  ] as const)
    await expect(decodeAttachment(file, data, signal)).rejects.toThrow(code);
  const controller = new AbortController();
  controller.abort(new Fault("cancelled"));
  await expect(
    decodeAttachment(attachment, png, controller.signal),
  ).rejects.toThrow("cancelled");
});

test("downloads only Bot API paths and caps declared and streaming sizes", async () => {
  const urls: string[] = [];
  let path = "documents/file.txt";
  let declaredSize: number | undefined;
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return urls.at(-1)?.endsWith("getFile")
      ? Response.json({
          ok: true,
          result: { file_path: path, file_size: declaredSize },
        })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("abc"));
              controller.enqueue(Buffer.from("def"));
              controller.close();
            },
          }),
        );
  }) as typeof fetch;
  const client = new TelegramClient("test-secret", fetcher);
  expect(Buffer.from(await client.downloadFile("file", 6)).toString()).toBe(
    "abcdef",
  );
  expect(urls.at(-1)).toBe(
    "https://api.telegram.org/file/bottest-secret/documents/file.txt",
  );
  await expect(client.downloadFile("file", 5)).rejects.toThrow(
    "attachment_too_large",
  );
  declaredSize = 20;
  const before = urls.length;
  await expect(client.downloadFile("file", 5)).rejects.toThrow(
    "attachment_too_large",
  );
  expect(urls.length - before).toBe(1);
  declaredSize = undefined;
  for (path of [
    "https://evil.example/file",
    "../private",
    "documents/../private",
    "/etc/passwd",
    "documents/%2e%2e/file",
  ]) {
    const before = urls.length;
    await expect(client.downloadFile("file", 5)).rejects.toThrow(
      "attachment_download_failed",
    );
    expect(urls.length - before).toBe(1);
  }
});

test("media loading checks revocation and bot/source binding before fetching", async () => {
  const w = workspace();
  const run = createRun(
    w,
    "101",
    "Inspect attachment",
    "101",
    10,
    "gpt-4.1-mini",
    { botId: "999", replyTo: 1 },
  );
  const source = run.sources[0];
  if (!source) throw Error("missing source");
  source.attachments = [attachment];
  let downloads = 0;
  const client = async () => ({
    async call<T>() {
      return true as T;
    },
    async downloadFile() {
      downloads++;
      return png;
    },
  });
  const loaded = await loadAttachments(
    run,
    "999",
    client,
    async () => {},
    signal,
  );
  expect(loaded.images).toHaveLength(1);
  expect(loaded.prompt).toContain(source.id);
  expect(loaded.prompt).toContain('"imageIndex":1');
  expect(downloads).toBe(1);
  await expect(
    loadAttachments(run, "other-bot", client, async () => {}, signal),
  ).rejects.toThrow("run_revoked");
  await expect(
    loadAttachments(
      run,
      "999",
      client,
      async () => {
        throw new Fault("run_revoked");
      },
      signal,
    ),
  ).rejects.toThrow("run_revoked");
  expect(downloads).toBe(1);
  source.expiresAt = new Date(0).toISOString();
  await expect(
    loadAttachments(run, "999", client, async () => {}, signal),
  ).rejects.toThrow("run_revoked");
  expect(downloads).toBe(1);
});

test("attachment edits invalidate memory; prior unsupported attachments do not poison later requests", async () => {
  const w = workspace();
  const run = createRun(
    w,
    "101",
    "Inspect attachment",
    "101",
    10,
    "gpt-4.1-mini",
    { botId: "999", replyTo: 2 },
  );
  const current = run.sources[0];
  if (!current) throw Error("missing source");
  const old = {
    ...current,
    id: "old",
    runId: "old-run",
    attachments: [
      { ...attachment, name: "archive.zip", mimeType: "application/zip" },
    ],
  };
  const hash = memoryReferences([old]);
  expect(
    memoryReferences([
      { ...old, attachments: [{ ...attachment, fileId: "edited" }] },
    ]).sourceHash,
  ).not.toBe(hash.sourceHash);
  run.sources.unshift(old);
  const result = await loadAttachments(
    run,
    "999",
    async () => ({
      async call<T>() {
        return true as T;
      },
      async downloadFile() {
        return Buffer.from("PK");
      },
    }),
    async () => {},
    signal,
  );
  expect(result.prompt).toContain("unavailable");
  expect(result.images).toHaveLength(0);
});
