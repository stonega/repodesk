type RecordValue = Record<string, unknown>;
type Entity = { type: string; offset: number; length: number };
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

/** Read displayed rich content only. URLs, buttons and media never grant actions. */
function richContent(value: unknown) {
  let text = "";
  let nodes = 0;
  const entities: Entity[] = [];
  const append = (value: string) => {
    text += value.slice(0, Math.max(0, 20000 - text.length));
  };
  const inline = (value: unknown, depth: number, controls: boolean) => {
    if (++nodes > 4096 || depth > 32 || text.length >= 20000) return;
    if (typeof value === "string") return append(value);
    if (Array.isArray(value)) {
      for (const item of value) inline(item, depth + 1, controls);
      return;
    }
    const item = record(value);
    if (!item) return;
    const offset = text.length;
    inline(item.text, depth + 1, controls && item.type !== "code");
    const displayed = text.slice(offset);
    if (
      controls &&
      ["bot_command", "mention"].includes(String(item.type)) &&
      displayed &&
      displayed === item[String(item.type)]
    )
      entities.push({
        type: String(item.type),
        offset,
        length: displayed.length,
      });
  };
  const blocks = (value: unknown, depth = 0, controls = true) => {
    if (!Array.isArray(value) || depth > 32) return;
    for (const valueItem of value) {
      if (++nodes > 4096 || text.length >= 20000) break;
      const item = record(valueItem);
      if (!item) continue;
      if (text && !text.endsWith("\n")) append("\n");
      switch (item.type) {
        case "paragraph":
        case "heading":
        case "footer":
        case "expandable_blockquote":
          inline(
            item.text,
            depth + 1,
            controls && item.type !== "expandable_blockquote",
          );
          break;
        case "pre":
          inline(item.text, depth + 1, false);
          break;
        case "mathematical_expression":
          if (typeof item.expression === "string") append(item.expression);
          break;
        case "blockquote":
        case "pullquote":
        case "details":
          inline(item.header, depth + 1, false);
          blocks(item.blocks, depth + 1, false);
          break;
        case "list":
          if (Array.isArray(item.items))
            for (const child of item.items)
              blocks(record(child)?.blocks, depth + 1, false);
          break;
        case "table":
          if (Array.isArray(item.rows))
            for (const row of item.rows) {
              const cells = record(row)?.cells;
              if (!Array.isArray(cells)) continue;
              for (const cell of cells) {
                inline(record(cell)?.text, depth + 1, false);
                append("\t");
              }
              append("\n");
            }
          break;
      }
    }
  };
  blocks(record(value)?.blocks);
  return { text: text.trimEnd(), entities };
}

function message(value: unknown, depth = 0): unknown {
  const input = record(value);
  if (!input || depth > 1) return value;
  const normalized = { ...input };
  if (
    input.text === undefined &&
    input.caption === undefined &&
    input.rich_message !== undefined
  )
    Object.assign(normalized, richContent(input.rich_message));
  if (input.reply_to_message)
    normalized.reply_to_message = message(input.reply_to_message, depth + 1);
  return normalized;
}

/** Normalize before the update schema strips unknown Telegram fields. */
export function normalizeRichUpdate(value: unknown): unknown {
  const input = record(value);
  if (!input) return value;
  const normalized = { ...input };
  for (const key of ["message", "edited_message"])
    if (input[key]) normalized[key] = message(input[key]);
  const callback = record(input.callback_query);
  if (callback?.message)
    normalized.callback_query = {
      ...callback,
      message: message(callback.message),
    };
  return normalized;
}
