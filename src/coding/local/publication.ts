import { z } from "zod";
import { branchName } from "../config.ts";

/** Call only after proving HEAD descends from expectedHead. The lease is a CAS,
 * including when another maintainer deletes or rewinds the remote branch. */
export function publicationPushArgs(branch: string, expectedHead?: string) {
  branchName.parse(branch);
  if (expectedHead)
    z.string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(expectedHead);
  return [
    "push",
    "--porcelain",
    ...(expectedHead
      ? [`--force-with-lease=refs/heads/${branch}:${expectedHead}`]
      : []),
    "origin",
    `HEAD:refs/heads/${branch}`,
  ];
}
