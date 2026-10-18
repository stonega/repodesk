import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { type TranscriptEntry, transcriptEntry } from "../transcript.ts";

export async function appendTranscript(path: string, entry: TranscriptEntry) {
  const file = await open(path, "a+", 0o600);
  try {
    const size = (await file.stat()).size;
    if (size) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) await file.appendFile("\n");
    }
    await file.appendFile(`${JSON.stringify(transcriptEntry.parse(entry))}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Byte cursors are private to the worker. Reads run under the supervisor's serial lock. */
export async function readTranscript(path: string, offset = 0) {
  const size = await stat(path)
    .then((s) => s.size)
    .catch((e) => {
      if (e.code === "ENOENT") return 0;
      throw e;
    });
  const entries: TranscriptEntry[] = [];
  if (offset >= size) return { entries, offset, hasMore: false };
  const stream = createReadStream(path, { start: offset });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const bytes = Buffer.byteLength(line) + 1;
      // A process crash can leave a partial final line; do not claim it was captured.
      if (offset + bytes > size) break;
      offset += bytes;
      try {
        entries.push({
          ...transcriptEntry.parse(JSON.parse(line)),
          sequence: offset,
        });
      } catch {
        /* Skip an interrupted record. */
      }
      if (entries.length === 64) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { entries, offset, hasMore: offset < size && entries.length === 64 };
}
