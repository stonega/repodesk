import { readFileSync } from "node:fs";

// The build copies this asset beside each bundled backend entrypoint.
export const assistantSoul = readFileSync(
  new URL("./SOUL.md", import.meta.url),
  "utf8",
).trim();
