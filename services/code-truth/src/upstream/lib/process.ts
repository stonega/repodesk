import { fileURLToPath } from "node:url";

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} exited with status ${exitCode}: ${stderr.slice(0, 500)}`);
    this.name = "CommandError";
  }
}

export type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: Record<string, string | undefined>;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options?: RunCommandOptions,
  ): Promise<CommandResult>;
}

type WorkerResponse =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; message: string };

/**
 * CodeGraph's bundled Node process flushes piped output reliably through a
 * synchronous spawn. Run that synchronous boundary in a short-lived helper so
 * indexing and queries never block the HTTP event loop.
 */
export class BunProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: string[],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    const helperPath = fileURLToPath(
      new URL("./process-helper.ts", import.meta.url),
    );
    const helper = Bun.spawn([process.execPath, helperPath], {
      env: {
        ...process.env,
        DEEPX_PROCESS_REQUEST: Buffer.from(
          JSON.stringify({ command, args, options }),
          "utf8",
        ).toString("base64"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(
      () => helper.kill("SIGKILL"),
      (options.timeoutMs ?? 60_000) + 5_000,
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      helper.exited,
      new Response(helper.stdout).text(),
      new Response(helper.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    if (exitCode !== 0) {
      throw new Error(`Process helper failed: ${stderr.slice(0, 500)}`);
    }
    const result = JSON.parse(stdout) as WorkerResponse;

    if (!result.ok) throw new Error(result.message);
    if (result.exitCode !== 0) {
      throw new CommandError(
        formatCommand(command, args),
        result.exitCode,
        redact(result.stderr.trim()),
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(redact).join(" ");
}

function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[credentials]@")
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, "$1[credentials]");
}
