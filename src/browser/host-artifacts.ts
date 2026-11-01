import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requireThat } from "../domain.ts";
import { browserLimits, browserUrl } from "./config.ts";
import type { BrowserHostPolicy, HostResult } from "./protocol.ts";

export const browserArtifact = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(160),
    size: z.number().int().nonnegative().max(browserLimits.downloadBytes),
    mimeType: z.enum(["image/jpeg", "application/octet-stream"]),
    origin: browserUrl.refine((value) => new URL(value).origin === value),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserArtifact = z.infer<typeof browserArtifact>;
const writes = new Map<string, Promise<void>>();
export async function browserArtifacts(home: string) {
  try {
    const file = await open(
      join(home, "artifacts", "index.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      requireThat(
        info.isFile() && info.size <= 65536 && info.nlink === 1,
        "browser_artifact_unavailable",
        404,
      );
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer);
      requireThat(bytesRead <= 65536, "browser_artifact_unavailable", 404);
      return z
        .array(browserArtifact)
        .max(100)
        .parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export function saveBrowserArtifact(
  home: string,
  artifact: BrowserArtifact,
): Promise<void> {
  const previous = writes.get(home) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => saveArtifact(home, artifact));
  writes.set(home, next);
  void next
    .finally(() => {
      if (writes.get(home) === next) writes.delete(home);
    })
    .catch(() => {});
  return next;
}
async function saveArtifact(home: string, artifact: BrowserArtifact) {
  browserArtifact.parse(artifact);
  await mkdir(join(home, "artifacts"), { recursive: true, mode: 0o700 });
  const current = await browserArtifacts(home);
  current.push(artifact);
  const screenshots = current
    .filter((item) => item.mimeType === "image/jpeg")
    .slice(-50);
  const keep = current.filter(
    (item) =>
      item.at > Date.now() - 24 * 3600_000 &&
      (item.mimeType !== "image/jpeg" || screenshots.includes(item)),
  );
  for (const item of current)
    if (!keep.includes(item))
      await unlink(join(home, "artifacts", item.id)).catch(() => {});
  const temporary = join(home, "artifacts", `${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(keep), {
    mode: 0o600,
  });
  await rename(temporary, join(home, "artifacts", "index.json"));
}
/** Called in the profile UID, including when Chrome itself has idled down. */
export async function readBrowserArtifact(
  home: string,
  id: string,
  policy: BrowserHostPolicy,
): Promise<HostResult> {
  z.uuid().parse(id);
  const artifact = (await browserArtifacts(home)).find(
    (item) =>
      item.id === id &&
      policy.origins.includes(item.origin) &&
      item.at > Date.now() - 24 * 3600_000,
  );
  requireThat(artifact, "browser_artifact_unavailable", 404);
  const file = await open(
    join(home, "artifacts", id),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    requireThat(
      stat.isFile() &&
        stat.size <= browserLimits.downloadBytes &&
        stat.nlink === 1,
      "browser_artifact_unavailable",
      404,
    );
    const data = await file.readFile();
    requireThat(
      data.length <= browserLimits.downloadBytes,
      "browser_artifact_unavailable",
      404,
    );
    return {
      status: "completed",
      artifact: {
        id: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        data: data.toString("base64"),
      },
    };
  } finally {
    await file.close();
  }
}
