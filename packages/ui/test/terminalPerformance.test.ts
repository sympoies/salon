import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TERMINAL_PERFORMANCE_STORAGE_KEY,
  createTerminalPerformanceRecorder,
  installTerminalPerformanceLifecyclePersistence,
} from "../src/terminalPerformance.ts";
import type { StorageLike } from "../src/storage.ts";

type Timer = { readonly id: number; readonly callback: () => void; readonly delayMs: number };

function memoryStorage(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("terminal performance recorder persists content-free aggregates by render mode", () => {
  const storage = memoryStorage();
  const timers = new Map<number, Timer>();
  let now = 1_000;
  let nextTimerId = 0;
  const recorder = createTerminalPerformanceRecorder<Timer>({
    storage,
    now: () => now,
    persistDelayMs: 5_000,
    setTimeout: (callback, delayMs) => {
      const timer = { id: ++nextTimerId, callback, delayMs };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer.id),
  });

  recorder.setMode("focus-aware-balanced");
  recorder.setSelectedPaneRealtime(false);
  const unregisterFirst = recorder.registerPane();
  recorder.registerPane();
  recorder.recordFrame({ mode: "focus-aware-balanced", focused: false, unitCount: 90 });
  recorder.recordFrame({ mode: "focus-aware-balanced", focused: true, unitCount: 10 });
  recorder.recordWrite({
    mode: "focus-aware-balanced",
    focused: false,
    reason: "timer",
    frameCount: 9,
    unitCount: 90,
  });
  recorder.recordWrite({
    mode: "focus-aware-balanced",
    focused: true,
    reason: "realtime",
    frameCount: 1,
    unitCount: 10,
  });

  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]?.delayMs, 5_000);
  now = 6_000;
  const [timer] = timers.values();
  assert.ok(timer);
  timers.delete(timer.id);
  timer.callback();

  const raw = storage.values.get(TERMINAL_PERFORMANCE_STORAGE_KEY);
  assert.ok(raw);
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.schema_version, "agent-console.terminal-performance.v1");
  assert.equal(snapshot.current_mode, "focus-aware-balanced");
  assert.equal(snapshot.current_selected_pane_realtime, false);
  assert.equal(snapshot.active_panes, 2);
  assert.deepEqual(snapshot.by_mode["focus-aware-balanced"], {
    frames: 2,
    payload_units: 100,
    focused_frames: 1,
    background_frames: 1,
    writes: 2,
    write_units: 100,
    realtime_writes: 1,
    batch_flushes: 1,
    batched_frames: 9,
    max_batch_frames: 9,
    max_batch_units: 90,
  });
  assert.equal(snapshot.by_mode.realtime.frames, 0);
  assert.equal(snapshot.by_mode["focus-aware-smooth"].frames, 0);
  assert.equal(snapshot.by_mode["focus-aware-efficient"].frames, 0);
  assert.doesNotMatch(raw, /machine|session|content|output|token|prompt/i);

  unregisterFirst();
  assert.equal(recorder.snapshot().active_panes, 1);
});

test("terminal performance recorder coalesces writes and clears its timer on dispose", () => {
  const storage = memoryStorage();
  const cleared: number[] = [];
  const recorder = createTerminalPerformanceRecorder<number>({
    storage,
    now: () => 1,
    setTimeout: () => 42,
    clearTimeout: (timer) => cleared.push(timer),
  });

  recorder.recordFrame({ mode: "realtime", focused: false, unitCount: 1 });
  recorder.recordFrame({ mode: "realtime", focused: false, unitCount: 1 });
  recorder.dispose();

  assert.deepEqual(cleared, [42]);
});

test("terminal performance recorder persists pending aggregates on pagehide", () => {
  const storage = memoryStorage();
  const listeners = new Set<() => void>();
  const target = {
    addEventListener(type: "pagehide", listener: () => void) {
      assert.equal(type, "pagehide");
      listeners.add(listener);
    },
    removeEventListener(type: "pagehide", listener: () => void) {
      assert.equal(type, "pagehide");
      listeners.delete(listener);
    },
  };
  const recorder = createTerminalPerformanceRecorder<number>({
    storage,
    now: () => 1,
    setTimeout: () => 42,
    clearTimeout: () => undefined,
  });
  const uninstall = installTerminalPerformanceLifecyclePersistence(target, recorder);

  recorder.recordFrame({ mode: "focus-aware-balanced", focused: false, unitCount: 7 });
  assert.equal(storage.values.has(TERMINAL_PERFORMANCE_STORAGE_KEY), false);

  for (const listener of listeners) listener();
  const persisted = storage.values.get(TERMINAL_PERFORMANCE_STORAGE_KEY);
  assert.ok(persisted);
  assert.equal(JSON.parse(persisted).totals.frames, 1);

  uninstall();
  assert.equal(listeners.size, 0);
});
