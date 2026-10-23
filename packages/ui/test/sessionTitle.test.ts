import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_SESSION_TITLE_LEN, normalizeSessionTitle } from "../src/sessionTitle.ts";

const sessionSlotSource = readFileSync(new URL("../src/SessionSlot.tsx", import.meta.url), "utf8");
const terminalViewSource = readFileSync(new URL("../src/TerminalView.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../src/InlineTitleEditor.tsx", import.meta.url), "utf8");

test("normalizeSessionTitle trims input and maps empty titles to null", () => {
  assert.equal(normalizeSessionTitle("  renamed  "), "renamed");
  assert.equal(normalizeSessionTitle("   "), null);
});

test("inline title editors share the title limit and editor component", () => {
  assert.equal(MAX_SESSION_TITLE_LEN, 120);
  assert.match(editorSource, /maxLength=\{MAX_SESSION_TITLE_LEN\}/);
  assert.match(sessionSlotSource, /<InlineTitleEditor/);
  assert.match(terminalViewSource, /<InlineTitleEditor/);
  assert.doesNotMatch(sessionSlotSource, /maxLength=\{120\}/);
  assert.doesNotMatch(terminalViewSource, /maxLength=\{120\}/);
});
