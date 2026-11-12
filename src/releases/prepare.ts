import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { requireThat } from "../domain.ts";
import { type PreparedRelease, releaseProposal, sha } from "./types.ts";

/** Trusted, credential-free export after repository processes have stopped. */
export async function exportRelease(
  root: string,
  input: { proposal: unknown; targetSha: string; inputRevision: number },
): Promise<PreparedRelease> {
  const proposal = releaseProposal.parse(input.proposal);
  const base = await realpath(root);
  let assetBytes = 0;
  const read = async (path: string, maximum: number) => {
    const target = await realpath(resolve(base, path));
    requireThat(
      target.startsWith(`${base}${sep}`),
      "coding_release_path_denied",
      403,
    );
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      requireThat(
        stat.isFile() && stat.size <= maximum,
        "coding_release_asset_invalid",
        409,
      );
      const bytes = await file.readFile();
      requireThat(bytes.length <= maximum, "coding_release_asset_invalid", 409);
      return bytes;
    } finally {
      await file.close();
    }
  };
  const procedures = [];
  for (const path of proposal.procedures) {
    const bytes = await read(path, 128 * 1024);
    procedures.push({
      path,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const assets = [];
  for (const a of proposal.assets) {
    const bytes = await read(a.path, 1024 * 1024);
    assetBytes += bytes.length;
    requireThat(assetBytes <= 1024 * 1024, "coding_release_asset_invalid", 409);
    assets.push({
      name: a.name,
      digest: createHash("sha256").update(bytes).digest("hex"),
      data: bytes.toString("base64"),
    });
  }
  return {
    proposal,
    targetSha: sha.parse(input.targetSha),
    inputRevision: input.inputRevision,
    procedures,
    assets,
  };
}
