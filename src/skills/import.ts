import { parseDocument } from "yaml";
import { z } from "zod";
import { Fault, requireThat, TOOLS } from "../domain.ts";
import { validateSkill } from "./catalog.ts";

const frontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Parse instruction metadata as YAML; declarations never install or grant tools. */
export function importMarkdown(markdown: string) {
  requireThat(
    Buffer.byteLength(markdown) <= 16384 && !markdown.includes("\0"),
    "invalid_markdown",
  );
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(
    markdown,
  );
  requireThat(match, "frontmatter_required");
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  requireThat(
    !document.errors.some((error) => error.code === "DUPLICATE_KEY"),
    "duplicate_metadata",
  );
  requireThat(
    !document.errors.length && !document.warnings.length,
    "invalid_frontmatter",
  );
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Fault("invalid_frontmatter");
  }
  const parsed = frontmatterSchema.safeParse(value);
  if (!parsed.success) {
    throw new Fault(
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")
        ? "unsupported_frontmatter"
        : "invalid_skill_metadata",
    );
  }
  const {
    name,
    description,
    "allowed-tools": allowedTools,
    ...frontmatter
  } = parsed.data;
  requireThat(description.length <= 1024, "skill_description_too_long");
  const requested =
    typeof allowedTools === "string"
      ? allowedTools.split(/[\s,]+/).filter(Boolean)
      : (allowedTools ?? [
          "read_chat_context",
          "read_instructions",
          "load_skill",
        ]);
  const tools = [...new Set(requested)];
  requireThat(
    tools.every((tool) => (TOOLS as readonly string[]).includes(tool)),
    "unsupported_skill_tools",
  );
  try {
    return validateSkill({
      slug: name,
      name,
      description,
      body: match[2],
      tools,
      ...(Object.keys(frontmatter).length ? { frontmatter } : {}),
    });
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("invalid_skill_metadata");
  }
}
