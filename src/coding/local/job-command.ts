import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function jobCommand(
  binary: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stderr?: boolean;
    input?: string;
    line?: (line: string) => void;
  },
  launch = spawn,
) {
  return new Promise<string>((resolve, reject) => {
    const child = launch(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", options.stderr ? "pipe" : "ignore"],
    });
    if (!child.stdout || !child.stdin) {
      child.kill("SIGKILL");
      reject(new Error("coding_command_failed"));
      return;
    }
    let output = "";
    let diagnostics = "";
    // Pipe chunks can split a UTF-8 character. Decode across chunks so patches
    // and diagnostics preserve the exact text emitted by the command.
    child.stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-12000);
    });
    let overflow = false;
    if (options.line)
      createInterface({ input: child.stdout }).on("line", options.line);
    else
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 6 * 1024 * 1024) {
          overflow = true;
          child.kill("SIGKILL");
        }
      });
    child.on("error", () => reject(new Error("coding_command_failed")));
    child.on("close", (code) =>
      code === 0 && !overflow
        ? resolve(output)
        : reject(
            Object.assign(new Error("coding_command_failed"), {
              diagnostics: (output.slice(-12000) + diagnostics).slice(-12000),
            }),
          ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
