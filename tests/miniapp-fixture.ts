import { createHmac } from "node:crypto";
export function signedMiniAppData(
  token: string,
  actor = 101,
  issued = Math.floor(Date.now() / 1000),
  extra: Record<string, string> = {},
) {
  const fields = new URLSearchParams({
    auth_date: String(issued),
    user: JSON.stringify({ id: actor, first_name: "Fixture" }),
    ...extra,
  });
  const check = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  fields.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}
