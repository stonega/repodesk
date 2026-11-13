import { z } from "zod";
import { unpackGitHubZip } from "./archive.ts";
import { limits, PluginError } from "./contract.ts";
import { type PackageFiles, validatePackageFiles } from "./local-package.ts";
import { parseManifest } from "./manifest.ts";
import { selectPackageFiles } from "./package-skills.ts";

export interface PackageSource {
  repositoryId: number;
  ownerId: number;
  repository: string;
  ref: string;
  commit: string;
  private: boolean;
}
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  private: z.boolean(),
  owner: z.object({ id: z.number().int().positive().safe() }),
});
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
export function parseRepositoryUrl(value: string): string {
  try {
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(
        value,
      )
    )
      throw new Error();
    const url = new URL(value);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)
    )
      throw new Error();
    const name = url.pathname
      .slice(1)
      .replace(/\/$/, "")
      .replace(/\.git$/, "");
    if (name.split("/").some((part) => [".", "..", ""].includes(part)))
      throw new Error();
    return name;
  } catch {
    throw new PluginError("plugin_package_invalid");
  }
}
export async function boundedBody(
  response: Response,
  cap: number,
): Promise<Buffer> {
  if (
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > cap
  )
    throw new PluginError("plugin_package_invalid");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > cap) throw new PluginError("plugin_package_invalid");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function compareTags(left: string, right: string) {
  const a = left.slice(1).split(".").map(BigInt);
  const b = right.slice(1).split(".").map(BigInt);
  for (let i = 0; i < 3; i++)
    if (a[i] !== b[i]) return (a[i] as bigint) > (b[i] as bigint) ? -1 : 1;
  return 0;
}

/** Fixed GitHub API endpoints; credentials never follow an archive redirect. */
export class GitHubPluginSource {
  constructor(private transport: typeof fetch = fetch) {}
  private async api(
    repository: string,
    path: string,
    token: string | undefined,
    signal: AbortSignal,
    cap: number = limits.manifest,
  ) {
    const response = await this.transport(
      `https://api.github.com/repos/${repository}${path}`,
      {
        redirect: "manual",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) throw new PluginError("plugin_package_invalid");
    return JSON.parse(
      (await boundedBody(response, cap)).toString("utf8"),
    ) as unknown;
  }
  private async ref(
    repository: string,
    ref: string,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    if (
      !/^[a-f0-9]{40}$/.test(ref) &&
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
        ref,
      )
    )
      throw new PluginError("plugin_package_invalid");
    return commitSchema.parse(
      await this.api(
        repository,
        `/commits/${encodeURIComponent(ref)}`,
        token,
        signal,
      ),
    ).sha;
  }
  async identity(url: string, token: string | undefined, signal: AbortSignal) {
    const repository = parseRepositoryUrl(url);
    return repositorySchema.parse(
      await this.api(repository, "", token, signal),
    );
  }
  async recheck(
    source: PackageSource,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    const current = await this.identity(
      `https://github.com/${source.repository}`,
      token,
      signal,
    );
    if (
      current.id !== source.repositoryId ||
      current.owner.id !== source.ownerId ||
      (await this.ref(current.full_name, source.ref, token, signal)) !==
        source.commit
    )
      throw new PluginError("plugin_package_invalid");
  }
  async inspect(
    url: string,
    selectedRef: string | undefined,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    try {
      const repo = await this.identity(url, token, signal);
      const repository = repo.full_name;
      let ref = selectedRef;
      if (!ref) {
        const tags = z
          .array(z.object({ name: z.string().max(100) }))
          .max(100)
          .parse(
            await this.api(repository, "/tags?per_page=100", token, signal),
          );
        if (tags.length === 100)
          throw new PluginError("plugin_package_invalid");
        const stable = tags
          .map((tag) => tag.name)
          .filter((name) =>
            /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(name),
          )
          .sort(compareTags)
          .slice(0, 20);
        for (const candidate of stable) {
          const commit = await this.ref(repository, candidate, token, signal);
          try {
            const file = z
              .object({
                encoding: z.literal("base64"),
                content: z.string().max(100000),
                size: z.number().int().max(limits.manifest),
              })
              .parse(
                await this.api(
                  repository,
                  `/contents/repodesk.plugin.json?ref=${commit}`,
                  token,
                  signal,
                  110000,
                ),
              );
            const manifest = parseManifest(
              JSON.parse(Buffer.from(file.content, "base64").toString("utf8")),
            );
            if (`v${manifest.version}` === candidate) {
              ref = candidate;
              break;
            }
          } catch (error) {
            if (signal.aborted) throw error;
          }
        }
      }
      if (!ref) throw new PluginError("plugin_package_invalid");
      const commit = await this.ref(repository, ref, token, signal);
      const response = await this.transport(
        `https://api.github.com/repos/${repository}/zipball/${commit}`,
        {
          redirect: "manual",
          signal,
          headers: {
            accept: "application/vnd.github+json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (response.status !== 302)
        throw new PluginError("plugin_package_invalid");
      const destination = new URL(response.headers.get("location") ?? "");
      if (
        destination.origin !== "https://codeload.github.com" ||
        destination.username ||
        destination.password ||
        destination.hash
      )
        throw new PluginError("plugin_package_invalid");
      if (
        ![
          `/${repository}/legacy.zip/${commit}`,
          `/${repository}/zip/${commit}`,
        ].some(
          (path) => path.toLowerCase() === destination.pathname.toLowerCase(),
        )
      )
        throw new PluginError("plugin_package_invalid");
      const archive = await this.transport(destination.href, {
        redirect: "manual",
        signal,
      });
      if (!archive.ok || archive.status !== 200)
        throw new PluginError("plugin_package_invalid");
      const rawFiles: PackageFiles = unpackGitHubZip(
        await boundedBody(archive, limits.archive),
      );
      const rawManifest = rawFiles["repodesk.plugin.json"];
      if (!rawManifest || rawManifest.length > limits.manifest)
        throw new PluginError("plugin_manifest_invalid");
      const files = selectPackageFiles(
        parseManifest(JSON.parse(rawManifest.toString("utf8"))),
        rawFiles,
      );
      const pkg = validatePackageFiles(files);
      if (
        pkg.manifest.repository.toLowerCase() !==
          `https://github.com/${repository}`.toLowerCase() ||
        (ref.startsWith("v") && ref !== `v${pkg.manifest.version}`)
      )
        throw new PluginError("plugin_package_invalid");
      return {
        ...pkg,
        files,
        source: {
          repositoryId: repo.id,
          ownerId: repo.owner.id,
          repository,
          ref,
          commit,
          private: repo.private,
        } satisfies PackageSource,
      };
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError("plugin_package_invalid");
    }
  }
}
