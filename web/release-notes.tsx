import { Lexer, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode } from "react";

/** Format release Markdown with native nodes; HTML and remote images stay literal. */
export function ReleaseNotes({ text, url }: { text: string; url: string }) {
  let remaining = 5000;
  const render = (tokens: Token[], depth = 0): ReactNode[] =>
    tokens.map((token, index) => {
      if (--remaining < 0 || depth > 16) throw Error("release_notes_limit");
      const children = () =>
        render("tokens" in token ? (token.tokens ?? []) : [], depth + 1);
      let content: ReactNode;
      switch (token.type) {
        case "space":
        case "def":
          return null;
        case "heading":
          content = <h4>{children()}</h4>;
          break;
        case "paragraph":
          content = <p>{children()}</p>;
          break;
        case "strong":
          content = <strong>{children()}</strong>;
          break;
        case "em":
          content = <em>{children()}</em>;
          break;
        case "del":
          content = <del>{children()}</del>;
          break;
        case "text":
          content = token.tokens ? children() : token.text;
          break;
        case "escape":
          content = token.text;
          break;
        case "br":
          content = <br />;
          break;
        case "code":
          content = (
            <pre>
              <code>{token.text}</code>
            </pre>
          );
          break;
        case "codespan":
          content = <code>{token.text}</code>;
          break;
        case "blockquote":
          content = <blockquote>{children()}</blockquote>;
          break;
        case "list": {
          const list = token as Tokens.List;
          const items = list.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: A reviewed release is immutable within this read-only dialog.
            <li key={`${itemIndex}:${item.raw}`}>
              {render(item.tokens, depth + 1)}
            </li>
          ));
          content = list.ordered ? (
            <ol start={Number(list.start)}>{items}</ol>
          ) : (
            <ul>{items}</ul>
          );
          break;
        }
        case "link": {
          let href: string | undefined;
          try {
            const link = new URL(token.href, url);
            if (["http:", "https:"].includes(link.protocol)) href = link.href;
          } catch {
            /* Unsafe links remain text. */
          }
          content = href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {children()}
            </a>
          ) : (
            children()
          );
          break;
        }
        case "hr":
          content = <hr />;
          break;
        default:
          content = token.raw;
      }
      // biome-ignore lint/suspicious/noArrayIndexKey: Tokens belong to one immutable reviewed release and have no interactive state.
      return <Fragment key={`${index}:${token.type}`}>{content}</Fragment>;
    });
  try {
    return <>{render(Lexer.lex(text, { gfm: true }))}</>;
  } catch {
    return <div className="release-notes-literal">{text}</div>;
  }
}
