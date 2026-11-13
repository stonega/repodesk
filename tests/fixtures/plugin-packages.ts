import { zipSync } from "fflate";
import {
  loadLocalPackage,
  type PackageFiles,
} from "../../src/plugins/local-package.ts";
import type { PluginManifest } from "../../src/plugins/manifest.ts";

/** Real package bytes and GitHub-shaped responses, with no upstream network. */
export async function pluginRepository(name = "word-count") {
  const pkg = await loadLocalPackage(`examples/plugins/${name}`);
  const repository = pkg.manifest.repository.slice(
    "https://github.com/".length,
  );
  const versions = new Map<string, PackageFiles>();
  const tags = new Map<string, string>();
  const calls: { url: string; authorization: string | null }[] = [];
  const state = {
    id: name === "word-count" ? 777 : 778,
    ownerId: 42,
    private: false,
    repository,
    redirectOrigin: "https://codeload.github.com",
  };
  function add(
    version: string,
    manifestPatch: Partial<PluginManifest> = {},
    bundle?: string,
  ) {
    const commit = (versions.size + 1).toString(16).padStart(40, "0");
    const manifest = {
      ...structuredClone(pkg.manifest),
      version,
      ...manifestPatch,
    };
    const files: PackageFiles = {
      ...pkg.files,
      "repodesk.plugin.json": Buffer.from(JSON.stringify(manifest)),
      "package.json": Buffer.from(
        JSON.stringify({ name, version, type: "module" }),
      ),
    };
    if (bundle) files[manifest.runtime.entry] = Buffer.from(bundle);
    versions.set(commit, files);
    tags.set(`v${version}`, commit);
    return commit;
  }
  const commit = add(pkg.manifest.version);
  const zip = (sha = commit) =>
    Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(versions.get(sha) ?? {}).map(([path, data]) => [
            `repository-${sha.slice(0, 7)}/${path}`,
            data,
          ]),
        ),
      ),
    );
  const transport = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({
      url: url.href,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const prefix = `/repos/${state.repository}`;
    if (url.origin === "https://codeload.github.com") {
      const sha = url.pathname.split("/").at(-1) ?? "";
      return new Response(zip(sha));
    }
    if (url.pathname === prefix)
      return Response.json({
        id: state.id,
        owner: { id: state.ownerId },
        full_name: state.repository,
        private: state.private,
      });
    if (url.pathname === `${prefix}/tags`)
      return Response.json([...tags.keys()].map((tag) => ({ name: tag })));
    if (url.pathname.startsWith(`${prefix}/commits/`)) {
      const ref = decodeURIComponent(
        url.pathname.slice(`${prefix}/commits/`.length),
      );
      const sha = tags.get(ref) ?? (versions.has(ref) ? ref : undefined);
      return sha ? Response.json({ sha }) : new Response(null, { status: 404 });
    }
    if (url.pathname === `${prefix}/contents/repodesk.plugin.json`) {
      const file = versions.get(url.searchParams.get("ref") ?? "")?.[
        "repodesk.plugin.json"
      ];
      return file
        ? Response.json({
            encoding: "base64",
            content: file.toString("base64"),
            size: file.length,
          })
        : new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith(`${prefix}/zipball/`)) {
      const sha = url.pathname.split("/").at(-1);
      return new Response(null, {
        status: 302,
        headers: {
          location: `${state.redirectOrigin}/${state.repository}/legacy.zip/${sha}`,
        },
      });
    }
    throw new Error("Unexpected fixture endpoint");
  }) as typeof fetch;
  return {
    ...pkg,
    repository,
    state,
    versions,
    tags,
    commit,
    calls,
    zip,
    transport,
    add,
  };
}
