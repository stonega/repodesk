import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { jobCommand } from "./job-command.ts";

export const envVolumePattern = /^telo-codex-env-[a-f0-9]{24}-[1-9]\d{0,18}$/;
export const envVolumePrefixPattern =
  /^telo-codex-env-[a-f0-9]{24}-(?:[1-9]\d{0,18})?$/;
export const envMountModes = ["setup", "implement", "check"] as const;

const allowedTools = new Set([
  "node",
  "bun",
  "pnpm",
  "yarn",
  "python",
  "uv",
  "go",
  "rust",
  "ruby",
  "java",
  "deno",
]);
const safeVersion = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const packageManagerSpec =
  /^(pnpm|yarn|bun)@([0-9]+(?:\.[0-9]+){0,2})(?:\+.*)?$/;

export function workspaceEnvPrefix(workspaceId: string) {
  z.uuid().parse(workspaceId);
  return `telo-codex-env-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}-`;
}

export function environmentVolumeKey(
  workspaceId: string,
  repositoryId: number,
) {
  z.number().int().positive().safe().parse(repositoryId);
  return `${workspaceEnvPrefix(workspaceId)}${repositoryId}`;
}

export function parseEnvironmentVolume(workspaceId: string, name: string) {
  const prefix = workspaceEnvPrefix(workspaceId);
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!/^[1-9]\d{0,18}$/.test(suffix)) return undefined;
  const repositoryId = Number(suffix);
  return Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? repositoryId
    : undefined;
}

const envDirectories = [
  "mise",
  "mise-config",
  "mise-state",
  "bin",
  "uv-python",
  "rustup",
  "cargo",
  "go",
  "playwright",
  "cache",
  "cache/mise",
  "cache/bun",
  "cache/pnpm",
  "cache/npm",
  "cache/yarn",
  "cache/corepack",
  "cache/uv",
  "cache/pip",
  "cache/gomod",
  "cache/gocache",
  "cache/xdg",
] as const;

export function persistentEnv(
  envRoot: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const pathEntries = [
    join(envRoot, "mise", "shims"),
    join(envRoot, "bin"),
    join(envRoot, "cargo", "bin"),
    join(envRoot, "go", "bin"),
    join(envRoot, "uv-python", "bin"),
  ];
  const basePath =
    baseEnv.PATH ??
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return {
    ...baseEnv,
    PATH: `${pathEntries.join(":")}:${basePath}`,
    TELO_ENV_DIR: envRoot,
    MISE_DATA_DIR: join(envRoot, "mise"),
    MISE_CACHE_DIR: join(envRoot, "cache", "mise"),
    MISE_CONFIG_DIR: join(envRoot, "mise-config"),
    MISE_STATE_DIR: join(envRoot, "mise-state"),
    MISE_YES: "1",
    // Only trust the runner-owned /env config; never execute untrusted repo hooks in setup.
    MISE_TRUSTED_CONFIG_PATHS: envRoot,
    BUN_INSTALL_CACHE_DIR: join(envRoot, "cache", "bun"),
    PNPM_STORE_DIR: join(envRoot, "cache", "pnpm"),
    NPM_CONFIG_CACHE: join(envRoot, "cache", "npm"),
    YARN_CACHE_FOLDER: join(envRoot, "cache", "yarn"),
    COREPACK_HOME: join(envRoot, "cache", "corepack"),
    UV_CACHE_DIR: join(envRoot, "cache", "uv"),
    UV_PYTHON_INSTALL_DIR: join(envRoot, "uv-python"),
    PIP_CACHE_DIR: join(envRoot, "cache", "pip"),
    RUSTUP_HOME: join(envRoot, "rustup"),
    CARGO_HOME: join(envRoot, "cargo"),
    GOPATH: join(envRoot, "go"),
    GOMODCACHE: join(envRoot, "cache", "gomod"),
    GOCACHE: join(envRoot, "cache", "gocache"),
    PLAYWRIGHT_BROWSERS_PATH: join(envRoot, "playwright"),
    XDG_CACHE_HOME: join(envRoot, "cache", "xdg"),
  };
}

export async function ensurePersistentEnvDirs(envRoot: string) {
  await mkdir(envRoot, { recursive: true });
  for (const dir of envDirectories)
    await mkdir(join(envRoot, dir), { recursive: true });
}

async function readOptionalText(path: string, maxBytes = 64 * 1024) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return await file.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

async function fileExists(path: string) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeVersion(raw: string) {
  const cleaned = raw.trim().replace(/^v(?=\d)/, "");
  if (!safeVersion.test(cleaned) || cleaned.includes("..")) return undefined;
  return cleaned;
}

function recordTool(
  tools: Map<string, string>,
  name: string,
  version?: string,
) {
  const tool = name === "nodejs" ? "node" : name === "golang" ? "go" : name;
  if (!allowedTools.has(tool) || tools.has(tool)) return;
  if (version === undefined) {
    tools.set(tool, tool);
    return;
  }
  const normalized = normalizeVersion(version);
  if (normalized) tools.set(tool, `${tool}@${normalized}`);
}

