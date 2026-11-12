import { z } from "zod";

export const nowledgeTools = [
  "query_nowledge_mem",
  "save_nowledge_mem",
] as const;
export const nowledgeUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !/\/(?:mcp|app)\/?$/.test(url.pathname)
    );
  }, "Use the HTTPS server base URL, or HTTP on loopback, without /mcp or /app.");
export const nowledgeSettings = z
  .object({
    enabled: z.boolean(),
    apiUrl: z.union([nowledgeUrl, z.literal("")]),
    memberId: z.string().regex(/^\d+$/).or(z.literal("")),
    spaceId: z.string().trim().max(200),
    spaceName: z.string().trim().max(200),
  })
  .strict();
export type NowledgeSettings = z.infer<typeof nowledgeSettings>;
export interface NowledgeConfig {
  settings: NowledgeSettings;
  credential?: string;
  botId?: string;
}
export const emptyNowledge: NowledgeSettings = {
  enabled: false,
  apiUrl: "",
  memberId: "",
  spaceId: "",
  spaceName: "",
};
export const nowledgeSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: nowledgeSettings,
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    removeCredential: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.apiKey && v.removeCredential));
export interface NowledgePage {
  revision: number;
  settings: NowledgeSettings;
  credentialConfigured: boolean;
  members: { id: string; name: string }[];
}
export const nowledgeQuery = z
  .object({
    query: z.string().trim().min(1).max(2000).optional(),
    id: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict()
  .refine((v) => !(v.query && v.id));
export const nowledgeWrite = z
  .object({ sourceId: z.string().min(1).max(200) })
  .strict();
