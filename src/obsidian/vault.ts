import { posix } from "node:path";
import { parseDocument } from "yaml";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import {
  type NoteSummary,
  type VaultFile,
  type VaultState,
  vaultLimits,
  vaultPath,
} from "./config.ts";

export function initialVault(): VaultState {
  const files = {
    "Home.md":
      "---\ntags: [organization]\naliases: [Org home]\n---\n# Organization notes\n\nShared organization knowledge. Do not store personal or confidential chat history here.\n\n- Daily notes live in the Daily/ folder\n- [[Templates/Meeting]] — meeting template\n- ![[Organization.base]]\n- [[Organization.canvas]]\n\n> [!tip] Connect your knowledge\n> Use `[[wikilinks]]`, `#tags`, properties, headings and task lists.\n",
    "Templates/Meeting.md":
      '---\ntags: [meeting]\ndate: "{{date}}"\nstatus: open\n---\n# {{title}}\n\n## Attendees\n\n## Notes\n\n## Decisions\n\n## Actions\n- [ ] Add an owner and next step\n',
    "Templates/Daily.md":
      '---\ntags: [daily]\ndate: "{{date}}"\n---\n# {{title}}\n\n## Updates\n\n## Decisions\n\n## Tasks\n- [ ] \n',
    "Organization.base":
      'filters:\n  not:\n    - file.inFolder("Templates")\nviews:\n  - type: table\n    name: Organization notes\n    order:\n      - file.name\n      - note.tags\n      - note.status\n      - file.mtime\n',
    "Organization.canvas": JSON.stringify(
      {
        nodes: [
          {
            id: "home",
            type: "file",
            file: "Home.md",
            x: 0,
            y: 0,
            width: 400,
            height: 300,
          },
        ],
        edges: [],
      },
      null,
      2,
    ),
  };
  return {
    revision: 0,
    receipts: [],
    files: Object.entries(files).map(([path, content]) => ({
      path,
      content,
      version: 1,
      updatedAt: "2026-10-22T00:00:00.000Z",
    })),
  };
}
export const vaultFor = (w: Workspace) => w.obsidian ?? initialVault();
export const obsidianEnabled = (w: Workspace) =>
  w.plugins?.obsidian?.enabled ?? true;
export const obsidianGeneration = (w: Workspace) =>
  w.plugins?.obsidian?.generation ?? 0;

