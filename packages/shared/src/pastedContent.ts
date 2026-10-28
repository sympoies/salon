// Claude Code records a prompt that carried a paste as one user turn wrapped in
// `<pasted_content id="x">`, a newline, the text, a newline and
// `</pasted_content id="x">`, framed by whitespace. The id is the same on both
// tags and the inner text never closes it.
const PASTE_WRAPPER = /^\s*<pasted_content id="([^"]*)">\n?((?:(?!<\/pasted_content id="\1">)[\s\S])*?)\n?<\/pasted_content id="\1">\s*$/;

/**
 * A user turn's text without a single outer paste wrapper (#1043). Text that is
 * not wholly one wrapper with matching ids, including one with text outside the
 * wrapper or an empty paste, is returned unchanged.
 */
export function unwrapPastedContent(text: string): string {
  const inner = PASTE_WRAPPER.exec(text)?.[2];
  return inner?.trim() ? inner : text;
}

const EMBEDDED_PASTE_WRAPPER = /<pasted_content id="([^"]*)">\n?((?:(?!<\/pasted_content id="\1">)[\s\S])*?)\n?<\/pasted_content id="\1">/g;

/**
 * A user turn's text with the tags of every well-formed paste wrapper removed
 * and the pasted text kept, so a prompt that mixes typed text and a paste reads
 * as the text that was sent (#110). Unmatched or mismatched tags stay as they
 * are.
 */
export function stripPasteWrappers(text: string): string {
  return text.replace(EMBEDDED_PASTE_WRAPPER, (_wrapper, _id, inner: string) => inner);
}
