import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shellQuoteForTerminalArg, shellQuotePathForTerminal } from "../src/shellQuote.ts";

test("shellQuoteForTerminalArg leaves simple command tokens readable", () => {
  assert.equal(shellQuoteForTerminalArg("codex"), "codex");
  assert.equal(shellQuoteForTerminalArg("--no-alt-screen"), "--no-alt-screen");
  assert.equal(shellQuoteForTerminalArg("019f31ee-85dc-7ac0-93e9-b4c2d81ed91e"), "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e");
});

test("shellQuoteForTerminalArg quotes unsafe command tokens", () => {
  assert.equal(shellQuoteForTerminalArg("/home/runner/Project/agent console"), "'/home/runner/Project/agent console'");
  assert.equal(shellQuoteForTerminalArg("'; rm -rf / #"), "''\\''; rm -rf / #'");
});

test("shellQuotePathForTerminal wraps a plain path in single quotes", () => {
  assert.equal(shellQuotePathForTerminal("/tmp/clip.png"), "'/tmp/clip.png'");
});

test("shellQuotePathForTerminal keeps spaces inside the quotes", () => {
  assert.equal(shellQuotePathForTerminal("/tmp/a b/file.png"), "'/tmp/a b/file.png'");
});

test("shellQuotePathForTerminal escapes embedded single quotes (injection guard)", () => {
  // A hostile filename must not be able to close the quote and inject a command.
  assert.equal(shellQuotePathForTerminal("/tmp/a'b"), "'/tmp/a'\\''b'");
  assert.equal(shellQuotePathForTerminal("'; rm -rf / #"), "''\\''; rm -rf / #'");
});

test("shellQuotePathForTerminal neutralizes shell metacharacters by quoting", () => {
  // $, ;, &&, backticks, and | are all literal inside single quotes.
  assert.equal(shellQuotePathForTerminal("/p/$x;`id`&&y|z"), "'/p/$x;`id`&&y|z'");
});