function yamlObject(text: string): Record<string, unknown> {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    const value: unknown = doc.toJS({ maxAliasCount: 20 });
    requireThat(
      !doc.errors.length &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value),
      "obsidian_invalid_yaml",
      400,
    );
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Fault("obsidian_invalid_yaml", 400);
  }
}
function frontmatter(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return {
    properties: match ? (match[1]?.trim() ? yamlObject(match[1]) : {}) : {},
    body: match ? content.slice(match[0].length) : content,
  };
}
export function validateFile(file: { path: string; content: string }) {
  vaultPath.parse(file.path);
  requireThat(
    Buffer.byteLength(file.content, "utf8") <= vaultLimits.fileBytes &&
      !file.content.includes("\0"),
    "obsidian_file_too_large",
    400,
  );
  if (file.path.endsWith(".md")) frontmatter(file.content);
  if (file.path.endsWith(".base")) {
    const base = yamlObject(file.content);
    requireThat(
      Array.isArray(base.views) &&
        base.views.length > 0 &&
        base.views.every(
          (view) =>
            view &&
            typeof view === "object" &&
            typeof view.type === "string" &&
            typeof view.name === "string",
        ),
      "obsidian_invalid_base",
      400,
    );
  }
  if (file.path.endsWith(".canvas")) {
    let canvas: {
      nodes?: Record<string, unknown>[];
      edges?: Record<string, unknown>[];
    };
    try {
      canvas = JSON.parse(file.content);
    } catch {
      throw new Fault("obsidian_invalid_canvas", 400);
    }
    requireThat(
      canvas && Array.isArray(canvas.nodes) && Array.isArray(canvas.edges),
      "obsidian_invalid_canvas",
      400,
    );
    const ids = new Set<string>();
    for (const node of canvas.nodes) {
      requireThat(
        node &&
          typeof node.id === "string" &&
          !ids.has(node.id) &&
          ["text", "file", "link", "group"].includes(String(node.type)) &&
          [node.x, node.y, node.width, node.height].every(
            (n) => typeof n === "number" && Number.isFinite(n),
          ),
        "obsidian_invalid_canvas",
        400,
      );
      ids.add(node.id);
      if (node.type === "file") vaultPath.parse(node.file);
      if (node.type === "text")
        requireThat(
          typeof node.text === "string",
          "obsidian_invalid_canvas",
          400,
        );
      if (node.type === "link")
        requireThat(
          typeof node.url === "string" && /^https?:\/\//.test(node.url),
          "obsidian_invalid_canvas",
          400,
        );
    }
    const edges = new Set<string>();
    for (const edge of canvas.edges) {
      requireThat(
        edge &&
          typeof edge.id === "string" &&
          !edges.has(edge.id) &&
          ids.has(String(edge.fromNode)) &&
          ids.has(String(edge.toNode)),
        "obsidian_invalid_canvas",
        400,
      );
      edges.add(edge.id);
    }
  }
}
export function validateVault(vault: VaultState) {
  requireThat(
    vault.files.length <= vaultLimits.files &&
      vault.files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0) <=
        vaultLimits.totalBytes,
    "obsidian_vault_full",
    409,
  );
  const paths = new Set<string>();
  for (const file of vault.files) {
    validateFile(file);
    const path = file.path.toLocaleLowerCase("en-US");
    requireThat(!paths.has(path), "obsidian_path_exists", 409);
    paths.add(path);
  }
}
// Mask code and comments without changing offsets, so examples aren't graph edges.
function maskCode(text: string) {
  return text.replace(
    /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*(?:\n|$))|(`+)[^\n]*?\3|<!--[\s\S]*?-->/gm,
    (part) => part.replace(/[^\n]/g, " "),
  );
}
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((s): s is string => typeof s === "string")
      : [];
const stem = (path: string) => path.replace(/\.md$/, "");
export function resolveLink(
  target: string,
  from: string,
  files: VaultFile[],
  relativeFirst = false,
) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split("#")[0] ?? "");
  } catch {
    return undefined;
  }
  if (!decoded) return from;
  const active = files.filter((f) => !f.trashed);
  const matches = (path: string) =>
    active.find((f) => f.path === path || stem(f.path) === path)?.path;
  if (decoded.startsWith("."))
    return matches(posix.normalize(posix.join(posix.dirname(from), decoded)));
  if (relativeFirst) {
    const relative = matches(
      posix.normalize(posix.join(posix.dirname(from), decoded)),
    );
    if (relative) return relative;
  }
  const exact =
    matches(decoded) ?? matches(posix.join(posix.dirname(from), decoded));
  if (exact) return exact;
  const candidates = active.filter(
    (f) =>
      posix.basename(f.path) === decoded ||
      posix.basename(stem(f.path)) === decoded,
  );
  return candidates.length === 1 ? candidates[0]?.path : undefined;
}
function linkMatches(body: string) {
  const masked = maskCode(body);
  const result: {
    start: number;
    end: number;
    target: string;
    embed: boolean;
    wiki: boolean;
    suffix: string;
    prefix: string;
  }[] = [];
  for (const m of masked.matchAll(
    /!?\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\(([^\s)]+)\)/g,
  )) {
    const wiki = m[1] !== undefined;
    const target = wiki ? ((m[1] ?? "").split("|")[0] ?? "") : (m[2] ?? "");
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    result.push({
      start: m.index,
      end: m.index + m[0].length,
      target,
      embed: m[0].startsWith("!"),
      wiki,
      suffix:
        wiki && m[1]?.includes("|")
          ? `|${m[1].split("|").slice(1).join("|")}`
          : "",
      prefix: m[0].slice(0, m[0].indexOf("(") + 1),
    });
  }
  return result;
}
export function summarize(file: VaultFile, files: VaultFile[]): NoteSummary {
  const { properties, body } = file.path.endsWith(".md")
    ? frontmatter(file.content)
    : { properties: {}, body: "" };
  const masked = maskCode(body);
  const headings = [...masked.matchAll(/^\s{0,3}(#{1,6})\s+(.+)$/gm)].map(
    (m) => ({ level: m[1]?.length ?? 1, text: m[2] ?? "" }),
  );
  const tags = [
    ...new Set([
      ...strings(properties.tags),
      ...[...masked.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(
        (m) => m[1] ?? "",
      ),
    ]),
  ];
  const tasks = masked.split("\n").flatMap((line, index) => {
    const match = /^\s*[-*+] \[([ xX])\]\s*(.*)/.exec(line);
    return match
      ? [
          {
            line:
              index +
              1 +
              (file.content
                .slice(0, file.content.length - body.length)
                .match(/\n/g)?.length ?? 0),
            text: match[2] ?? "",
            done: match[1] !== " ",
          },
        ]
      : [];
  });
  let links = linkMatches(body).map(({ target, embed, wiki }) => ({
    target,
    embed,
    resolved: resolveLink(target, file.path, files, !wiki),
  }));
  if (file.path.endsWith(".canvas")) {
    const canvas = JSON.parse(file.content);
    links = canvas.nodes
      .filter((n: { type: string }) => n.type === "file")
      .map((n: { file: string }) => ({
        target: n.file,
        embed: true,
        resolved: resolveLink(n.file, file.path, files),
      }));
  }
  return {
    path: file.path,
    title:
      headings[0]?.text ??
      posix.basename(file.path).replace(/\.(md|canvas|base)$/, ""),
    version: file.version,
    updatedAt: file.updatedAt,
    ...(file.trashed ? { trashed: true } : {}),
    properties,
    tags,
    aliases: strings(properties.aliases),
    headings,
    tasks,
    links,
    backlinks: [],
  };
}
export function summaries(files: VaultFile[]) {
  const notes = files.map((f) => summarize(f, files));
  for (const note of notes)
    note.backlinks = notes
      .filter(
        (other) =>
          !other.trashed && other.links.some((l) => l.resolved === note.path),
      )
      .map((n) => n.path);
  return notes;
}
export function renameFile(
  vault: VaultState,
  path: string,
  destination: string,
  now: string,
) {
  const target = vault.files.find((f) => f.path === path && !f.trashed);
  requireThat(target, "not_found", 404);
  requireThat(
    path.slice(path.lastIndexOf(".")) ===
      destination.slice(destination.lastIndexOf(".")),
    "obsidian_extension_change",
    400,
  );
  requireThat(
    !vault.files.some(
      (f) => f.path.toLowerCase() === destination.toLowerCase(),
    ),
    "obsidian_path_exists",
    409,
  );
  for (const file of vault.files.filter((f) => !f.trashed)) {
    let content = file.content;
    if (file.path.endsWith(".md")) {
      // Resolve against the old vault, then write unambiguous vault-root links.
      for (const link of linkMatches(content).reverse()) {
        const resolved = resolveLink(
          link.target,
          file.path,
          vault.files,
          !link.wiki,
        );
        if (!resolved || (resolved !== path && file !== target)) continue;
        const newTarget = resolved === path ? destination : resolved;
        const heading = link.target.includes("#")
          ? link.target.slice(link.target.indexOf("#"))
          : "";
        const replacement = link.wiki
          ? `${link.embed ? "!" : ""}[[${stem(newTarget)}${heading}${link.suffix}]]`
          : `${link.prefix}${encodeURI(posix.relative(posix.dirname(file === target ? destination : file.path), newTarget))}${heading})`;
        content =
          content.slice(0, link.start) + replacement + content.slice(link.end);
      }
    } else if (file.path.endsWith(".canvas")) {
      const canvas = JSON.parse(content);
      for (const node of canvas.nodes)
        if (node.type === "file" && node.file === path) node.file = destination;
      content = JSON.stringify(canvas, null, 2);
    }
    if (content !== file.content || file === target) {
      file.content = content;
      file.version++;
      file.updatedAt = now;
    }
  }
  target.path = destination;
}
export function applyTemplate(
  content: string,
  title: string,
  date: string,
  time: string,
) {
  return content.replace(
    /\{\{(title|date|time)(?::([^}]+))?\}\}/g,
    (match, kind: string, format?: string) => {
      if (kind === "title") return title;
      if (!format) return kind === "date" ? date : time;
      requireThat(
        !/YYYYY|MMM|DDD|HHH|mmm/.test(format),
        "obsidian_template_format",
        400,
      );
      const tokens: Record<string, string> = {
        YYYY: date.slice(0, 4),
        MM: date.slice(5, 7),
        DD: date.slice(8, 10),
        HH: time.slice(0, 2),
        mm: time.slice(3, 5),
      };
      const formatted = format.replace(
        /YYYY|MM|DD|HH|mm/g,
        (t) => tokens[t] ?? t,
      );
      requireThat(!/[A-Za-z]/.test(formatted), "obsidian_template_format", 400);
      return formatted || match;
    },
  );
}
