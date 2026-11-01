import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VOICE_PROMPT_TAG, compactPromptPreview, compactVoicePromptNote, plainVoiceOnlyMessage, quoteVoiceTranscript } from "../src/voicePrompt.ts";

const LEGACY_NOTE = "以下文字由語音轉寫，可能有同音字或專有名詞錯誤。請依對話脈絡理解；檔名、路徑、指令、數字或可能修改資料的內容若有歧義，先向我確認。\n\n原始轉寫：\n";

test("voice prompt tag is a language-neutral marker", () => {
  assert.equal(VOICE_PROMPT_TAG, "🎙️ ");
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
  assert.equal(quoteVoiceTranscript("line one\nline two", null), "> 🎙️ line one\n> line two");
  assert.equal(quoteVoiceTranscript("one\n\ntwo", null), "> 🎙️ one\n>\n> two");
});

test("quoteVoiceTranscript carries the response label verbatim", () => {
  assert.equal(quoteVoiceTranscript("hello", "Fast · GPU"), "> 🎙️ (Fast · GPU) hello");
  assert.equal(quoteVoiceTranscript("hello", ""), "> 🎙️ hello");
});

test("compactVoicePromptNote drops quote markers from voice previews", () => {
  assert.equal(compactVoicePromptNote("> [語音] one\n> two"), "[語音] one\ntwo");
  assert.equal(compactVoicePromptNote("typed > [語音·Fast] one > two"), "typed [語音·Fast] one > two");
  assert.equal(compactVoicePromptNote("a > b"), "a > b");
  assert.equal(compactVoicePromptNote("> 🎙️ (Fast) one\n> two"), "🎙️ (Fast) one\ntwo");
  assert.equal(compactVoicePromptNote("typed > 🎙️ one > two"), "typed 🎙️ one > two");
});

test("compactVoicePromptNote keeps typed and literal angle brackets around a voice block", () => {
  assert.equal(compactVoicePromptNote("a > b\n\n> [語音] hello"), "a > b\n\n[語音] hello");
  assert.equal(compactVoicePromptNote("> [語音] x > y\n> z > w\n\nafter > it"), "[語音] x > y\nz > w\n\nafter > it");
  assert.equal(compactVoicePromptNote("a > b > [語音] hello"), "a > b [語音] hello");
  assert.equal(compactVoicePromptNote("a > b\n\n> 🎙️ hello"), "a > b\n\n🎙️ hello");
  assert.equal(compactVoicePromptNote("🎙️ (Fast) plain voice"), "🎙️ (Fast) plain voice");
});

test("plainVoiceOnlyMessage unquotes a message made only of voice blocks", () => {
  assert.equal(plainVoiceOnlyMessage("> 🎙️ one"), "🎙️ one");
  assert.equal(plainVoiceOnlyMessage("> 🎙️ (Fast · GPU) one\n>\n> two"), "🎙️ (Fast · GPU) one\n\ntwo");
  assert.equal(plainVoiceOnlyMessage("> 🎙️ a\n\n> 🎙️ (Fast) b\n> c"), "🎙️ a\n\n🎙️ (Fast) b\nc");
  assert.equal(plainVoiceOnlyMessage("  > 🎙️ one\n> two\n"), "🎙️ one\ntwo");
});

test("plainVoiceOnlyMessage leaves any message with other text quoted", () => {
  for (const text of [
    "typed\n\n> 🎙️ one\n> two",
    "> 🎙️ one\n> two\n\ntyped",
    "> typed quote",
    "> typed quote\n\n> 🎙️ one",
    "🎙️ already plain",
    "> 🎙️ one\ntyped line in the block",
    "plain text",
    "",
  ]) assert.equal(plainVoiceOnlyMessage(text), text);
});

test("compactPromptPreview shortens upload paths and keeps the voice tag and text", () => {
  assert.equal(compactPromptPreview("'/s/sessions/a1/attachments/shot.png' 'it' > [語音·Fast] hello"), "[Image shot.png] 'it' [語音·Fast] hello");
  assert.equal(compactPromptPreview("'/s/sessions/a1/attachments/my '\\''x.txt'\n\n> [語音] hi\n> there"), "[File my 'x.txt]\n\n[語音] hi\nthere");
  assert.equal(compactPromptPreview("'/data/file.txt' and \"plain\""), "'/data/file.txt' and \"plain\"");
});

const IMAGE = "'/state/sessions/s-1/attachments/shot.png'";
const FILE = "'/state/sessions/s-1/attachments/my '\\''notes.txt'";

test("uploaded attachment paths are not typed text: attachments plus voice send the voice plain", () => {
  assert.equal(plainVoiceOnlyMessage(`${IMAGE}\n\n> 🎙️ one\n> two`), `${IMAGE}\n\n🎙️ one\ntwo`);
  assert.equal(plainVoiceOnlyMessage(`${IMAGE}\n${FILE}\n\n> 🎙️ (Fast) one`), `${IMAGE}\n${FILE}\n\n🎙️ (Fast) one`);
  assert.equal(plainVoiceOnlyMessage(`> 🎙️ one\n\n${IMAGE}`), `🎙️ one\n\n${IMAGE}`);
  assert.equal(plainVoiceOnlyMessage(`${IMAGE}\n\n> 🎙️ a\n\n> 🎙️ b`), `${IMAGE}\n\n🎙️ a\n\n🎙️ b`);
});

test("typed text, another path or a bare attachment keeps the message as it is", () => {
  for (const text of [
    `typed\n\n${IMAGE}\n\n> 🎙️ one`,
    `${IMAGE}\n\nlook at this\n\n> 🎙️ one`,
    `'/data/other.txt'\n\n> 🎙️ one`,
    `${IMAGE} extra words\n\n> 🎙️ one`,
    `${IMAGE}\n\n> typed quote\n\n> 🎙️ one`,
    IMAGE,
  ]) assert.equal(plainVoiceOnlyMessage(text), text);
});
