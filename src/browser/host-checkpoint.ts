import { z } from "zod";

// Root/owner-worker IPC only. Absent from HostResult/model-facing schemas.
export const browserCheckpoint = z
  .object({
    cookies: z
      .array(
        z
          .object({
            name: z.string().max(4096),
            value: z.string().max(4096),
            domain: z.string().max(253),
            path: z.string().max(2048),
            expires: z.literal(-1),
            httpOnly: z.boolean(),
            secure: z.boolean(),
            sameSite: z.enum(["Strict", "Lax", "None"]),
            partitionKey: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type BrowserCheckpoint = z.infer<typeof browserCheckpoint>;
