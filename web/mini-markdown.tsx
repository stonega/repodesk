import { Lexer, type Token } from "marked";
import { Fragment, memo, type ReactNode, useState } from "react";

function Code({ text, language }: { text: string; language?: string }) {
  const [label, setLabel] = useState("Copy");
  return (
    <div className="mini-code">
      <div>
        <span>{language || "Code"}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setLabel("Copied");
            } catch {
              setLabel("Select to copy");
            }
          }}
        >
          {label}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function content(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    const children = () =>
      content((token as { tokens?: Token[] }).tokens ?? []);
    let node: ReactNode;
    switch (token.type) {
      case "space":
        return null;
      case "heading":
        node = <h3>{children()}</h3>;
        break;
      case "paragraph":
        node = <p>{children()}</p>;
        break;
      case "text":
        node = (token as { tokens?: Token[] }).tokens ? children() : token.text;
        break;
      case "strong":
        node = <strong>{children()}</strong>;
        break;
      case "em":
        node = <em>{children()}</em>;
        break;
      case "del":
        node = <del>{children()}</del>;
        break;
      case "codespan":
        node = <code>{token.text}</code>;
        break;
      case "code":
        node = <Code text={token.text} language={token.lang} />;
        break;
      case "br":
        node = <br />;
        break;
      case "hr":
        node = <hr />;
        break;
      case "blockquote":
        node = <blockquote>{children()}</blockquote>;
        break;
      case "link": {
        const href = safeUrl(token.href);
        node = href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children()}
          </a>
        ) : (
          children()
        );
        break;
      }
      case "list": {
        const items = token.items.map(
          (item: { tokens: Token[] }, i: number) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Lexer positions are stable within an immutable recorded message.
            <li key={`${i}:${item.tokens[0]?.raw}`}>{content(item.tokens)}</li>
          ),
        );
        node = token.ordered ? (
          <ol start={token.start || 1}>{items}</ol>
        ) : (
          <ul>{items}</ul>
        );
        break;
      }
      default:
        node = token.raw;
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: Lexer positions are stable within an immutable recorded message.
      <Fragment key={`${index}:${token.type}`}>{node}</Fragment>
    );
  });
}
export const MiniMarkdown = memo(function MiniMarkdown({
  text,
}: {
  text: string;
}) {
  return <div className="mini-markdown">{content(Lexer.lex(text))}</div>;
});
