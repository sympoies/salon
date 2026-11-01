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

// Quoted voice prompts keep "> " markers; a preview collapses newlines into
// spaces, so markers follow whitespace as well as line starts.
const VOICE_QUOTE_MARKER = /(^|\s)>(?: |$)/g;

function dropVoiceQuoteMarkers(text: string): string {
  return /(?:^|\s)> \[語音[\]·]/.test(text) ? text.replace(VOICE_QUOTE_MARKER, "$1") : text;
}
