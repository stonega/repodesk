// Read-only operational probe: isolated login home, no account cache or raw CLI output.
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.CODEX_RUNNER_STATE ?? "/var/lib/deepx-codex";
const home = await mkdtemp(join(root, "login-probe-"));
const started = Date.now();
let child;
let timer;
function stop(signal) {
  if (child?.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child?.kill(signal);
}
try {
  await writeFile(
    join(home, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
    { mode: 0o600 },
  );
  child = spawn("codex", ["login", "--device-auth"], {
    env: { PATH: process.env.PATH, HOME: "/tmp", CODEX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  let instructions = false;
  let spawned = true;
  const collect = (chunk) => {
    output = (output + chunk.toString())
      .slice(-8192)
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    instructions =
      /https:\/\/auth\.openai\.com\/codex\/device/.test(output) &&
      /Enter this one-time code[\s\S]*?\n\s*([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)/.test(
        output,
      );
    if (instructions) stop("SIGTERM");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise((resolve) => {
    child.once("error", () => {
      spawned = false;
      resolve({});
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => stop("SIGKILL"), 30000);
  const result = await closed;
  const status = output.match(
    /device code request failed with status\s+(\d{3})/i,
  )?.[1];
  const summary = {
    systemCaBundlePresent:
      (
        await stat("/etc/ssl/certs/ca-certificates.crt").catch(() => ({
          size: 0,
        }))
      ).size > 0,
    cliStarted: spawned,
    instructionsParsed: instructions,
    authUrlPrinted: output.includes("https://auth.openai.com/codex/device"),
    codePromptPrinted: output.includes("Enter this one-time code"),
    requestStatus: status ? Number(status) : undefined,
    networkError:
      /error sending request|dns error|certificate|connect error/i.test(output),
    deviceLoginDisabled: /device code login is not enabled/i.test(output),
    exitCode: result.code,
    signal: result.signal,
    elapsedMs: Date.now() - started,
  };
  try {
    const response = await fetch(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      { redirect: "error", signal: AbortSignal.timeout(10000) },
    );
    summary.authEndpointStatus = response.status;
    await response.body?.cancel();
  } catch (error) {
    const code = error.cause?.code;
    summary.authEndpointNetworkError = [
      "ENOTFOUND",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
      ? code
      : "network_error";
  }
  console.log(JSON.stringify(summary));
} finally {
  clearTimeout(timer);
  stop("SIGKILL");
  await rm(home, { recursive: true, force: true });
}
