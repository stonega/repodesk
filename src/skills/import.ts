import { requireThat, skillSchema } from "../domain.ts";
import { validateSkill } from "./catalog.ts";
/** P0 intentionally supports a small, unambiguous subset of SKILL.md frontmatter. */
export function importMarkdown(markdown: string) {
  requireThat(
    Buffer.byteLength(markdown) <= 16384 && !markdown.includes("\0"),
    "invalid_markdown",
  );
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(markdown);
  requireThat(match, "frontmatter_required");
  const metadata: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const entry = /^(name|description|allowed-tools):\s*(.+)$/.exec(line);
    requireThat(entry?.[1] && entry[2], "unsupported_frontmatter");
    requireThat(!metadata[entry[1]], "duplicate_metadata");
    metadata[entry[1]] = entry[2].replace(/^['"]|['"]$/g, "");
  }
  return validateSkill(
    skillSchema.parse({
      slug: metadata.name,
      name: metadata.name,
      description: metadata.description,
      body: match[2],
      tools: (
        metadata["allowed-tools"] ?? "read_chat_context read_instructions"
      )
        .split(/[\s,]+/)
        .filter(Boolean),
    }),
  );
}
