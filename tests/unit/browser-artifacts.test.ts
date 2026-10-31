import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserArtifacts,
  readBrowserArtifact,
  saveBrowserArtifact,
} from "../../src/browser/host-artifacts.ts";

describe("private persistent browser artifacts", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });
  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "repodesk-browser-artifacts-"));
    roots.push(home);
    await mkdir(join(home, "artifacts"), { mode: 0o700 });
    const item = {
      id: randomUUID(),
      name: "report.txt",
      size: 7,
      mimeType: "application/octet-stream" as const,
      origin: "https://private.example",
      at: Date.now(),
    };
    await writeFile(join(home, "artifacts", item.id), "private", {
      mode: 0o600,
    });
    await saveBrowserArtifact(home, item);
    return {
      home,
      item,
      policy: { origins: [item.origin], previewOrigins: [], interact: false },
    };
  }
  test("retains a download independently of a browser process", async () => {
    const f = await fixture();
    expect(
      (await readBrowserArtifact(f.home, f.item.id, f.policy)).artifact?.data,
    ).toBe(Buffer.from("private").toString("base64"));
    expect((await browserArtifacts(f.home))[0]?.name).toBe("report.txt");
  });
  test("a different profile or site grant cannot fetch the artifact", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      readBrowserArtifact(b.home, a.item.id, a.policy),
    ).rejects.toThrow("browser_artifact_unavailable");
    await expect(
      readBrowserArtifact(a.home, a.item.id, {
        ...a.policy,
        origins: ["https://other.example"],
      }),
    ).rejects.toThrow("browser_artifact_unavailable");
    await expect(
      readBrowserArtifact(a.home, "../../etc/passwd", a.policy),
    ).rejects.toThrow();
  });
  test("rejects symbolic and hard links even with a valid artifact reference", async () => {
    const f = await fixture();
    const path = join(f.home, "artifacts", f.item.id);
    const privatePath = join(f.home, "other-private-data");
    await writeFile(privatePath, "other private content");
    await rm(path);
    await symlink(privatePath, path);
    await expect(
      readBrowserArtifact(f.home, f.item.id, f.policy),
    ).rejects.toThrow();
    await rm(path);
    await link(privatePath, path);
    await expect(
      readBrowserArtifact(f.home, f.item.id, f.policy),
    ).rejects.toThrow("browser_artifact_unavailable");
  });
  test("serializes concurrent screenshot/download metadata without lost entries", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        saveBrowserArtifact(f.home, {
          ...f.item,
          id: randomUUID(),
          name: `download-${i}.txt`,
        }),
      ),
    );
    expect(await browserArtifacts(f.home)).toHaveLength(13);
  });
  test("expires old private files and retains valid downloads", async () => {
    const f = await fixture();
    const expired = {
      ...f.item,
      id: randomUUID(),
      at: Date.now() - 2 * 24 * 3600_000,
    };
    await writeFile(join(f.home, "artifacts", expired.id), "expired");
    await saveBrowserArtifact(f.home, expired);
    await expect(
      readFile(join(f.home, "artifacts", expired.id)),
    ).rejects.toThrow();
    expect(await browserArtifacts(f.home)).toHaveLength(1);
  });
  test("rejects oversized manifests before parsing", async () => {
    const f = await fixture();
    await writeFile(join(f.home, "artifacts", "index.json"), "x".repeat(65537));
    await expect(browserArtifacts(f.home)).rejects.toThrow(
      "browser_artifact_unavailable",
    );
  });
});
