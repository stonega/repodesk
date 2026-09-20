import { describe, expect, test } from "bun:test";
import { telegramMarkdown } from "../../src/telegram/format.ts";

describe("Telegram Markdown formatting", () => {
  test("renders the reported bold headings and lists", () => {
    const result = telegramMarkdown(
      "Hi\n\n**What I can see**\n- One message [source:105:13].\n\n1. **Team recap** — summarize.",
    );
    expect(result.text).toBe(
      "Hi\n\nWhat I can see\n\n• One message [source:105:13].\n\n1. Team recap — summarize.",
    );
    expect(
      result.entities
        .filter((e) => e.type === "bold")
        .map((e) => result.text.slice(e.offset, e.offset + e.length)),
    ).toEqual(["What I can see", "Team recap"]);
    expect(result.text).not.toContain("**");
  });
  test("uses UTF-16 offsets for emoji and nested emphasis", () => {
    const result = telegramMarkdown("😀 **你好 _world_** ~~old~~");
    expect(result.text).toBe("😀 你好 world old");
    expect(result.entities).toContainEqual({
      type: "bold",
      offset: 3,
      length: 3,
    });
    expect(result.entities).toContainEqual({
      type: "italic",
      offset: 6,
      length: 5,
    });
    expect(result.entities).toContainEqual({
      type: "strikethrough",
      offset: 12,
      length: 3,
    });
  });
  test("code is literal and never overlaps enclosing styles", () => {
    const result = telegramMarkdown(
      "**Use `a_b < x` now**\n\n```ts\nconst x = '**literal**';\n```",
    );
    const code = result.entities.filter((e) =>
      ["code", "pre"].includes(e.type),
    );
    expect(code).toHaveLength(2);
    expect(result.text).toContain("const x = '**literal**';");
    for (const span of code)
      for (const other of result.entities.filter((e) => e !== span))
        expect(
          other.offset >= span.offset + span.length ||
            other.offset + other.length <= span.offset,
        ).toBe(true);
  });
  test("preserves HTML literally and only formats safe links", () => {
    const result = telegramMarkdown(
      "<b>literal</b> & <script>x</script>\n\n[**Docs**](https://example.com/?a=1&b=2) [bad](javascript:alert)",
    );
    expect(result.text).toContain("<script>x</script>");
    const links = result.entities.filter((e) => e.type === "text_link");
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://example.com/?a=1&b=2");
    expect(result.text).toContain("Docs bad");
  });
  test("malformed Markdown and syntax-only input remain deliverable", () => {
    expect(telegramMarkdown("**unfinished [source:1:2]").text).toBe(
      "**unfinished [source:1:2]",
    );
    expect(telegramMarkdown("[ref]: https://example.com").text).toBe(
      "[ref]: https://example.com",
    );
    expect(telegramMarkdown("```\n**literal**").text).toBe("**literal**");
  });
  test("bounds text and formatting without breaking emoji", () => {
    const result = telegramMarkdown(`**${"a".repeat(3999)}😀**`);
    expect(result.text).toBe("a".repeat(3999));
    expect(result.entities).toEqual([
      { type: "bold", offset: 0, length: 3999 },
    ]);
    const many = telegramMarkdown("**bold** ".repeat(300));
    expect(many.entities.length).toBeLessThanOrEqual(100);
    expect(many.text.match(/bold/g)).toHaveLength(300);
  });
});
