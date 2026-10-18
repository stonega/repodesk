import { createHmac } from "node:crypto";
import { z } from "zod";
import { requireThat } from "../domain.ts";
import { equal } from "../setup/credentials.ts";

export function telegramIdentity(
  raw: string,
  botToken: string,
  now = Date.now(),
) {
  requireThat(
    raw.length > 0 && raw.length <= 16384,
    "miniapp_auth_required",
    401,
  );
  const fields = new URLSearchParams(raw);
  const keys = [...fields.keys()];
  requireThat(new Set(keys).size === keys.length, "miniapp_auth_invalid", 401);
  const signature = fields.get("hash") ?? "";
  fields.delete("hash");
  const check = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", key).update(check).digest("hex");
  requireThat(
    /^[a-f0-9]{64}$/.test(signature) && equal(expected, signature),
    "miniapp_auth_invalid",
    401,
  );
  const issued = Number(fields.get("auth_date")) * 1000;
  requireThat(
    Number.isSafeInteger(issued) &&
      issued <= now + 30000 &&
      issued > now - 24 * 3600000,
    "miniapp_auth_expired",
    401,
  );
  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "null");
  } catch {
    /* Invalid identity fails closed. */
  }
  const parsed = z
    .object({ id: z.number().int().positive().safe() })
    .safeParse(user);
  requireThat(parsed.success, "miniapp_auth_invalid", 401);
  return {
    actor: String(parsed.data.id),
    startParam: fields.get("start_param") ?? "",
  };
}

export function taskReference(workspaceId: string, taskId: string) {
  return `task_${z.uuid().parse(workspaceId).replaceAll("-", "")}_${z.uuid().parse(taskId).replaceAll("-", "")}`;
}
export function resolveTaskReference(value: string) {
  const match = /^task_([a-f0-9]{32})_([a-f0-9]{32})$/.exec(value);
  requireThat(match, "miniapp_task_unavailable", 404);
  const uuid = (hex: string) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    workspaceId: z.uuid().parse(uuid(match[1] ?? "")),
    taskId: z.uuid().parse(uuid(match[2] ?? "")),
  };
}
