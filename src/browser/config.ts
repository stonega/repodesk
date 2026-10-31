import { z } from "zod";
import type { Workspace } from "../domain.ts";

export const browserTools = ["browser_session", "browser_action"] as const;
export const browserLimits = {
  leaseMs: 120_000,
  requestMs: 10 * 60_000,
  operationMs: 30_000,
  tabs: 8,
  downloads: 20,
  downloadBytes: 25 * 1024 * 1024,
  resultChars: 24_000,
  inputChars: 4096,
} as const;

export interface BrowserSettings {
  enabled: boolean;
  generation: number;
  previewOrigins?: string[];
}
export const browserEnabled = (w: Workspace) =>
  w.plugins?.browser?.enabled ?? true;
export const browserGeneration = (w: Workspace) =>
  w.plugins?.browser?.generation ?? 0;

export const browserOwner = z
  .object({
    workspaceId: z.uuid(),
    actor: z.string().regex(/^[1-9]\d{0,15}$/),
  })
  .strict();
export type BrowserOwner = z.infer<typeof browserOwner>;
export const browserController = z
  .object({
    kind: z.enum(["chat", "codex", "plugin", "human"]),
    id: z.uuid(),
    fence: z.number().int().nonnegative().safe(),
    pluginId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/)
      .optional(),
    pluginRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.kind !== "plugin" || !!v.pluginId);
export type BrowserController = z.infer<typeof browserController>;

// Models can name a browser operation, never an actor, server path or credential.
export const browserUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use an HTTP(S) URL without embedded credentials.");
export const browserAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_site"), url: browserUrl }).strict(),
  z.object({ action: z.literal("navigate"), url: browserUrl }).strict(),
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("new_tab") }).strict(),
  z
    .object({
      action: z.literal("pointer"),
      x: z.number().int().min(0).max(1280),
      y: z.number().int().min(0).max(800),
    })
    .strict(),
  z
    .object({ action: z.literal("select_tab"), tabId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("close_tab"), tabId: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      selector: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("fill"),
      selector: z.string().min(1).max(500),
      text: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      key: z.enum([
        "Enter",
        "Tab",
        "Shift+Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Control+A",
        "Meta+A",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: z.number().int().min(-4000).max(4000),
      y: z.number().int().min(-4000).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("request_input"),
      selector: z.string().min(1).max(500),
      label: z.string().trim().min(1).max(100),
      kind: z.enum(["password", "code", "text"]),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof browserAction>;

export interface BrowserPluginPage {
  revision: number;
  settings: BrowserSettings;
  serviceConfigured: boolean;
}
export const browserSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: z
      .object({
        enabled: z.boolean(),
        previewOrigins: z
          .array(
            browserUrl.refine((value) => {
              const url = new URL(value);
              return (
                url.origin === value &&
                ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
              );
            }),
          )
          .max(8)
          .optional(),
      })
      .strict(),
  })
  .strict();
export const browserSession = z
  .object({
    action: z.enum(["status", "acquire", "release", "close"]),
  })
  .strict();
