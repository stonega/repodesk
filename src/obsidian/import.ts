import { unzipSync } from "fflate";
import { vaultLimits, vaultPath } from "./config.ts";

/** Browser-side ZIP extraction is bounded before allocation; server validates again. */
export function importArchive(data: Uint8Array) {
  if (data.byteLength > vaultLimits.totalBytes)
    throw new Error("ZIP must be at most 5 MB.");
  let bytes = 0;
  const paths = new Set<string>();
  const skipped: string[] = [];
  const files = unzipSync(data, {
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      if (
        !/\.(md|canvas|base)$/.test(file.name) ||
        file.name.split("/").some((p) => p.startsWith("."))
      ) {
        skipped.push(file.name);
        return false;
      }
      vaultPath.parse(file.name);
      const path = file.name.toLowerCase();
      if (paths.has(path)) throw new Error("The ZIP contains duplicate paths.");
      paths.add(path);
      bytes += file.originalSize;
      if (
        paths.size > vaultLimits.files ||
        bytes > vaultLimits.totalBytes ||
        file.originalSize > vaultLimits.fileBytes
      )
        throw new Error(
          "Vault limits exceeded: 500 files, 100 KB per file, 5 MB total.",
        );
      return true;
    },
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    files: Object.entries(files).map(([path, content]) => ({
      path,
      content: decoder.decode(content),
    })),
    skipped,
  };
}
