import { shortenUploadedFiles } from "./attachmentPaths.ts";

/** Language-neutral marker prepended to voice-transcribed prompts so previews keep the transcript visible. */
export const VOICE_PROMPT_TAG = "🎙️ ";

// Stored prompts and previews from earlier releases carry the Chinese tags
// `[語音] ` and `[語音·label] `, and before that a long transcription note.
const LEGACY_VOICE_PROMPT_TAG = "[語音] ";
const LEGACY_VOICE_PROMPT_NOTE = /^以下文字由語音轉寫，[^]*?原始轉寫：\s*/;
// Either generation of tag, as it opens a voice text (the microphone emoji may
// or may not carry its variation selector).
const ANY_VOICE_TAG = "(?:\\[語音[\\]·]|\\u{1F399})";
const QUOTED_VOICE_TAG = new RegExp(`^> ${ANY_VOICE_TAG}`, "u");

export function compactVoicePromptNote(text: string): string {
  return dropVoiceQuoteMarkers(text.replace(LEGACY_VOICE_PROMPT_NOTE, LEGACY_VOICE_PROMPT_TAG));
}

/** A voice transcript as a Markdown blockquote; the tag, with the response label verbatim, opens its first line. */
export function quoteVoiceTranscript(text: string, label: string | null): string {
  const tag = label ? `${VOICE_PROMPT_TAG.trimEnd()} (${label}) ` : VOICE_PROMPT_TAG;
  return `${tag}${text}`.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

// Only the markers this app generated come off: the one before the tag and, on
// a multi-line text, the quoted lines that follow it. A collapsed preview cannot
// tell later markers from typed ">", so those stay.
const COLLAPSED_QUOTE_MARKER = new RegExp(`(^|\\s)> (?=${ANY_VOICE_TAG})`, "gu");

function dropVoiceQuoteMarkers(text: string): string {
  if (!new RegExp(`> ${ANY_VOICE_TAG}`, "u").test(text)) return text;
  if (!text.includes("\n")) return text.replace(COLLAPSED_QUOTE_MARKER, "$1");
  let quoted = false;
  return text.split("\n").map((line) => {
    if (QUOTED_VOICE_TAG.test(line)) { quoted = true; return line.slice(2); }
    if (quoted && /^>( |$)/.test(line)) return line.slice(2);
    quoted = false;
    return line;
  }).join("\n");
}

/**
 * A message made only of voice blocks is sent without the quote markers; any
 * other text beside voice keeps every voice block quoted.
 */
export function plainVoiceOnlyMessage(text: string): string {
  const message = text.trim();
  if (!message) return text;
  const blocks = message.split(/\n{2,}/);
  const voiceOnly = blocks.every((block) => {
    const lines = block.split("\n");
    return QUOTED_VOICE_TAG.test(lines[0]!) && lines.every((line) => /^>( |$)/.test(line));
  });
  return voiceOnly ? blocks.map((block) => block.split("\n").map((line) => line.slice(2)).join("\n")).join("\n\n") : text;
}

/** A stored prompt as the Session list and History previews show it. */
export function compactPromptPreview(text: string): string {
  return shortenUploadedFiles(compactVoicePromptNote(text));
}