function parseMiseTools(content: string, tools: Map<string, string>) {
  let inTools = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) continue;
    const match = line.match(/^([a-z0-9_-]+)\s*=\s*["']([^"']+)["']$/);
    if (match?.[1] && match[2]) recordTool(tools, match[1], match[2]);
  }
}

/** Deterministically inspect repository manifests for allowlisted user-space runtimes. */
export async function detectProjectTools(repoDir: string) {
  const tools = new Map<string, string>();

  const toolVersions = await readOptionalText(join(repoDir, ".tool-versions"));
  if (toolVersions) {
    for (const rawLine of toolVersions.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const [name, version] = line.split(/\s+/);
      if (name && version) recordTool(tools, name, version);
    }
  }

  for (const miseFile of [".mise.toml", "mise.toml"]) {
    const content = await readOptionalText(join(repoDir, miseFile));
    if (content) parseMiseTools(content, tools);
  }

  for (const [file, tool] of [
    [".node-version", "node"],
    [".nvmrc", "node"],
    [".python-version", "python"],
    [".go-version", "go"],
    [".ruby-version", "ruby"],
    [".java-version", "java"],
  ] as const) {
    const content = await readOptionalText(join(repoDir, file), 256);
    const first = content
      ?.split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .find(Boolean);
    if (first) recordTool(tools, tool, first);
  }

  const rustToml = await readOptionalText(join(repoDir, "rust-toolchain.toml"));
  if (rustToml) {
    const match = rustToml.match(/^\s*channel\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) recordTool(tools, "rust", match[1]);
  } else {
    const rustPlain = await readOptionalText(
      join(repoDir, "rust-toolchain"),
      256,
    );
    const first = rustPlain?.trim().split(/\r?\n/)[0]?.trim();
    if (first) recordTool(tools, "rust", first);
  }

  const pkgText = await readOptionalText(join(repoDir, "package.json"));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { packageManager?: unknown };
      if (typeof pkg.packageManager === "string") {
        const match = pkg.packageManager.trim().match(packageManagerSpec);
        if (match?.[1] && match[2]) recordTool(tools, match[1], match[2]);
      }
    } catch {
      /* Ignore malformed package.json during heuristic detection. */
    }
  }

  const goMod = await readOptionalText(join(repoDir, "go.mod"));
  if (goMod) {
    const match = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m);
    if (match?.[1]) recordTool(tools, "go", match[1]);
  }

  if (await fileExists(join(repoDir, "pnpm-lock.yaml")))
    recordTool(tools, "pnpm");
  if (await fileExists(join(repoDir, "yarn.lock"))) recordTool(tools, "yarn");
  if (
    (await fileExists(join(repoDir, "pyproject.toml"))) ||
    (await fileExists(join(repoDir, "uv.lock"))) ||
    (await fileExists(join(repoDir, "requirements.txt")))
  )
    recordTool(tools, "python", "3.12");
  if (await fileExists(join(repoDir, "Cargo.toml")))
    recordTool(tools, "rust", "stable");

  return [...tools.values()];
}

export async function withEnvLock<T>(
  envRoot: string,
  action: () => Promise<T>,
  waitSeconds = 300,
): Promise<T> {
  const lockPath = join(envRoot, ".setup.lock");
  const file = await open(lockPath, "a", 0o600);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("flock", ["-w", String(waitSeconds), "3"], {
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (status !== 0) throw new Error("coding_environment_lock_failed");
    return await action();
  } finally {
    await file.close();
  }
}

export interface EnvironmentSetupReport {
  tools: string[];
  installed: string[];
  failed: string[];
  miseAvailable: boolean;
}

export async function preparePersistentEnvironment(
  repoDir: string,
  envRoot: string,
  env: NodeJS.ProcessEnv,
  run: (
    binary: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; stderr?: boolean },
  ) => Promise<string> = jobCommand,
): Promise<EnvironmentSetupReport> {
  await ensurePersistentEnvDirs(envRoot);
  const tools = await detectProjectTools(repoDir);
  if (!tools.length)
    return { tools: [], installed: [], failed: [], miseAvailable: true };

  try {
    await run("mise", ["--version"], { cwd: repoDir, env });
  } catch {
    return { tools, installed: [], failed: [], miseAvailable: false };
  }

  const installed: string[] = [];
  const failed: string[] = [];
  await withEnvLock(envRoot, async () => {
    for (const spec of tools) {
      try {
        await run("mise", ["use", "--global", spec], {
          cwd: envRoot,
          env,
          stderr: true,
        });
        installed.push(spec);
      } catch {
        failed.push(spec);
      }
    }
  });
  return { tools, installed, failed, miseAvailable: true };
}

export async function readEnvironmentReport(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as EnvironmentSetupReport;
  } catch {
    return undefined;
  }
}
