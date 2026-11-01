import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  orderedShortcutSessionKeys,
  resolveDashboardShortcutAction,
  resolveSessionShortcutTarget,
  resolveToggleFocusTarget,
  type DashboardShortcutInput,
} from "../src/dashboardShortcuts.ts";

const baseInput: DashboardShortcutInput = {
  key: "t",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isMacTauri: true,
  editableTarget: false,
};

test("dashboard shortcut decision preserves browser and Android defaults", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, isMacTauri: false }), null);
  assert.equal(
    resolveDashboardShortcutAction({
      ...baseInput,
      metaKey: false,
      ctrlKey: true,
      isMacTauri: false,
    }),
    null,
  );
});

test("dashboard shortcut decision ignores Ctrl-only and modified app shortcuts", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, metaKey: false, ctrlKey: true }), null);
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, ctrlKey: true }), null);
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, altKey: true }), null);
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, shiftKey: true }), null);
});

test("dashboard shortcut decision ignores editable targets", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, editableTarget: true }), null);
});

test("dashboard shortcut decision maps macOS app Cmd shortcuts", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "t" }), "create");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "R" }), "reconnect");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "e" }), "rename");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "n" }), "layout-decrease");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "m" }), "layout-increase");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "u" }), null);
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "w" }), "close");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "f" }), "toggle-focus");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "p" }), "retitle");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "i" }), "voice");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "y" }), "conversation");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "/", code: "Slash" }), "shortcut-help");
});

test("dashboard shortcut decision maps Cmd+H/L to session nav and Cmd+; to Usage", () => {
  // H/L always walk the session list (vim-style prev/next).
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "h" }), "session-prev");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "l" }), "session-next");
  // Usage moved to Cmd+; to free L.
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: ";" }), "usage");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "'" }), null);
});

test("dashboard shortcut decision maps macOS session navigation shortcuts", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "1" }), "open-1");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "4" }), "open-4");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "5" }), "repair-sessions");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "6" }), "open-6");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "0" }), null);
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "7" }), null);
});

test("dashboard shortcut decision maps macOS back-to-list shortcut", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "`" }), "back");
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "~", shiftKey: true }), "back");
});

test("dashboard shortcut decision ignores shifted numeric shortcuts", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "!", shiftKey: true }), null);
});

test("dashboard shortcut decision ignores unknown keys", () => {
  assert.equal(resolveDashboardShortcutAction({ ...baseInput, key: "z" }), null);
});

test("shortcut session order follows rendered slots before unslotted visible sessions", () => {
  assert.deepEqual(
    orderedShortcutSessionKeys(["summit/b", "summit/a", null], [
      "summit/a",
      "summit/b",
      "mesa/c",
    ]),
    ["summit/b", "summit/a", "mesa/c"],
  );
});

test("shortcut session order skips empty, stale, and duplicate slots", () => {
  assert.deepEqual(
    orderedShortcutSessionKeys([null, "missing/x", "summit/b", "summit/b"], [
      "summit/a",
      "summit/b",
    ]),
    ["summit/b", "summit/a"],
  );
});

test("shortcut session order preserves hidden visible sessions after a full layout", () => {
  assert.deepEqual(
    orderedShortcutSessionKeys(["summit/b", "summit/a", "mesa/c"], [
      "summit/a",
      "summit/b",
      "mesa/c",
      "mesa/d",
    ]),
    ["summit/b", "summit/a", "mesa/c", "mesa/d"],
  );
});

test("toggle focus target prefers the last interacted slot before remembered focus", () => {
  assert.equal(
    resolveToggleFocusTarget({
      selectedKey: "summit/d",
      activeTerminalKey: null,
      rememberedKey: "summit/a",
      shortcutSessionKeys: ["summit/a", "summit/b", "summit/c", "summit/d"],
    }),
    "summit/d",
  );
});

test("toggle focus target falls back through active, remembered, then first session", () => {
  assert.equal(
    resolveToggleFocusTarget({
      selectedKey: "missing/d",
      activeTerminalKey: "summit/b",
      rememberedKey: "summit/a",
      shortcutSessionKeys: ["summit/a", "summit/b"],
    }),
    "summit/b",
  );
  assert.equal(
    resolveToggleFocusTarget({
      selectedKey: null,
      activeTerminalKey: null,
      rememberedKey: "summit/a",
      shortcutSessionKeys: ["summit/a", "summit/b"],
    }),
    "summit/a",
  );
  assert.equal(
    resolveToggleFocusTarget({
      selectedKey: "missing/a",
      activeTerminalKey: "missing/b",
      rememberedKey: "missing/c",
      shortcutSessionKeys: ["summit/a", "summit/b"],
    }),
    "summit/a",
  );
  assert.equal(
    resolveToggleFocusTarget({
      selectedKey: null,
      activeTerminalKey: null,
      rememberedKey: null,
      shortcutSessionKeys: [],
    }),
    null,
  );
});

test("session shortcuts target the selected session in focused and overview views", () => {
  const availableKeys = ["mesa:a", "mesa:b"];
  assert.equal(resolveSessionShortcutTarget({ focusedKey: "mesa:a", activeTerminalKey: "mesa:b", promptTargetKey: "mesa:b", availableKeys }), "mesa:a");
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: "mesa:b", promptTargetKey: "mesa:a", availableKeys }), "mesa:a");
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: null, promptTargetKey: "mesa:a", availableKeys }), "mesa:a");
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: null, promptTargetKey: null, availableKeys }), null);
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: null, promptTargetKey: "mesa:old", availableKeys }), null);
});

test("session shortcuts reject stale fullscreen targets and hidden overview selections", () => {
  assert.equal(resolveSessionShortcutTarget({ focusedKey: "old", activeTerminalKey: "a", promptTargetKey: "a", availableKeys: ["a"] }), null);
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: "old", promptTargetKey: "old", availableKeys: ["a"] }), null);
  assert.equal(resolveSessionShortcutTarget({ focusedKey: null, activeTerminalKey: "a", promptTargetKey: "old", availableKeys: ["a"] }), "a");
});


test("Shell opens with Command/Control Shift S while editable fields stay untouched", () => {
  const key = { key: "S", code: "KeyS", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, isMacTauri: true, editableTarget: false };
  assert.equal(resolveDashboardShortcutAction(key), "shell");
  assert.equal(resolveDashboardShortcutAction({ ...key, metaKey: false, ctrlKey: true, isMacTauri: false }), "shell");
  assert.equal(resolveDashboardShortcutAction({ ...key, editableTarget: true }), null);
  assert.equal(resolveDashboardShortcutAction({ ...key, altKey: true }), null);
});


test("page shortcuts are the unshifted comma and period keys, usable from editable fields", () => {
  for (const [key, code, action] of [[",", "Comma", "page-prev"], [".", "Period", "page-next"]] as const) {
    assert.equal(resolveDashboardShortcutAction({ ...baseInput, key, code }), action);
    assert.equal(resolveDashboardShortcutAction({ ...baseInput, key, code, editableTarget: true }), action);
    for (const guard of [{ isMacTauri: false }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      assert.equal(resolveDashboardShortcutAction({ ...baseInput, key, code, ...guard }), null);
    }
  }
  for (const key of ["<", ">"]) {
    assert.equal(resolveDashboardShortcutAction({ ...baseInput, key, code: key === "<" ? "Comma" : "Period", shiftKey: true }), null);
  }
});
