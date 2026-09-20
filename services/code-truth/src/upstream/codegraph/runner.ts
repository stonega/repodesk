import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProcessRunner } from "../lib/process.ts";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "route"
  | "component";

const MAX_CACHED_QUERIES = 128;

type NodeOptions =
  | { file?: string }
  | { file: string; offset: number; limit: number };

export class CodeGraphRunner {
  readonly #command: string;
  readonly #argumentPrefix: string[];
  readonly #queryCache = new Map<string, Promise<unknown>>();

  constructor(
    readonly binary: string,
    readonly processRunner: ProcessRunner,
  ) {
    const bundleRoot = resolve(dirname(binary), "..");
    const bundledNode = join(
      bundleRoot,
      process.platform === "win32" ? "node.exe" : "node",
    );
    const bundledEntry = join(bundleRoot, "lib", "dist", "bin", "codegraph.js");
    if (existsSync(bundledNode) && existsSync(bundledEntry)) {
      this.#command = bundledNode;
      this.#argumentPrefix = [
        "--liftoff-only",
        "--disable-warning=ExperimentalWarning",
        bundledEntry,
      ];
    } else {
      this.#command = binary;
      this.#argumentPrefix = [];
    }
  }

  async initialize(projectPath: string): Promise<void> {
    await this.#run(["init", "-i", projectPath], {
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 10_000_000,
      environment: { CODEGRAPH_TELEMETRY: "0" },
    });
    await this.closeProject(projectPath);
  }

  async search(
    projectPath: string,
    query: string,
    options: { limit: number; kind?: SymbolKind },
  ): Promise<unknown> {
    return this.#cached(projectPath, "search", [query, options], async () => {
      const args = [
        "query",
        "-p",
        projectPath,
        "-l",
        String(options.limit),
        "-j",
      ];
      if (options.kind) args.push("-k", options.kind);
      args.push(query);
      const result = await this.#run(args, { maxOutputBytes: 500_000 });
      return parseJsonOutput(result.stdout, "CodeGraph search");
    });
  }

  async context(
    projectPath: string,
    question: string,
    options: { maxFiles: number },
  ): Promise<string> {
    return this.#cached(
      projectPath,
      "context",
      [question, options],
      async () => {
        const result = await this.#run(
          [
            "explore",
            "-p",
            projectPath,
            "--max-files",
            String(options.maxFiles),
            question,
          ],
          { timeoutMs: 90_000, maxOutputBytes: 1_000_000 },
        );
        return requiredOutput(result.stdout, "CodeGraph returned no context");
      },
    );
  }

  async node(
    projectPath: string,
    symbol: string,
    options: { file?: string } = {},
  ): Promise<string> {
    return this.#node(projectPath, symbol, options);
  }

  async fileExcerpt(
    projectPath: string,
    file: string,
    options: { offset: number; limit: number },
  ): Promise<string> {
    return this.#node(projectPath, undefined, { file, ...options });
  }

  async files(
    projectPath: string,
    options: { filter?: string; pattern?: string; maxDepth: number },
  ): Promise<string> {
    return this.#cached(projectPath, "files", [options], async () => {
      const args = [
        "files",
        "-p",
        projectPath,
        "--format",
        "tree",
        "--max-depth",
        String(options.maxDepth),
      ];
      if (options.filter) args.push("--filter", options.filter);
      if (options.pattern) args.push("--pattern", options.pattern);
      const result = await this.#run(args, { maxOutputBytes: 250_000 });
      return requiredOutput(result.stdout, "CodeGraph returned no files");
    });
  }

  async closeProject(projectPath: string): Promise<void> {
    const prefix = `${projectPath}\u0000`;
    for (const key of this.#queryCache.keys()) {
      if (key.startsWith(prefix)) this.#queryCache.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    this.#queryCache.clear();
  }

  async #node(
    projectPath: string,
    symbol: string | undefined,
    options: NodeOptions,
  ): Promise<string> {
    return this.#cached(projectPath, "node", [symbol, options], async () => {
      const args = ["node", "-p", projectPath];
      if (options.file) args.push("--file", options.file);
      if ("offset" in options) args.push("--offset", String(options.offset));
      if ("limit" in options) args.push("--limit", String(options.limit));
      if (symbol) args.push(symbol);
      const result = await this.#run(args, { maxOutputBytes: 500_000 });
      return requiredOutput(result.stdout, "CodeGraph returned no source");
    });
  }

  #cached<T>(
    projectPath: string,
    operation: string,
    parameters: unknown[],
    load: () => Promise<T>,
  ): Promise<T> {
    const key = `${projectPath}\u0000${operation}\u0000${JSON.stringify(parameters)}`;
    const cached = this.#queryCache.get(key) as Promise<T> | undefined;
    if (cached) {
      this.#queryCache.delete(key);
      this.#queryCache.set(key, cached);
      return cached;
    }

    const pending = load();
    this.#queryCache.set(key, pending);
    while (this.#queryCache.size > MAX_CACHED_QUERIES) {
      const oldest = this.#queryCache.keys().next().value;
      if (oldest === undefined) break;
      this.#queryCache.delete(oldest);
    }
    void pending.catch(() => {
      if (this.#queryCache.get(key) === pending) this.#queryCache.delete(key);
    });
    return pending;
  }

  #run(
    args: string[],
    options?: Parameters<ProcessRunner["run"]>[2],
  ): ReturnType<ProcessRunner["run"]> {
    return this.processRunner.run(
      this.#command,
      [...this.#argumentPrefix, ...args],
      options,
    );
  }
}

function parseJsonOutput(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function requiredOutput(value: string, errorMessage: string): string {
  const output = value.trim();
  if (!output) throw new Error(errorMessage);
  return output;
}
