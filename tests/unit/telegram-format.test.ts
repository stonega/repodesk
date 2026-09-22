import { describe, expect, test } from "bun:test";
import {
  telegramMarkdown,
  telegramRichMessage,
} from "../../src/telegram/format.ts";

describe("Telegram structured rich messages", () => {
  test("renders headings, ordered/task lists, nested quotes, code and dividers as native blocks", () => {
    const rich = telegramRichMessage(
      "## Report\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Open\n\n> Quote\n>\n> - Nested\n\n```ts\nconst x = '<b>literal</b>';\n```\n\n---",
    );
    expect(rich.blocks.map((b) => b.type)).toEqual([
      "heading",
      "list",
      "list",
      "blockquote",
      "pre",
      "divider",
    ]);
    expect(rich.blocks[0]).toMatchObject({
      type: "heading",
      size: 2,
      text: ["Report"],
    });
    expect(rich.blocks[1]).toMatchObject({
      items: [
        { value: 3, type: "1" },
        { value: 4, type: "1" },
      ],
    });
    expect(rich.blocks[2]).toMatchObject({
      items: [{ has_checkbox: true, is_checked: true }, { has_checkbox: true }],
    });
    expect(rich.blocks[3]).toMatchObject({
      blocks: [{ type: "paragraph" }, { type: "list" }],
    });
    expect(rich.blocks[4]).toEqual({
      type: "pre",
      text: "const x = '<b>literal</b>';",
      language: "ts",
    });
  });
  test("renders compact tables with headers, alignment and nested inline styles", () => {
    const rich = telegramRichMessage(
      "| Name | Count |\n| :--- | ---: |\n| **A** | 2 |",
    );
    expect(rich.blocks).toEqual([
      {
        type: "table",
        is_bordered: true,
        is_compact: true,
        cells: [
          [
            { text: ["Name"], is_header: true, align: "left", valign: "top" },
            { text: ["Count"], is_header: true, align: "right", valign: "top" },
          ],
          [
            {
              text: [{ type: "bold", text: ["A"] }],
              align: "left",
              valign: "top",
            },
            { text: ["2"], align: "right", valign: "top" },
          ],
        ],
      },
    ]);
  });
  test("partial syntax is deliverable and bounded deep markup falls back to literal text", () => {
    expect(telegramRichMessage("```ts\nunfinished").blocks).toEqual([
      { type: "pre", language: "ts", text: "unfinished" },
    ]);
    const deep = `${"> ".repeat(50)}nested`;
    expect(telegramRichMessage(deep).blocks).toEqual([
      { type: "paragraph", text: deep },
    ]);
    const large = telegramRichMessage(`${"a".repeat(3999)}😀`);
    expect(large.blocks).toEqual([
      { type: "paragraph", text: ["a".repeat(3999)] },
    ]);
  });
});

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
