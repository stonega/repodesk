import { Lexer, type Token, type Tokens } from "marked";

type Style = {
  type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link";
  url?: string;
};
export type MessageEntity = Style & { offset: number; length: number };

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
