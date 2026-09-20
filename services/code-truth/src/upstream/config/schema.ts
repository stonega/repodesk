import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { z } from "zod";

const identifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be a lowercase identifier");

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("-"), "must not start with '-'")
  .refine((value) => !value.includes(".."), "must not contain '..'")
  .refine(
    (value) =>
      !containsControlOrSpace(value) &&
      !["~", "^", ":", "?", "*", "[", "\\"].some((character) =>
        value.includes(character),
      ),
    "contains invalid ref characters",
  )
  .refine(
    (value) => !value.endsWith("/") && !value.endsWith("."),
    "has an invalid ending",
  );

export const codeTargetSchema = z.object({
  id: identifierSchema,
  repositoryUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !value.startsWith("-"), "must not start with '-'")
    .refine(
      (value) => !hasUrlCredentials(value),
      "must not contain credentials",
    )
    .refine(
      (value) =>
        ![...value].some((character) => character.codePointAt(0) === 0),
      "contains control characters",
    )
    .refine(
      (value) => parseGitHubRepositoryUrl(value) !== undefined,
      "must be an HTTPS github.com repository URL",
    ),
  networks: z
    .record(identifierSchema, branchSchema)
    .refine(
      (networks) => Object.keys(networks).length > 0,
      "must contain at least one network",
    ),
});

export type CodeTargetConfig = z.infer<typeof codeTargetSchema>;

export type GitHubRepository = {
  owner: string;
  repo: string;
};

export function parseGitHubRepositoryUrl(
  value: string,
): GitHubRepository | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined;
  const owner = segments[0];
  const rawRepo = segments[1];
  if (!owner || !rawRepo) return undefined;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  const repositoryPartPattern =
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_.-])?$/;
  if (!repositoryPartPattern.test(owner) || !repositoryPartPattern.test(repo))
    return undefined;
  return { owner, repo };
}

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: integerFromEnvironment(1, 65_535).default(3000),
    PUBLIC_BASE_URL: z.string().url(),
    DATA_DIR: z.string().min(1).default("./data"),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_ALLOWED_ORG: z.string().min(1).max(100),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_OAUTH_URL: z.string().url().default("https://github.com"),
    TOKEN_ENCRYPTION_KEY: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: integerFromEnvironment(300, 86_400).default(
      28_800,
    ),
    REFRESH_TOKEN_TTL_SECONDS: integerFromEnvironment(
      3_600,
      31_536_000,
    ).default(2_592_000),
    ORG_RECHECK_SECONDS: integerFromEnvironment(30, 3_600).default(300),
    SYNC_INTERVAL_SECONDS: integerFromEnvironment(30, 86_400).default(300),
    SNAPSHOT_RETENTION: integerFromEnvironment(1, 20).default(2),
    CODEGRAPH_BINARY: z.string().min(1).default("auto"),
    CODE_TARGETS_FILE: z.string().min(1).optional(),
    CODE_TARGETS_JSON: z.string().min(1).optional(),
    GITHUB_TOKEN: emptyStringAsUndefined(
      z.string().min(1).max(4096).optional(),
    ),
  })
  .superRefine((environment, context) => {
    if (
      Boolean(environment.CODE_TARGETS_FILE) ===
      Boolean(environment.CODE_TARGETS_JSON)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "configure exactly one of CODE_TARGETS_FILE or CODE_TARGETS_JSON",
      });
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicBaseUrl: URL;
  mcpUrl: URL;
  dataDir: string;
  databasePath: string;
  github: {
    clientId: string;
    clientSecret: string;
    allowedOrg: string;
    apiUrl: URL;
    oauthUrl: URL;
    callbackUrl: URL;
  };
  tokenEncryptionKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  orgRecheckSeconds: number;
  syncIntervalSeconds: number;
  snapshotRetention: number;
  codegraphBinary: string;
  codeTargets: CodeTargetConfig[];
  githubToken?: string;
};

function parseTargets(value: string): CodeTargetConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Code targets configuration is not valid JSON: ${String(error)}`,
    );
  }

  const targets = z.array(codeTargetSchema).min(1).parse(parsed);
  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new Error(
        `Code targets configuration contains duplicate target '${target.id}'`,
      );
    }
    ids.add(target.id);
  }
  return targets;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  const raw = environmentSchema.parse(environment);
  const publicBaseUrl = new URL(raw.PUBLIC_BASE_URL);
  if (
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must be an origin without a path, query, or fragment",
    );
  }
  const localHost =
    publicBaseUrl.hostname === "localhost" ||
    publicBaseUrl.hostname === "127.0.0.1";
  if (raw.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }
  if (publicBaseUrl.protocol !== "https:" && !localHost) {
    throw new Error("PUBLIC_BASE_URL may use HTTP only for localhost");
  }

  const dataDir = resolve(raw.DATA_DIR);
  const codeTargets = loadTargets(raw.CODE_TARGETS_FILE, raw.CODE_TARGETS_JSON);
  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    publicBaseUrl,
    mcpUrl: new URL("/mcp", publicBaseUrl),
    dataDir,
    databasePath: resolve(dataDir, "auth.sqlite"),
    github: {
      clientId: raw.GITHUB_CLIENT_ID,
      clientSecret: raw.GITHUB_CLIENT_SECRET,
      allowedOrg: raw.GITHUB_ALLOWED_ORG,
      apiUrl: new URL(raw.GITHUB_API_URL),
      oauthUrl: new URL(raw.GITHUB_OAUTH_URL),
      callbackUrl: new URL("/oauth/github/callback", publicBaseUrl),
    },
    tokenEncryptionKey: raw.TOKEN_ENCRYPTION_KEY,
    accessTokenTtlSeconds: raw.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: raw.REFRESH_TOKEN_TTL_SECONDS,
    orgRecheckSeconds: raw.ORG_RECHECK_SECONDS,
    syncIntervalSeconds: raw.SYNC_INTERVAL_SECONDS,
    snapshotRetention: raw.SNAPSHOT_RETENTION,
    codegraphBinary: resolveCodeGraphBinary(raw.CODEGRAPH_BINARY),
    codeTargets,
    ...(raw.GITHUB_TOKEN ? { githubToken: raw.GITHUB_TOKEN } : {}),
  };
}

function loadTargets(
  file: string | undefined,
  inlineJson: string | undefined,
): CodeTargetConfig[] {
  if (file) {
    const path = resolve(file);
    try {
      return parseTargets(readFileSync(path, "utf8"));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Code targets configuration")
      ) {
        throw error;
      }
      throw new Error(
        `Unable to read code targets file '${path}': ${String(error)}`,
      );
    }
  }
  if (inlineJson) return parseTargets(inlineJson);
  throw new Error("Code targets configuration is missing");
}

function resolveCodeGraphBinary(configured: string): string {
  if (configured !== "auto")
    return configured.includes("/") ? resolve(configured) : configured;
  const packageName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
  const executable =
    process.platform === "win32" ? "bin/codegraph.cmd" : "bin/codegraph";
  try {
    return createRequire(import.meta.url).resolve(
      `${packageName}/${executable}`,
    );
  } catch {
    throw new Error(
      `Unable to resolve the bundled CodeGraph executable for ${process.platform}-${process.arch}; set CODEGRAPH_BINARY explicitly`,
    );
  }
}

function containsControlOrSpace(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
  });
}

function emptyStringAsUndefined<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T> {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}
