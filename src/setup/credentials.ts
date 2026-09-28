import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { requireThat } from "../domain.ts";

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function encrypt(key: string, name: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(`repodesk:v2:${name}`));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v2",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(".");
}
export function decrypt(key: string, name: string, value: string) {
  const [version, iv, tag, data] = value.split(".");
  requireThat(
    (version === "v1" || version === "v2") && iv && tag && data,
    "invalid_ciphertext",
  );
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(iv, "base64"),
  );
  cipher.setAAD(
    Buffer.from(`${version === "v1" ? "deepx:v1" : "repodesk:v2"}:${name}`),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "base64")),
    cipher.final(),
  ]).toString("utf8");
}
export async function passwordHash(password: string) {
  requireThat(
    password.length >= 12 && password.length <= 256,
    "password_must_be_12_to_256_characters",
  );
  const salt = randomBytes(16).toString("hex");
  const derived = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, key] = encoded.split(":");
  if (!salt || !key || password.length > 256) return false;
  const derived = (await derive(password, salt, 64)) as Buffer;
  return equal(derived.toString("hex"), key);
}

/** Stable across PostgreSQL JSONB key ordering and process restarts. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return v;
  };
  return hash(JSON.stringify(canonical(value)));
}
