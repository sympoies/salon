/** Short marker prepended to voice-transcribed prompts so previews keep the transcript visible. */
export const VOICE_PROMPT_TAG = "[語音] ";

// Earlier releases prefixed voice prompts with a long transcription note; stored
// last-prompt and history previews still carry it.
const LEGACY_VOICE_PROMPT_NOTE = /^以下文字由語音轉寫，[^]*?原始轉寫：\s*/;

export function compactVoicePromptNote(text: string): string {
  return text.replace(LEGACY_VOICE_PROMPT_NOTE, VOICE_PROMPT_TAG);
}
