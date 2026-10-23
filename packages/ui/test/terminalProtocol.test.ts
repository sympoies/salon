import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTerminalProtocolGuard } from "../src/terminalProtocol.ts";

test("terminal protocol guard leaves printable output and SGR styling batchable", () => {
  const guard = createTerminalProtocolGuard();

  assert.equal(guard.requiresImmediateWrite("ordinary output\n"), false);
  assert.equal(guard.requiresImmediateWrite("\u001b[31mred\u001b[0m"), false);
  assert.equal(guard.requiresImmediateWrite("\u001b[?25lredraw\u001b[?25h"), false, "cursor visibility is display-only");
});

test("terminal protocol guard recognizes response queries and input-mode changes", () => {
  const guard = createTerminalProtocolGuard();

  assert.equal(guard.requiresImmediateWrite("\u001b[6n"), true, "cursor position query");
  assert.equal(guard.requiresImmediateWrite("\u001b[c"), true, "device attributes query");
  assert.equal(guard.requiresImmediateWrite("\u001b[?2004h"), true, "bracketed-paste mode");
  assert.equal(guard.requiresImmediateWrite("\u001b[?1000l"), true, "mouse mode");
  assert.equal(guard.requiresImmediateWrite("\u001b[?66h"), true, "application-keypad mode");
  assert.equal(guard.requiresImmediateWrite("\u001b[?66l"), true, "application-keypad reset");
  assert.equal(guard.requiresImmediateWrite("\u001bZ"), true, "legacy device attributes query");
  assert.equal(guard.requiresImmediateWrite("\u001b]10;?\u001b\\"), true, "foreground color query");
  assert.equal(guard.requiresImmediateWrite("\u001b]4;0;?\u0007"), true, "indexed color query");
  assert.equal(guard.requiresImmediateWrite("\u009d11;?\u009c"), true, "C1 background color query");
});

test("terminal protocol guard recognizes a control sequence split across websocket frames", () => {
  const guard = createTerminalProtocolGuard();

  assert.equal(guard.requiresImmediateWrite("prefix\u001b[?20"), false);
  assert.equal(guard.requiresImmediateWrite("04h"), true);

  assert.equal(guard.requiresImmediateWrite("prefix\u001b[?6"), false);
  assert.equal(guard.requiresImmediateWrite("6h"), true, "split application-keypad mode");
});

test("terminal protocol guard recognizes split OSC queries in string and binary frames", () => {
  const strings = createTerminalProtocolGuard();
  assert.equal(strings.requiresImmediateWrite("\u001b]12;"), false);
  assert.equal(strings.requiresImmediateWrite("?\u001b\\"), true);

  const binary = createTerminalProtocolGuard();
  assert.equal(binary.requiresImmediateWrite(new Uint8Array([0x1b, 0x5d, 0x34, 0x3b, 0x31, 0x3b])), false);
  assert.equal(binary.requiresImmediateWrite(new Uint8Array([0x3f, 0x07])), true);
});
