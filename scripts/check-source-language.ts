import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Package source is language-neutral English. Chinese, Japanese and Korean text,
// including fullwidth punctuation, is reported; write such code points as escapes.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/;

// The only literal CJK allowed: parsers for voice tags that earlier releases stored.
export const SOURCE_LANGUAGE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "packages/ui/src/voicePrompt.ts": [
    "// `[語音] ` and `[語音·label] `, and before that a long transcription note.",
    "const LEGACY_VOICE_PROMPT_TAG = \"[語音] \";",
    "const LEGACY_VOICE_PROMPT_NOTE = /^以下文字由語音轉寫，[^]*?原始轉寫：\\s*/;",
    "const ANY_VOICE_TAG = \"(?:\\\\[語音[\\\\]·]|\\\\u{1F399})\";",
  ],
};

/** `path:line` for each source line with CJK text outside the allowlist. */
export function findSourceLanguageViolations(files: Iterable<readonly [path: string, text: string]>): string[] {
  const violations: string[] = [];
  for (const [path, text] of files) {
    if (!PACKAGE_SOURCE.test(path)) continue;
    const allowed = new Set(SOURCE_LANGUAGE_ALLOWLIST[path] ?? []);
    text.split("\n").forEach((line, index) => {
      if (CJK.test(line) && !allowed.has(line)) violations.push(`${path}:${index + 1}`);
    });
  }
  return violations;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const violations = findSourceLanguageViolations(paths.filter((path) => PACKAGE_SOURCE.test(path)).map((path) => [path, readFileSync(path, "utf8")] as const));
  if (violations.length) {
    console.error(`CJK text in package source (write escapes or use English):\n${violations.join("\n")}`);
    process.exit(1);
  }
  console.log("source language: ok");
}
