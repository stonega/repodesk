import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseGitHub } from "../../src/releases/github.ts";
import { exportRelease } from "../../src/releases/prepare.ts";
import { releasePayloadHash } from "../../src/releases/service.ts";
import type { ReleaseProposal } from "../../src/releases/types.ts";

const proposal = (): ReleaseProposal => ({
  tag: "v1.2.0",
  name: "v1.2.0",
  body: "Changes",
  draft: false,
  prerelease: false,
  procedures: ["docs/release.md"],
  assets: [{ name: "bundle.txt", path: "build/bundle.txt" }],
  ciRequired: false,
  unsupported: [],
});
test("trusted export computes procedure and asset hashes from actual retained files", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "repodesk-release-artifacts-"),
  );
  try {
    await mkdir(join(directory, "docs"));
    await mkdir(join(directory, "build"));
    await writeFile(
      join(directory, "docs/release.md"),
      "Run checks then publish",
    );
    await writeFile(join(directory, "build/bundle.txt"), "verified artifact");
    const result = await exportRelease(directory, {
      proposal: proposal(),
      targetSha: "a".repeat(40),
      inputRevision: 2,
    });
    expect(result.inputRevision).toBe(2);
    expect(result.assets[0]?.digest).toBe(
      createHash("sha256").update("verified artifact").digest("hex"),
    );
    expect(Buffer.from(result.assets[0]?.data ?? "", "base64").toString()).toBe(
      "verified artifact",
    );
    expect(result.procedures[0]?.digest).toBe(
      createHash("sha256").update("Run checks then publish").digest("hex"),
    );
    const reordered = {
      ...result,
      proposal: Object.fromEntries(
        Object.entries(result.proposal).reverse(),
      ) as typeof result.proposal,
    };
    expect(releasePayloadHash(reordered)).toBe(releasePayloadHash(result));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("export rejects path traversal, symlinks outside the checkout, duplicate names and oversized assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-release-paths-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(root, "secret"), "private");
  try {
    await writeFile(join(repo, "guide.md"), "guide");
    await symlink(join(root, "secret"), join(repo, "asset"));
    const p = {
      ...proposal(),
      procedures: ["guide.md"],
      assets: [{ name: "bundle", path: "asset" }],
    };
    await expect(
      exportRelease(repo, {
        proposal: p,
        targetSha: "a".repeat(40),
        inputRevision: 1,
      }),
    ).rejects.toThrow("coding_release_path_denied");
    await expect(
      exportRelease(repo, {
        proposal: { ...p, procedures: ["../secret"] },
        targetSha: "a".repeat(40),
        inputRevision: 1,
      }),
    ).rejects.toThrow();
    await writeFile(join(repo, "big"), Buffer.alloc(1024 * 1024 + 1));
    await expect(
      exportRelease(repo, {
        proposal: { ...p, assets: [{ name: "big", path: "big" }] },
        targetSha: "a".repeat(40),
        inputRevision: 1,
      }),
    ).rejects.toThrow("coding_release_asset_invalid");
    await expect(
      exportRelease(repo, {
        proposal: { ...p, assets: [p.assets[0], p.assets[0]] },
        targetSha: "a".repeat(40),
        inputRevision: 1,
      }),
    ).rejects.toThrow("duplicate asset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("release clients register without HTTP and sanitize unknown write failures", async () => {
  let calls = 0;
  const github = new ReleaseGitHub(
    "example/workspace",
    "private-token",
    (async () => {
      calls++;
      throw Error("private upstream exception");
    }) as unknown as typeof fetch,
  );
  expect(calls).toBe(0);
  await expect(github.createTag("v1.2.0", "a".repeat(40))).rejects.toThrow(
    "coding_release_outcome_unknown",
  );
  expect(calls).toBe(1);
});
test("asset uploads verify bytes and use only the fixed GitHub upload destination", async () => {
  let calls = 0;
  const github = new ReleaseGitHub("example/workspace", "synthetic", (async (
    input,
    init,
  ) => {
    calls++;
    expect(String(input)).toBe(
      "https://uploads.github.com/repos/example/workspace/releases/77/assets?name=bundle.txt",
    );
    expect(init?.redirect).toBe("error");
    expect(init?.method).toBe("POST");
    return Response.json({ id: 1 }, { status: 201 });
  }) as typeof fetch);
  const file = {
    name: "bundle.txt",
    data: Buffer.from("artifact").toString("base64"),
    digest: createHash("sha256").update("artifact").digest("hex"),
  };
  await github.upload(77, file);
  await expect(
    github.upload(77, {
      ...file,
      data: Buffer.from("changed").toString("base64"),
    }),
  ).rejects.toThrow("coding_release_asset_invalid");
  expect(calls).toBe(1);
});
