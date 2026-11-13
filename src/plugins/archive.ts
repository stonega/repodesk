import { inflateRawSync } from "node:zlib";
import { limits, PluginError } from "./contract.ts";
import type { PackageFiles } from "./local-package.ts";
import { safeResourcePath } from "./manifest.ts";

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bound both declared sizes and actual inflation; headers alone are untrusted. */
export function unpackGitHubZip(bytes: Buffer): PackageFiles {
  try {
    if (bytes.length < 22 || bytes.length > limits.archive) throw new Error();
    let end = bytes.length - 22;
    while (
      end >= Math.max(0, bytes.length - 65557) &&
      bytes.readUInt32LE(end) !== 0x06054b50
    )
      end--;
    if (
      end < 0 ||
      bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    )
      throw new Error();
    const count = bytes.readUInt16LE(end + 10);
    const start = bytes.readUInt32LE(end + 16);
    if (
      bytes.readUInt16LE(end + 4) ||
      bytes.readUInt16LE(end + 6) ||
      bytes.readUInt16LE(end + 8) !== count ||
      !count ||
      count > limits.files ||
      start + bytes.readUInt32LE(end + 12) !== end
    )
      throw new Error();
    let offset = start;
    let total = 0;
    let root: string | undefined;
    const entries = new Map<
      string,
      {
        path: string;
        size: number;
        crc: number;
        directory: boolean;
        dataStart: number;
        compressed: number;
        compression: number;
      }
    >();
    const ranges: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
        throw new Error();
      const flags = bytes.readUInt16LE(offset + 8);
      const compression = bytes.readUInt16LE(offset + 10);
      const compressed = bytes.readUInt32LE(offset + 20);
      const size = bytes.readUInt32LE(offset + 24);
      const length = bytes.readUInt16LE(offset + 28);
      const extra = bytes.readUInt16LE(offset + 30);
      const comment = bytes.readUInt16LE(offset + 32);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      const local = bytes.readUInt32LE(offset + 42);
      const next = offset + 46 + length + extra + comment;
      if (
        next > end ||
        flags & 1 ||
        ![0, 8].includes(compression) ||
        size === 0xffffffff ||
        compressed === 0xffffffff ||
        bytes.readUInt16LE(offset + 34) !== 0
      )
        throw new Error();
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + length),
      );
      const directory = name.endsWith("/");
      const normalized = directory ? name.slice(0, -1) : name;
      if (
        !safeResourcePath(normalized) ||
        normalized.split("/").length > 12 ||
        entries.has(name)
      )
        throw new Error();
      const components = normalized.split("/");
      root ??= components[0];
      if (components[0] !== root || (!directory && components.length < 2))
        throw new Error();
      const path = components.slice(1).join("/");
      if (
        [".git", ".gitmodules", "node_modules"].some((part) =>
          components.includes(part),
        ) ||
        components.some((part) => part === ".env" || part.startsWith(".env."))
      )
        throw new Error();
      const kind = mode & 0xf000;
      if (
        (kind && kind !== (directory ? 0x4000 : 0x8000)) ||
        (!directory && mode & 0o111) ||
        (directory && size !== 0)
      )
        throw new Error();
      if (
        local + 30 > start ||
        bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== compression
      )
        throw new Error();
      const localNameLength = bytes.readUInt16LE(local + 26);
      const dataStart =
        local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
      if (
        dataStart + compressed > start ||
        bytes
          .subarray(local + 30, local + 30 + localNameLength)
          .toString("utf8") !== name
      )
        throw new Error();
      ranges.push([local, dataStart + compressed]);
      total += size;
      if (total > limits.package) throw new Error();
      entries.set(name, {
        path,
        size,
        crc: bytes.readUInt32LE(offset + 16),
        directory,
        dataStart,
        compressed,
        compression,
      });
      offset = next;
    }
    if (offset !== end) throw new Error();
    ranges.sort((a, b) => a[0] - b[0]);
    if (
      ranges.some((range, i) => i > 0 && range[0] < (ranges[i - 1]?.[1] ?? 0))
    )
      throw new Error();
    const files: PackageFiles = Object.create(null);
    for (const entry of entries.values()) {
      if (entry.directory) continue;
      const compressed = bytes.subarray(
        entry.dataStart,
        entry.dataStart + entry.compressed,
      );
      const content =
        entry.compression === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(1, entry.size),
            });
      if (
        !content ||
        content.length !== entry.size ||
        crc32(content) !== entry.crc ||
        Object.hasOwn(files, entry.path)
      )
        throw new Error();
      files[entry.path] = Buffer.from(content);
    }
    return files;
  } catch {
    throw new PluginError("plugin_package_invalid");
  }
}
