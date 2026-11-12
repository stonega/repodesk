import { z } from "zod";

export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const relativeFile = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/);
export const releaseProposal = z
  .object({
    tag: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
    name: z.string().min(1).max(200),
    body: z.string().max(12000),
    draft: z.boolean(),
    prerelease: z.boolean(),
    procedures: z.array(relativeFile).min(1).max(12),
    assets: z
      .array(
        z
          .object({
            path: relativeFile,
            name: z.string().regex(/^[\w][\w.-]{0,127}$/),
          })
          .strict(),
      )
      .max(8),
    ciRequired: z.boolean(),
    unsupported: z.array(z.string().min(1).max(300)).max(12),
  })
  .strict()
  .refine(
    (r) => new Set(r.assets.map((a) => a.name)).size === r.assets.length,
    "duplicate asset",
  );
export type ReleaseProposal = z.infer<typeof releaseProposal>;
export const preparedRelease = z
  .object({
    proposal: releaseProposal,
    targetSha: sha,
    procedures: z
      .array(z.object({ path: relativeFile, digest }))
      .min(1)
      .max(12),
    assets: z
      .array(
        z.object({
          name: z.string().regex(/^[\w][\w.-]{0,127}$/),
          digest,
          data: z.string().max(1400000),
        }),
      )
      .max(8),
    inputRevision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (p) =>
      p.proposal.procedures.length === p.procedures.length &&
      p.proposal.procedures.every((path) =>
        p.procedures.some((d) => d.path === path),
      ) &&
      new Set(p.procedures.map((d) => d.path)).size === p.procedures.length &&
      p.proposal.assets.length === p.assets.length &&
      p.proposal.assets.every((a) => p.assets.some((d) => d.name === a.name)) &&
      new Set(p.assets.map((a) => a.name)).size === p.assets.length,
    "release manifest mismatch",
  );
export type PreparedRelease = z.infer<typeof preparedRelease>;
export interface TaskRelease {
  publishAuthorized?: boolean;
  revision: number;
  prepared: PreparedRelease;
  state:
    | "prepared"
    | "waiting_ci"
    | "waiting_merge"
    | "publishing"
    | "published"
    | "blocked"
    | "unknown";
  url?: string;
  error?: string;
  pr?: { number: number; headSha: string };
  nextPollAt?: string;
}
