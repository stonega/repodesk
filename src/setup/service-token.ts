import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
/** Publish a complete token once; restarts and concurrent initializers preserve it. */
export function initializeServiceToken(
  path: string,
  invalidMessage = "Saved service token is invalid",
) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${randomBytes(16).toString("hex")}.pending`;
  writeFileSync(temporary, `${randomBytes(32).toString("hex")}\n`, {
    flag: "wx",
    mode: 0o444,
  });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  if (readFileSync(path, "utf8").trim().length < 32)
    throw Error(invalidMessage);
  // The private volume is mounted read-only in both Node and Bun containers.
  chmodSync(path, 0o444);
}
