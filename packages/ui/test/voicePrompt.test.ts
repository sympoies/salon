import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VOICE_PROMPT_TAG, compactVoicePromptNote } from "../src/voicePrompt.ts";

const LEGACY_NOTE = "以下文字由語音轉寫，可能有同音字或專有名詞錯誤。請依對話脈絡理解；檔名、路徑、指令、數字或可能修改資料的內容若有歧義，先向我確認。\n\n原始轉寫：\n";

test("voice prompt tag stays short enough to keep the transcript visible", () => {
  assert.equal(VOICE_PROMPT_TAG, "[語音] ");
});

test("compactVoicePromptNote shortens the legacy voice note in stored prompts", () => {
  assert.equal(compactVoicePromptNote(`${LEGACY_NOTE}已經 commit 了`), "[語音] 已經 commit 了");
  // Previews may collapse newlines into spaces.
  assert.equal(compactVoicePromptNote(`${LEGACY_NOTE.replace(/\n/g, " ")}已經 commit 了`), "[語音] 已經 commit 了");
});

test("compactVoicePromptNote leaves ordinary prompts unchanged", () => {
  assert.equal(compactVoicePromptNote("以下文字由語音轉寫 is quoted here"), "以下文字由語音轉寫 is quoted here");
  assert.equal(compactVoicePromptNote("[語音] 已經 commit 了"), "[語音] 已經 commit 了");
});
