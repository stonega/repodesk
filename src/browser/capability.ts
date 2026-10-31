import { createHmac } from "node:crypto";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { equal } from "../setup/credentials.ts";
import { browserOwner, browserUrl } from "./config.ts";

export const codingBrowserBridge = z
  .object({ url: browserUrl, token: z.string().min(1).max(4096) })
  .strict();
export type CodingBrowserBridge = z.infer<typeof codingBrowserBridge>;
const capability = browserOwner
  .extend({
    taskId: z.uuid(),
    attemptId: z.uuid(),
    fence: z.number().int().nonnegative(),
    configuration: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    botId: z.string().regex(/^[1-9]\d*$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type BrowserCapability = z.infer<typeof capability>;
const sign = (key: string, value: string) =>
  createHmac("sha256", key)
    .update(`repodesk:browser:codex:v1\n${value}`)
    .digest("hex");
export function signBrowserCapability(key: string, input: BrowserCapability) {
  const body = Buffer.from(JSON.stringify(capability.parse(input))).toString(
    "base64url",
  );
  return `${body}.${sign(key, body)}`;
}
export function verifyBrowserCapability(key: string, token: string) {
  requireThat(token.length <= 4096, "browser_unauthorized", 401);
  const [body = "", signature = "", extra] = token.split(".");
  requireThat(
    !extra &&
      /^[a-f0-9]{64}$/.test(signature) &&
      equal(signature, sign(key, body)),
    "browser_unauthorized",
    401,
  );
  let value: BrowserCapability;
  try {
    value = capability.parse(
      JSON.parse(Buffer.from(body, "base64url").toString()),
    );
  } catch {
    throw new Fault("browser_unauthorized", 401);
  }
  requireThat(
    value.expiresAt > Date.now(),
    "browser_authorization_expired",
    403,
  );
  return value;
}
