import { Lexer, type Token, type Tokens } from "marked";

type Style = {
  type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link";
  url?: string;
};
export type MessageEntity = Style & { offset: number; length: number };

type RichText =
  | string
  | RichText[]
  | {
      type: "bold" | "italic" | "strikethrough" | "code" | "url";
      text: RichText;
      url?: string;
    };
type RichBlock =
  | { type: "paragraph"; text: RichText }
  | { type: "heading"; text: RichText; size: number }
  | { type: "pre"; text: string; language?: string }
  | { type: "divider" }
  | { type: "blockquote"; blocks: RichBlock[] }
  | {
      type: "list";
      items: {
        blocks: RichBlock[];
        has_checkbox?: true;
        is_checked?: true;
        value?: number;
        type?: "1";
      }[];
    }
  | {
      type: "table";
      cells: {
        text: RichText;
        is_header?: true;
        align: "left" | "center" | "right";
        valign: "top";
      }[][];
      is_bordered: true;
      is_compact: true;
    };

/** Explicit Bot API 10.3 blocks: model text cannot create media, buttons or raw HTML. */
export function telegramRichMessage(markdown: string) {
  const bounded = markdown.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "");
  let nodes = 0;
  const check = (depth: number) => {
    if (++nodes > 1000 || depth > 16) throw new Error("rich_format_limit");
  };
  const inline = (tokens: Token[], depth = 0): RichText[] =>
    tokens.map((token): RichText => {
      check(depth);
      switch (token.type) {
        case "strong":
        case "em":
        case "del":
          return {
            type:
              token.type === "strong"
                ? "bold"
                : token.type === "em"
                  ? "italic"
                  : "strikethrough",
            text: inline(token.tokens ?? [], depth + 1),
          };
        case "codespan":
          return { type: "code", text: token.text };
        case "link": {
          const text = inline(token.tokens ?? [], depth + 1);
          const url = safeLink(token.href);
          return url ? { type: "url", text, url } : text;
        }
        case "text":
          return token.tokens ? inline(token.tokens, depth + 1) : token.text;
        case "escape":
          return token.text;
        case "br":
          return "\n";
        default:
          return token.raw;
      }
    });
  const blocks = (tokens: Token[], depth = 0): RichBlock[] => {
    const result: RichBlock[] = [];
    for (const token of tokens) {
      check(depth);
      switch (token.type) {
        case "space":
        case "def":
          break;
        case "heading":
          result.push({
            type: "heading",
            size: token.depth,
            text: inline(token.tokens ?? [], depth + 1),
          });
          break;
        case "paragraph":
        case "text":
          result.push({
            type: "paragraph",
            text: token.tokens ? inline(token.tokens, depth + 1) : token.text,
          });
          break;
        case "code":
          result.push({
            type: "pre",
            text: token.text,
            ...(token.lang ? { language: token.lang.split(/\s+/)[0] } : {}),
          });
          break;
        case "hr":
          result.push({ type: "divider" });
          break;
        case "blockquote":
          result.push({
            type: "blockquote",
            blocks: blocks(token.tokens ?? [], depth + 1),
          });
          break;
        case "list": {
          const list = token as Tokens.List;
          result.push({
            type: "list",
            items: list.items.map((item, index) => ({
              blocks: blocks(item.tokens, depth + 1),
              ...(list.ordered
                ? { value: Number(list.start) + index, type: "1" as const }
                : {}),
              ...(item.task ? { has_checkbox: true as const } : {}),
              ...(item.checked ? { is_checked: true as const } : {}),
            })),
          });
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          result.push({
            type: "table",
            is_bordered: true,
            is_compact: true,
            cells: [table.header, ...table.rows].map((row, index) =>
              row.map((cell, column) => ({
                text: inline(cell.tokens, depth + 1),
                ...(index === 0 ? { is_header: true as const } : {}),
                align: table.align[column] ?? "left",
                valign: "top" as const,
              })),
            ),
          });
          break;
        }
        default:
          result.push({ type: "paragraph", text: token.raw });
      }
    }
    return result;
  };
  const literal: RichBlock[] = [{ type: "paragraph", text: bounded }];
  try {
    const parsed = blocks(Lexer.lex(bounded, { gfm: true, breaks: true }));
    return {
      blocks: parsed.length ? parsed : literal,
      skip_entity_detection: true,
    };
  } catch {
    return { blocks: literal, skip_entity_detection: true };
  }
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Render Markdown as text plus Telegram's UTF-16 entities, never executable HTML. */
export function telegramMarkdown(markdown: string) {
  let text = "";
  const entities: MessageEntity[] = [];
  const emit = (value: string, styles: Style[] = []) => {
    const offset = text.length;
    text += value;
    if (!value.trim()) return;
    for (const style of styles) {
      if (entities.length < 100)
        entities.push({ ...style, offset, length: value.length });
    }
  };
  const newline = () => {
    if (text && !text.endsWith("\n")) emit("\n");
  };
  const render = (tokens: Token[], styles: Style[] = []) => {
    for (const token of tokens) {
      switch (token.type) {
        case "strong":
        case "em":
        case "del": {
          const type =
            token.type === "strong"
              ? "bold"
              : token.type === "em"
                ? "italic"
                : "strikethrough";
          render(token.tokens ?? [], [
            ...styles.filter((s) => s.type !== type),
            { type },
          ]);
          break;
        }
        case "heading":
          newline();
          render(token.tokens ?? [], [{ type: "bold" }]);
          emit("\n\n");
          break;
        case "paragraph":
          render(token.tokens ?? [], styles);
          emit("\n\n");
          break;
        case "text":
          if (token.tokens) render(token.tokens, styles);
          else emit(token.text, styles);
          break;
        case "escape":
          emit(token.text, styles);
          break;
        case "codespan":
          // Telegram code/pre entities cannot overlap any other formatting.
          emit(token.text, [{ type: "code" }]);
          break;
        case "code":
          newline();
          emit(token.text, [{ type: "pre" }]);
          emit("\n\n");
          break;
        case "link": {
          const url = safeLink(token.href);
          render(
            token.tokens ?? [],
            url
              ? [
                  ...styles.filter((s) => s.type !== "text_link"),
                  { type: "text_link", url },
                ]
              : styles,
          );
          break;
        }
        case "list": {
          const list = token as Tokens.List;
          newline();
          list.items.forEach((item, index) => {
            emit(list.ordered ? `${Number(list.start) + index}. ` : "• ");
            if (item.task) emit(item.checked ? "☑ " : "☐ ");
            render(item.tokens, styles);
            newline();
          });
          emit("\n");
          break;
        }
        case "blockquote":
          newline();
          emit("› ");
          render(token.tokens ?? [], styles);
          newline();
          break;
        case "br":
          emit("\n");
          break;
        case "space":
          newline();
          break;
        case "hr":
          newline();
          emit("────────\n");
          break;
        case "def":
          break;
        default:
          // Unsupported constructs (including raw HTML and tables) stay literal.
          emit(token.raw, styles);
      }
    }
  };
  try {
    render(Lexer.lex(markdown, { gfm: true, breaks: true }));
  } catch {
    return { text: markdown, entities: [] };
  }
  // Bound the rendered message without splitting a surrogate pair or an entity.
  text = text
    .trimEnd()
    .slice(0, 4000)
    .replace(/[\uD800-\uDBFF]$/, "");
  if (!text.trim()) return { text: markdown, entities: [] };
  return {
    text,
    entities: entities
      .filter((entity) => entity.offset < text.length)
      .map((entity) => ({
        ...entity,
        length: Math.min(entity.length, text.length - entity.offset),
      })),
  };
}
