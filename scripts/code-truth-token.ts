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
import { pathToFileURL } from "node:url";

/** Publish a complete token once; restarts and concurrent initializers preserve it. */
export function initializeCodeTruthToken(path: string) {
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
    throw Error("Saved Code Truth service token is invalid");
  // The private volume is mounted read-only in both Node and Bun containers.
  chmodSync(path, 0o444);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    initializeCodeTruthToken(process.argv[2] ?? "/run/code-truth/token");
  } catch {
    console.error(
      "Code Truth token initialization failed; saved credentials were preserved.",
    );
    process.exitCode = 1;
  }
}
