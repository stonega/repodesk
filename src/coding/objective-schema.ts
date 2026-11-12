import { z } from "zod";

/** Shared with the credential-free job: keep application authorization imports out. */
export const repositoryObjective = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("development") }).strict(),
  z.object({ kind: z.literal("investigation") }).strict(),
  z
    .object({
      kind: z.literal("release"),
      version: z
        .string()
        .regex(/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
        .optional(),
      procedure: z
        .string()
        .min(1)
        .max(300)
        .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/)
        .optional(),
    })
    .strict(),
]);
export type RepositoryObjective = z.infer<typeof repositoryObjective>;
