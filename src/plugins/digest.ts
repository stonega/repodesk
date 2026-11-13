import { createHash } from "node:crypto";
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
