import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import { createLocalService } from "./service.ts";
import { OctokitGitHubRepositorySource } from "./upstream/codegraph/github-repository-source.ts";
import { CodeGraphRunner } from "./upstream/codegraph/runner.ts";
import { BunProcessRunner } from "./upstream/lib/process.ts";

const env = z
  .object({
    CODE_TRUTH_TOKEN: z.string().min(32),
    DATA_DIR: z.string().default("./data"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3010),
    GITHUB_TOKEN: z.string().optional(),
  })
  .parse({
    ...process.env,
    CODE_TRUTH_TOKEN: process.env.CODE_TRUTH_TOKEN_FILE
      ? readFileSync(process.env.CODE_TRUTH_TOKEN_FILE, "utf8").trim()
      : process.env.CODE_TRUTH_TOKEN,
  });
const binary = createRequire(import.meta.url).resolve(
  `@colbymchenry/codegraph-${process.platform}-${process.arch}/bin/codegraph`,
);
const service = createLocalService({
  token: env.CODE_TRUTH_TOKEN,
  dataDir: env.DATA_DIR,
  codegraph: new CodeGraphRunner(binary, new BunProcessRunner()),
  repositorySourceFor: (getToken) => ({
    resolveBranch: (repository, branch) =>
      new OctokitGitHubRepositorySource({ token: getToken() }).resolveBranch(
        repository,
        branch,
      ),
    downloadArchive: (repository, commit) =>
      new OctokitGitHubRepositorySource({ token: getToken() }).downloadArchive(
        repository,
        commit,
      ),
  }),
  repositorySource: new OctokitGitHubRepositorySource({
    token: env.GITHUB_TOKEN,
  }),
});
const server = service.app.listen(env.PORT, env.HOST, () =>
  console.info("code_truth_started"),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void service.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
