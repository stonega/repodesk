import { Fault, requireThat, TOOLS } from "../domain.ts";
import { validateSkill } from "./catalog.ts";
import { readSkillMarkdown, SkillMarkdownError } from "./markdown.ts";

export function importMarkdown(markdown: string) {
  let parsed: ReturnType<typeof readSkillMarkdown>;
  try {
    parsed = readSkillMarkdown(markdown);
  } catch (error) {
    if (error instanceof SkillMarkdownError) throw new Fault(error.code);
    throw new Fault("invalid_frontmatter");
  }
  const { name, description, body, frontmatter } = parsed;
  const tools = parsed.tools ?? [
    "read_chat_context",
    "read_instructions",
    "load_skill",
  ];
  requireThat(
    tools.every((tool) => (TOOLS as readonly string[]).includes(tool)),
    "unsupported_skill_tools",
  );
  try {
    return validateSkill({
      slug: name,
      name,
      description,
      body,
      tools,
      ...(Object.keys(frontmatter).length ? { frontmatter } : {}),
    });
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("invalid_skill_metadata");
  }
}
