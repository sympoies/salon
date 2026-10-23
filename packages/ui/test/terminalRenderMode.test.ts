import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TERMINAL_RENDER_MODE_STORAGE_KEY,
  TERMINAL_SELECTED_PANE_REALTIME_STORAGE_KEY,
  loadTerminalRenderMode,
  loadTerminalSelectedPaneRealtime,
  saveTerminalRenderMode,
  saveTerminalSelectedPaneRealtime,
  terminalRenderBatchDelayMs,
} from "../src/terminalRenderMode.ts";
import type { StorageLike } from "../src/storage.ts";

function memoryStorage(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("terminal rendering defaults to realtime and persists every supported profile", () => {
  const storage = memoryStorage();

  assert.equal(loadTerminalRenderMode(storage), "realtime");
  for (const mode of [
    "focus-aware-smooth",
    "focus-aware-balanced",
    "focus-aware-efficient",
    "realtime",
  ] as const) {
    assert.equal(saveTerminalRenderMode(mode, storage), true);
    assert.equal(storage.values.get(TERMINAL_RENDER_MODE_STORAGE_KEY), mode);
    assert.equal(loadTerminalRenderMode(storage), mode);
  }
});

test("terminal rendering maps profiles to 100/250/500 ms and migrates legacy focus-aware", () => {
  const storage = memoryStorage();

  assert.equal(terminalRenderBatchDelayMs("realtime"), null);
  assert.equal(terminalRenderBatchDelayMs("focus-aware-smooth"), 100);
  assert.equal(terminalRenderBatchDelayMs("focus-aware-balanced"), 250);
  assert.equal(terminalRenderBatchDelayMs("focus-aware-efficient"), 500);
  storage.values.set(TERMINAL_RENDER_MODE_STORAGE_KEY, "focus-aware");
  assert.equal(loadTerminalRenderMode(storage), "focus-aware-balanced");
});

test("terminal rendering fails safely to realtime for unknown profiles", () => {
  const storage = memoryStorage();
  storage.values.set(TERMINAL_RENDER_MODE_STORAGE_KEY, "fast-ish");

  assert.equal(loadTerminalRenderMode(storage), "realtime");
  storage.values.set(TERMINAL_RENDER_MODE_STORAGE_KEY, "toString");
  assert.equal(loadTerminalRenderMode(storage), "realtime");
});

test("selected grid pane stays realtime by default and persists an explicit opt-out", () => {
  const storage = memoryStorage();

  assert.equal(loadTerminalSelectedPaneRealtime(storage), true);
  assert.equal(saveTerminalSelectedPaneRealtime(false, storage), true);
  assert.equal(storage.values.get(TERMINAL_SELECTED_PANE_REALTIME_STORAGE_KEY), "false");
  assert.equal(loadTerminalSelectedPaneRealtime(storage), false);
  assert.equal(saveTerminalSelectedPaneRealtime(true, storage), true);
  assert.equal(loadTerminalSelectedPaneRealtime(storage), true);
});
