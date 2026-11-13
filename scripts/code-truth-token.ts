import { pathToFileURL } from "node:url";
import { initializeServiceToken } from "../src/setup/service-token.ts";

export function initializeCodeTruthToken(path: string) {
  return initializeServiceToken(
    path,
    "Saved Code Truth service token is invalid",
  );
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
