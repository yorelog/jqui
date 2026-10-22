// JSON presentation helpers: turning a value into coloured lines, and the
// three display modes for non-ASCII text.
//
// The viewer renders a pre-computed line list (virtualised by the caller), so
// every expensive step — pretty printing, sorting keys, escaping Chinese — runs
// once when the data or a display option changes, never during render.

import { msg } from "./i18n.js";

export const CHINESE_RAW = "raw";
export const CHINESE_ESCAPE = "escape";
export const CHINESE_HIDE = "hide";

const CJK_PATTERN =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\uAC00-\uD7AF]/u;

const NON_ASCII = /[^\x00-\x7F]/gu;

export function escapeNonAscii(text) {
  let out = "";
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    if (code < 0x80) {
      out += character;
    } else if (code <= 0xffff) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      const offset = code - 0x10000;
      out += "\\u" + (0xd800 + (offset >> 10)).toString(16).padStart(4, "0");
      out += "\\u" + (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0");
    }
  }
  return out;
}

export function hideNonAscii(text) {
  return String(text).replace(NON_ASCII, "\u00b7");
}

export function transformText(text, mode) {
  if (mode === CHINESE_ESCAPE) return escapeNonAscii(text);
  if (mode === CHINESE_HIDE) return hideNonAscii(text);
  return String(text);
}

export function countCjk(text) {
  if (!text) return 0;
  let count = 0;
  for (const character of String(text)) {
    if (CJK_PATTERN.test(character)) count += 1;
  }
  return count;
}

export function countNonAscii(text) {
  if (!text) return 0;
  const matches = String(text).match(NON_ASCII);
  return matches ? matches.length : 0;
}

function quoteString(value, mode) {
  const encoded = JSON.stringify(String(value));
  if (mode === CHINESE_ESCAPE) return escapeNonAscii(encoded);
  if (mode === CHINESE_HIDE) return hideNonAscii(encoded);
  return encoded;
}

function numberText(value) {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return JSON.stringify(value);
}

const MAX_LINE_CHARS = 6000;

function clipSpans(spans) {
  let total = 0;
  for (const span of spans) total += span.text.length;
  if (total <= MAX_LINE_CHARS) return spans;

  const out = [];
  let used = 0;
  for (const span of spans) {
    if (used >= MAX_LINE_CHARS) break;
    const remaining = MAX_LINE_CHARS - used;
    if (span.text.length <= remaining) {
      out.push(span);
      used += span.text.length;
    } else {
      out.push({ text: span.text.slice(0, remaining), kind: span.kind });
      used = MAX_LINE_CHARS;
    }
  }
  out.push({ text: " \u2026", kind: "punct" });
  return out;
}

/**
 * Pretty-prints a JSON value into lines.
 *
 * Each line has `{ no, depth, spans, plain }`; `spans` are `{ text, kind }`
 * with kind one of punct / key / string / number / boolean / null. The caller
 * renders `spans` and uses `depth` for indentation.
 */
export function flattenJson(value, options = {}) {
  const mode = options.mode || CHINESE_RAW;
  const sortKeys = Boolean(options.sortKeys);
  const maxLines = options.maxLines || 20000;
  const lines = [];
  let truncated = false;

  const punct = (text) => ({ text, kind: "punct" });

  const pushLine = (depth, spans, comma) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const all = comma ? spans.concat([punct(",")]) : spans;
    const clipped = clipSpans(all);
    const plain = "  ".repeat(depth) + clipped.map((span) => span.text).join("");
    lines.push({ no: lines.length + 1, depth, spans: clipped, plain });
  };

  const scalarSpan = (item) => {
    if (item === null || item === undefined) return [{ text: "null", kind: "null" }];
    if (typeof item === "boolean") return [{ text: item ? "true" : "false", kind: "boolean" }];
    if (typeof item === "number") return [{ text: numberText(item), kind: "number" }];
    if (typeof item === "string") return [{ text: quoteString(item, mode), kind: "string" }];
    return [{ text: JSON.stringify(item) || "null", kind: "string" }];
  };

  const isContainer = (item) => Array.isArray(item) || (item !== null && typeof item === "object");
  const isEmptyContainer = (item) =>
    (Array.isArray(item) && item.length === 0) ||
    (item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0);

  const emit = (prefix, item, depth, comma) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }

    if (Array.isArray(item)) {
      if (!item.length) {
        pushLine(depth, prefix.concat([punct("[]")]), comma);
        return;
      }
      pushLine(depth, prefix.concat([punct("[")]), false);
      for (let index = 0; index < item.length; index += 1) {
        if (lines.length >= maxLines) {
          truncated = true;
          return;
        }
        emit([], item[index], depth + 1, index < item.length - 1);
      }
      pushLine(depth, [punct("]")], comma);
      return;
    }

    if (isContainer(item)) {
      const keys = sortKeys ? Object.keys(item).sort() : Object.keys(item);
      if (!keys.length) {
        pushLine(depth, prefix.concat([punct("{}")]), comma);
        return;
      }
      pushLine(depth, prefix.concat([punct("{")]), false);
      for (let index = 0; index < keys.length; index += 1) {
        if (lines.length >= maxLines) {
          truncated = true;
          return;
        }
        const key = keys[index];
        emit(
          [{ text: quoteString(key, mode), kind: "key" }, punct(": ")],
          item[key],
          depth + 1,
          index < keys.length - 1,
        );
      }
      pushLine(depth, [punct("}")], comma);
      return;
    }

    pushLine(depth, prefix.concat(scalarSpan(item)), comma);
  };

  emit([], value === undefined ? null : value, 0, false);
  return { lines, truncated };
}

export function stringifyCompact(value, mode = CHINESE_RAW) {
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch (error) {
    text = JSON.stringify(String(value));
  }
  if (text === undefined) text = "null";
  return transformText(text, mode);
}

export function stringifyPretty(value, mode = CHINESE_RAW) {
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value, null, 2);
  } catch (error) {
    text = JSON.stringify(String(value), null, 2);
  }
  if (text === undefined) text = "null";
  return transformText(text, mode);
}

export function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatMillis(milliseconds) {
  const value = Number(milliseconds) || 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function truncateText(
  text,
  maxChars,
  note = msg(
    "\n\n… 内容较长，显示已截断；可以复制完整内容。",
    "\n\n… Content is long and truncated; copy for the full value.",
  ),
) {
  const value = String(text ?? "");
  if (!maxChars || value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars) + note, truncated: true };
}

export function isJsonValue(value) {
  return value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value) || true);
}

/** Parses response text as JSON, tolerating a UTF-8 BOM and surrounding space. */
export function parseJsonText(text) {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!normalized) return { ok: false, error: msg("响应为空", "Response is empty") };
  const first = normalized[0];
  if (!'[{"-0123456789tfn'.includes(first)) {
    return { ok: false, error: msg("响应内容看起来不是 JSON", "Response does not look like JSON") };
  }
  try {
    return { ok: true, value: JSON.parse(normalized) };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}
