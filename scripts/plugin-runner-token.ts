import { chmodSync, chownSync, mkdirSync } from "node:fs";
import { initializeServiceToken } from "../src/setup/service-token.ts";

try {
  mkdirSync("/var/lib/telo-plugins", { recursive: true, mode: 0o700 });
  chownSync("/var/lib/telo-plugins", 1000, 1000);
  chmodSync("/var/lib/telo-plugins", 0o700);
  initializeServiceToken(process.argv[2] ?? "/run/plugin-runner/token");
} catch {
  console.error(
    "Plugin runner token initialization failed; saved credentials were preserved.",
  );
  process.exitCode = 1;
}
