import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCommandOptions } from "./process.ts";

type HelperRequest = {
  command: string;
  args: string[];
  options: RunCommandOptions;
};

try {
  const encodedRequest = process.env.DEEPX_PROCESS_REQUEST;
  if (!encodedRequest) throw new Error("Missing process request");
  delete process.env.DEEPX_PROCESS_REQUEST;
  const input = JSON.parse(
    Buffer.from(encodedRequest, "base64").toString("utf8"),
  ) as HelperRequest;
  const outputDirectory = mkdtempSync(join(tmpdir(), "deepx-process-output-"));
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  const stdoutDescriptor = openSync(stdoutPath, "w", 0o600);
  const stderrDescriptor = openSync(stderrPath, "w", 0o600);
  try {
    const result = Bun.spawnSync({
      cmd: [input.command, ...input.args],
      ...(input.options.cwd ? { cwd: input.options.cwd } : {}),
      env: { ...process.env, ...input.options.environment },
      stdin: "ignore",
      stdout: stdoutDescriptor,
      stderr: stderrDescriptor,
      timeout: input.options.timeoutMs ?? 60_000,
      killSignal: "SIGKILL",
    });
    closeSync(stdoutDescriptor);
    closeSync(stderrDescriptor);
    const maxOutputBytes = input.options.maxOutputBytes ?? 2_000_000;
    if (
      statSync(stdoutPath).size > maxOutputBytes ||
      statSync(stderrPath).size > maxOutputBytes
    ) {
      throw new Error(`Command output exceeded ${maxOutputBytes} bytes`);
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        exitCode: result.exitCode,
        stdout: readFileSync(stdoutPath, "utf8"),
        stderr: readFileSync(stderrPath, "utf8"),
      }),
    );
  } finally {
    try {
      closeSync(stdoutDescriptor);
    } catch {}
    try {
      closeSync(stderrDescriptor);
    } catch {}
    rmSync(outputDirectory, { recursive: true, force: true });
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
