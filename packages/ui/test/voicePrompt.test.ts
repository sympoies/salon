import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VOICE_PROMPT_TAG, compactPromptPreview, compactVoicePromptNote, quoteVoiceTranscript } from "../src/voicePrompt.ts";

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

test("quoteVoiceTranscript quotes every line and puts the tag on the first", () => {
  assert.equal(quoteVoiceTranscript("line one\nline two", null), "> [語音] line one\n> line two");
  assert.equal(quoteVoiceTranscript("one\n\ntwo", null), "> [語音] one\n>\n> two");
});

test("quoteVoiceTranscript carries the response label verbatim", () => {
  assert.equal(quoteVoiceTranscript("hello", "Fast · GPU"), "> [語音·Fast · GPU] hello");
  assert.equal(quoteVoiceTranscript("hello", ""), "> [語音] hello");
});

test("compactVoicePromptNote drops quote markers from voice previews", () => {
  assert.equal(compactVoicePromptNote("> [語音] one\n> two"), "[語音] one\ntwo");
  assert.equal(compactVoicePromptNote("typed > [語音·Fast] one > two"), "typed [語音·Fast] one > two");
  assert.equal(compactVoicePromptNote("a > b"), "a > b");
});

test("compactVoicePromptNote keeps typed and literal angle brackets around a voice block", () => {
  assert.equal(compactVoicePromptNote("a > b\n\n> [語音] hello"), "a > b\n\n[語音] hello");
  assert.equal(compactVoicePromptNote("> [語音] x > y\n> z > w\n\nafter > it"), "[語音] x > y\nz > w\n\nafter > it");
  assert.equal(compactVoicePromptNote("a > b > [語音] hello"), "a > b [語音] hello");
});

test("compactPromptPreview shortens upload paths and keeps the voice tag and text", () => {
  assert.equal(compactPromptPreview("'/s/sessions/a1/attachments/shot.png' 'it' > [語音·Fast] hello"), "[圖片 shot.png] 'it' [語音·Fast] hello");
  assert.equal(compactPromptPreview("'/s/sessions/a1/attachments/my '\\''x.txt'\n\n> [語音] hi\n> there"), "[檔案 my 'x.txt]\n\n[語音] hi\nthere");
  assert.equal(compactPromptPreview("'/data/file.txt' and \"plain\""), "'/data/file.txt' and \"plain\"");
});
