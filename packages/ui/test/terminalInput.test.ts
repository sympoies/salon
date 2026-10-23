import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyTerminalData } from "../src/terminalInput.ts";

test("terminal input classifier promotes only exact standalone control payloads", () => {
  const controls = new Map([
    ["\r", "enter"],
    ["\n", "enter"],
    ["\r\n", "enter"],
    ["\x1b", "escape"],
    ["\x7f", "backspace"],
    ["\x03", "c-c"],
    ["\t", "tab"],
    ["\x1b[A", "up"],
    ["\x1b[B", "down"],
    ["\x1b[C", "right"],
    ["\x1b[D", "left"],
    ["\x1bOA", "up"],
    ["\x1bOB", "down"],
    ["\x1bOC", "right"],
    ["\x1bOD", "left"],
  ] as const);

  for (const [data, key] of controls) {
    assert.deepEqual(classifyTerminalData(data), { key });
  }
});

test("terminal input classifier preserves text, paste, reports, and modified keys", () => {
  const textPayloads = [
    "ordinary text",
    "中文輸入",
    "a\x7f",
    "\x1b[2;1R",
    "\x1b[1;2A",
    "\x1b[200~pasted\x7ftext\x1b[201~",
  ];

  for (const text of textPayloads) {
    assert.deepEqual(classifyTerminalData(text), { text });
  }
});
