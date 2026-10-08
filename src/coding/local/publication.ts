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

/** Runs only in the trusted publication container, after verified changes are pushed. */
export async function markPullRequestReady(
  repository: string,
  expected: {
    number: number;
    branch: string;
    headSha: string;
    baseBranch: string;
  },
  token: string,
  transport: typeof fetch = fetch,
) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const response = await transport(
    `https://api.github.com/repos/${repository}/pulls/${expected.number}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw new Error("coding_publication_unknown");
  const pull = z
    .object({
      node_id: z.string().min(1),
      number: z.number().int().positive(),
      state: z.enum(["open", "closed"]),
      merged: z.boolean(),
      draft: z.boolean(),
      head: z.object({
        ref: z.string(),
        sha: z.string(),
        repo: z.object({ full_name: z.string() }).nullable(),
      }),
      base: z.object({ ref: z.string() }),
    })
    .parse(await response.json());
  if (
    pull.number !== expected.number ||
    pull.state !== "open" ||
    pull.merged ||
    pull.head.repo?.full_name !== repository ||
    pull.head.ref !== expected.branch ||
    pull.head.sha !== expected.headSha ||
    pull.base.ref !== expected.baseBranch
  )
    throw new Error("coding_publication_unknown");
  if (!pull.draft) return;
  // Never replay a mutation after a lost acknowledgement; reconcile remote state instead.
  const mutation = await transport("https://api.github.com/graphql", {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      query:
        "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft headRefOid } } }",
      variables: { id: pull.node_id },
    }),
  });
  if (!mutation.ok) throw new Error("coding_publication_unknown");
  const result = z
    .object({
      errors: z.array(z.unknown()).optional(),
      data: z.object({
        markPullRequestReadyForReview: z.object({
          pullRequest: z.object({
            id: z.literal(pull.node_id),
            isDraft: z.literal(false),
            headRefOid: z.literal(expected.headSha),
          }),
        }),
      }),
    })
    .parse(await mutation.json());
  if (result.errors?.length) throw new Error("coding_publication_unknown");
}
