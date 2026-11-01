import { shortenUploadedFiles } from "./attachmentPaths.ts";

/** Short marker prepended to voice-transcribed prompts so previews keep the transcript visible. */
export const VOICE_PROMPT_TAG = "[語音] ";

// Earlier releases prefixed voice prompts with a long transcription note; stored
// last-prompt and history previews still carry it.
const LEGACY_VOICE_PROMPT_NOTE = /^以下文字由語音轉寫，[^]*?原始轉寫：\s*/;

export function compactVoicePromptNote(text: string): string {
  return dropVoiceQuoteMarkers(text.replace(LEGACY_VOICE_PROMPT_NOTE, VOICE_PROMPT_TAG));
}

/** A voice transcript as a Markdown blockquote; the tag, with the response label verbatim, opens its first line. */
export function quoteVoiceTranscript(text: string, label: string | null): string {
  const tag = label ? `[語音·${label}] ` : VOICE_PROMPT_TAG;
  return `${tag}${text}`.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

// Only the markers this app generated come off: the one before the tag and, on
// a multi-line text, the quoted lines that follow it. A collapsed preview cannot
// tell later markers from typed ">", so those stay.
const VOICE_QUOTE_TAG = /> \[語音[\]·]/;

function dropVoiceQuoteMarkers(text: string): string {
  if (!VOICE_QUOTE_TAG.test(text)) return text;
  if (!text.includes("\n")) return text.replace(/(^|\s)> (?=\[語音[\]·])/g, "$1");
  let quoted = false;
  return text.split("\n").map((line) => {
    if (/^> \[語音[\]·]/.test(line)) { quoted = true; return line.slice(2); }
    if (quoted && /^>( |$)/.test(line)) return line.slice(2);
    quoted = false;
    return line;
  }).join("\n");
}

/** A stored prompt as the Session list and History previews show it. */
export function compactPromptPreview(text: string): string {
  return shortenUploadedFiles(compactVoicePromptNote(text));
}
