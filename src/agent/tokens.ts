import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Fallback context window used for compaction planning when the configured
 * model has no explicit or catalog context window (instead of MAX_SAFE_INTEGER).
 */
export const DEFAULT_COMPACTION_CONTEXT_WINDOW = 128_000;

/** Conservative per-image token allowance, independent of base64 wire size. */
export const DEFAULT_IMAGE_TOKEN_ALLOWANCE = 32_768;

/**
 * Returns true for CJK Unified Ideographs, Hangul, Kana, and full-width forms
 * where UTF-8 uses 3 bytes/char but modern BPE tokenizers use ~0.7–1.2 tokens/char.
 */
function isCjkOrWide(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

/**
 * Fast, deterministic, zero-dependency token estimator for mixed English, code,
 * and CJK text. Avoids the 2–4x overestimation of raw UTF-8 byte length while
 * keeping a mild safety margin (~10–15%) for budget reservations and compaction.
 *
 * Calibrated against modern BPE tokenizers (o200k / cl100k / DeepSeek / Claude):
 * - ASCII word chars & spaces: ~3.6 chars/token (~0.28 tokens/char)
 * - ASCII punctuation / code symbols / newlines: ~2.0 chars/token (~0.5 tokens/char)
 * - CJK / wide characters: ~1.1 tokens/char (vs 3.0 UTF-8 bytes/char)
 * - Other non-ASCII (Cyrillic, Arabic, accented Latin, emoji): ~0.75 tokens/char
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0;
    if (code > 0xffff) i++; // advance past surrogate pair
    if (code <= 0x7f) {
      if (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x20
      ) {
        units += 0.28;
      } else {
        units += 0.5;
      }
    } else if (isCjkOrWide(code)) {
      units += 1.1;
    } else {
      units += 0.75;
    }
  }
  return Math.max(1, Math.ceil(units));
}

/**
 * Estimates tokens for an arbitrary JSON-like structure without inflating
 * strings by JSON escaping or raw UTF-8 byte lengths.
 */
export function estimateValueTokens(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (depth > 16) return 4;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += estimateValueTokens(item, depth + 1) + 1;
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      total +=
        estimateTextTokens(key) + 1 + estimateValueTokens(entry, depth + 1);
    }
    return total;
  }
  return 1;
}

export interface EstimatedContextTokens {
  textTokens: number;
  imageTokens: number;
  totalTokens: number;
}

/**
 * Estimates total prompt tokens across system prompt, native messages, and
 * tool declarations, accounting for images separately from base64 payload size.
 */
export function estimateContextTokens(
  context: {
    systemPrompt?: string;
    messages?: readonly (AgentMessage | { role?: string; content?: unknown })[];
    tools?: readonly unknown[];
  },
  imageAllowancePerImage = DEFAULT_IMAGE_TOKEN_ALLOWANCE,
): EstimatedContextTokens {
  let textTokens = context.systemPrompt
    ? estimateTextTokens(context.systemPrompt) + 4
    : 0;
  let imageTokens = 0;

  if (context.tools?.length) {
    for (const tool of context.tools) {
      textTokens += estimateValueTokens(tool) + 4;
    }
  }

  for (const message of context.messages ?? []) {
    // Per-message role/framing overhead (~4 tokens in OpenAI/Anthropic chat formats).
    textTokens += 4;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      textTokens += estimateTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const typed = part as Record<string, unknown>;
        if (typed.type === "image") {
          imageTokens += imageAllowancePerImage;
        } else if (typed.type === "text" && typeof typed.text === "string") {
          textTokens += estimateTextTokens(typed.text);
        } else if (
          typed.type === "thinking" &&
          typeof typed.thinking === "string"
        ) {
          textTokens += estimateTextTokens(typed.thinking);
        } else if (typed.type === "toolCall") {
          textTokens +=
            estimateTextTokens(String(typed.name ?? "")) +
            estimateValueTokens(typed.arguments) +
            6;
        } else {
          textTokens += estimateValueTokens(typed);
        }
      }
    } else if (content !== undefined) {
      textTokens += estimateValueTokens(content);
    }
  }

  return {
    textTokens,
    imageTokens,
    totalTokens: textTokens + imageTokens,
  };
}

/**
 * Resolves a finite context window for compaction planning. When a model has no
 * configured or catalog context window (represented by MAX_SAFE_INTEGER or
 * contextWindowKnown=false), falls back to DEFAULT_COMPACTION_CONTEXT_WINDOW so
 * long conversations still compact before hitting upstream provider limits.
 */
export function effectiveCompactionWindow(
  contextWindow?: number,
  contextWindowKnown?: boolean,
): number {
  if (
    contextWindowKnown === false ||
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    contextWindow >= 10_000_000
  ) {
    return DEFAULT_COMPACTION_CONTEXT_WINDOW;
  }
  return contextWindow;
}

/**
 * Truncates text to fit strictly within `maxBytes` UTF-8 bytes without splitting
 * multibyte UTF-8 characters, surrogate pairs, or `[source:...]` citations.
 */
export function truncateUtf8Safe(text: string, maxBytes: number): string {
  const trimmed = text.trim();
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBytes);
  if (budget === 0) return "";

  // Walk by Unicode code points so we never split a UTF-8 sequence or surrogate pair.
  let used = 0;
  let endIndex = 0;
  for (let i = 0; i < trimmed.length; ) {
    const cp = trimmed.codePointAt(i) ?? 0;
    const step = cp > 0xffff ? 2 : 1;
    const charBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (used + charBytes > budget) break;
    used += charBytes;
    i += step;
    endIndex = i;
  }

  let cut = trimmed.slice(0, endIndex);
  // Avoid leaving an unclosed [source:... citation tag at the boundary.
  const openCitation = cut.lastIndexOf("[source:");
  if (openCitation !== -1 && cut.indexOf("]", openCitation) === -1) {
    cut = cut.slice(0, openCitation);
  }
  // Prefer a clean line/sentence/word boundary if it keeps at least 60% of content.
  const minKeep = Math.floor(cut.length * 0.6);
  const boundary = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf("。"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf(" "),
  );
  if (boundary >= minKeep) {
    cut = cut.slice(0, boundary + (cut[boundary] === "。" ? 1 : 0));
  }
  cut = cut.trimEnd();
  if (!cut) {
    // Edge case: single giant token/citation; fall back to raw code-point slice.
    cut = trimmed.slice(0, endIndex).trimEnd();
  }
  const result = `${cut}${suffix}`;
  return Buffer.byteLength(result, "utf8") <= maxBytes
    ? result
    : trimmed.slice(0, endIndex).trimEnd();
}
