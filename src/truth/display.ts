/**
 * Stenographer — text for people to read
 *
 * Claims, transcript lines, literals and identities are written by agents,
 * and the notices built from them land in terminals and chats. A raw ESC
 * sequence (conceal, erase line, hyperlink), a carriage return or a bidi
 * override in a claim could make a headline say something other than what
 * the record holds, so every human-facing formatter passes agent text
 * through `displayText`: C0 and C1 controls, DEL, line and paragraph
 * separators and bidi controls are escaped as visible `\uXXXX` (`\n`, `\r`,
 * `\t` as themselves), so one field stays on one line and shows what it is.
 * Records and JSON payloads keep the original text.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Agent text made safe for one line of a notice; longer text is cut at `max` characters. */
export function displayText(text: string, max: number = Number.POSITIVE_INFINITY): string {
  const escaped = text.replace(
    CONTROL,
    (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return escaped.length > max ? `${escaped.slice(0, max)}… [truncated]` : escaped;
}
