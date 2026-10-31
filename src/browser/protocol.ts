import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireThat } from "../domain.ts";
import { equal } from "../setup/credentials.ts";
import {
  browserAction,
  browserController,
  browserOwner,
  browserUrl,
} from "./config.ts";

const integer = z.number().int().nonnegative().safe();
const origin = browserUrl.refine((value) => new URL(value).origin === value);
export const browserHostPolicy = z
  .object({
    origins: z.array(origin).max(32),
    previewOrigins: z.array(origin).max(8),
    interact: z.boolean(),
  })
  .strict();
export type BrowserHostPolicy = z.infer<typeof browserHostPolicy>;
export const deniedBrowserPolicy: BrowserHostPolicy = {
  origins: [],
  previewOrigins: [],
  interact: false,
};
export const hostCommand = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z
    .object({
      command: z.literal("observe"),
      view: z.enum(["tabs", "read", "screenshot"]),
    })
    .strict(),
  z.object({ command: z.literal("acquire") }).strict(),
  z.object({ command: z.literal("release") }).strict(),
  z.object({ command: z.literal("close") }).strict(),
  z.object({ command: z.literal("delete") }).strict(),
  z.object({ command: z.literal("artifact"), id: z.uuid() }).strict(),
  z
    .object({
      command: z.literal("action"),
      input: browserAction,
      page: z
        .object({ id: z.uuid(), revision: integer, origin })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("input"),
      requestId: z.uuid(),
      pageId: z.string().min(1).max(100),
      pageRevision: integer,
      origin: browserUrl.refine((value) => new URL(value).origin === value),
      selector: z.string().min(1).max(500),
      value: z.string().min(1).max(4096),
    })
    .strict(),
]);
export type HostCommand = z.infer<typeof hostCommand>;
export const hostRequest = z
  .object({
    id: z.uuid(),
    owner: browserOwner,
    controller: browserController,
    generation: integer,
    issuedAt: integer,
    expiresAt: integer,
    operation: hostCommand,
    policy: browserHostPolicy.optional(),
  })
  .strict();
export type HostRequest = z.infer<typeof hostRequest>;
export const hostResult = z
  .object({
    status: z.enum(["ready", "closed", "deleted", "completed", "unavailable"]),
    reference: z.uuid().optional(),
    headed: z.literal(true).optional(),
    inputApplied: z.literal(true).optional(),
    blockedOrigins: z.array(origin).max(32).optional(),
    controls: z
      .array(
        z
          .object({
            selector: z.string().max(500),
            role: z.string().max(40),
            label: z.string().max(120),
            type: z.string().max(40).optional(),
            href: browserUrl.optional(),
          })
          .strict(),
      )
      .max(80)
      .optional(),
    artifact: z
      .object({
        id: z.uuid(),
        mimeType: z.enum(["image/jpeg", "application/octet-stream"]),
        name: z.string().min(1).max(160),
        data: z
          .string()
          .max(35 * 1024 * 1024)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .strict()
      .optional(),
    downloads: z
      .array(
        z
          .object({ id: z.uuid(), name: z.string().max(160), size: integer })
          .strict(),
      )
      .max(20)
      .optional(),
    page: z
      .object({
        id: z.uuid(),
        revision: integer,
        origin: browserUrl.refine((value) => new URL(value).origin === value),
      })
      .strict()
      .optional(),
    text: z.string().max(24_000).optional(),
    tabs: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: z.string().max(200),
            url: browserUrl.or(z.literal("about:blank")),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type HostResult = z.infer<typeof hostResult>;
const signature = (key: string, raw: string) =>
  createHmac("sha256", key).update(`repodesk:browser:v1\n${raw}`).digest("hex");
export function signBrowserRequest(
  key: string,
  input: Omit<HostRequest, "id" | "issuedAt" | "expiresAt">,
  now = Date.now(),
) {
  requireThat(key.length >= 32, "browser_credentials_unavailable", 503);
  const body = JSON.stringify(
    hostRequest.parse({
      ...input,
      id: randomUUID(),
      issuedAt: now,
      expiresAt: now + 30_000,
    }),
  );
  return { body, signature: signature(key, body) };
}
export function verifyBrowserRequest(
  key: string,
  raw: string,
  provided: string,
  now = Date.now(),
) {
  requireThat(
    key.length >= 32 &&
      Buffer.byteLength(raw) <= 32_768 &&
      /^[a-f0-9]{64}$/.test(provided) &&
      equal(signature(key, raw), provided),
    "browser_unauthorized",
    401,
  );
  const input = hostRequest.parse(JSON.parse(raw));
  requireThat(
    input.issuedAt <= now + 5000 &&
      input.issuedAt >= now - 30_000 &&
      input.expiresAt > now &&
      input.expiresAt - input.issuedAt <= 30_000 &&
      input.expiresAt > input.issuedAt,
    "browser_request_expired",
    401,
  );
  return input;
}
