import { describe, expect, test } from "bun:test";
import { validateSkill } from "../../src/skills/catalog.ts";
import { importMarkdown } from "../../src/skills/import.ts";
import { harnessSkills } from "../fixtures/harness-skills.ts";

const markdown = (
  metadata: string,
  body = "Use available application tools.",
) => `---\n${metadata}\n---\n${body}`;

describe("portable SKILL.md imports", () => {
  test("accepts the four reported harness files without shortening their descriptions", () => {
    for (const [name, source] of Object.entries(harnessSkills)) {
      const spec = importMarkdown(source);
      expect(spec.slug).toBe(name);
      expect(spec.description.length).toBeGreaterThan(300);
      expect(spec.tools).toEqual([
        "read_chat_context",
        "read_instructions",
        "load_skill",
      ]);
    }
  });
  test("preserves YAML quoting, folded descriptions, comments, mappings and sequence tool declarations", () => {
    const spec = importMarkdown(
      markdown(`name: yaml-skill
# Source metadata is inert.
description: >-
  Preserve a long description
  across lines.
license: 'Author''s license'
compatibility: Node.js
metadata:
  author: "Harness: team"
  version: "1.0"
allowed-tools:
  - read_chat_context
  - load_skill
  - load_skill`),
    );
    expect(spec.description).toBe("Preserve a long description across lines.");
    expect(spec.frontmatter).toEqual({
      license: "Author's license",
      compatibility: "Node.js",
      metadata: { author: "Harness: team", version: "1.0" },
    });
    expect(spec.tools).toEqual(["read_chat_context", "load_skill"]);
    expect(
      importMarkdown(
        `\uFEFF${markdown("name: bom-skill\ndescription: Valid").replaceAll("\n", "\r\n")}`,
      ).slug,
    ).toBe("bom-skill");
  });
  test("supports standard description and name lengths and the full file body limit with precise errors", () => {
    const spec = importMarkdown(
      markdown(
        `name: ${"a".repeat(64)}\ndescription: ${"d".repeat(1024)}`,
        "b".repeat(13000),
      ),
    );
    expect(spec.description).toHaveLength(1024);
    expect(spec.body).toHaveLength(13000);
    expect(() =>
      importMarkdown(
        markdown(`name: long-description\ndescription: ${"d".repeat(1025)}`),
      ),
    ).toThrow("skill_description_too_long");
    expect(() =>
      importMarkdown(
        markdown("name: oversized\ndescription: Valid", "b".repeat(16384)),
      ),
    ).toThrow("invalid_markdown");
  });
  test("rejects malformed YAML, duplicate keys, aliases, custom tags, unknown fields and non-string metadata", () => {
    for (const tail of [
      "description: [invalid",
      "description: !unsafe injected",
      "description: &anchor value\ncompatibility: *anchor",
    ]) {
      expect(() =>
        importMarkdown(markdown(`name: invalid-skill\n${tail}`)),
      ).toThrow("invalid_frontmatter");
    }
    expect(() =>
      importMarkdown(
        markdown(
          "name: duplicate-skill\nname: other-skill\ndescription: Value",
        ),
      ),
    ).toThrow("duplicate_metadata");
    expect(() =>
      importMarkdown(
        markdown(
          "name: duplicate-skill\ndescription: Value\nmetadata:\n  author: A\n  author: B",
        ),
      ),
    ).toThrow("duplicate_metadata");
    expect(() =>
      importMarkdown(
        markdown("name: unsafe-skill\ndescription: Value\nscript: install.sh"),
      ),
    ).toThrow("unsupported_frontmatter");
    expect(() =>
      importMarkdown(
        markdown(
          "name: typed-skill\ndescription: Value\nmetadata:\n  version: 1",
        ),
      ),
    ).toThrow("invalid_skill_metadata");
  });
  test("declared tools never provide shell or arbitrary connector capabilities", () => {
    for (const tools of ["shell", "[Bash, Read]", "[load_skill, shell]"]) {
      expect(() =>
        importMarkdown(
          markdown(
            `name: limited-skill\ndescription: Value\nallowed-tools: ${tools}`,
          ),
        ),
      ).toThrow("unsupported_skill_tools");
    }
    expect(
      importMarkdown(
        markdown("name: limited-skill\ndescription: Value\nallowed-tools: []"),
      ).tools,
    ).toEqual([]);
  });
  test("saved resources validate paths, duplicates, byte budgets and secrets beyond the instruction body", () => {
    const spec = importMarkdown(
      markdown("name: safe-skill\ndescription: Value"),
    );
    for (const path of [
      "../secret.md",
      "/secret.md",
      "folder/../secret.md",
      "script.sh",
      "folder\\secret.md",
    ]) {
      expect(() =>
        validateSkill({ ...spec, resources: [{ path, body: "Content" }] }),
      ).toThrow();
    }
    expect(() =>
      validateSkill({
        ...spec,
        resources: [
          { path: "guide.md", body: "A" },
          { path: "guide.md", body: "B" },
        ],
      }),
    ).toThrow("invalid_skill_resources");
    expect(() =>
      validateSkill({
        ...spec,
        resources: [{ path: "guide.md", body: "字".repeat(22000) }],
      }),
    ).toThrow("invalid_skill_resources");
    expect(() =>
      importMarkdown(
        markdown(
          `name: secret-skill\ndescription: Value\nmetadata:\n  token: sk-${"x".repeat(25)}`,
        ),
      ),
    ).toThrow("skill_contains_secret_or_binary");
  });
});
