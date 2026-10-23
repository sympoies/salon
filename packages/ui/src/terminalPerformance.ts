import { defaultScheduler, type TimeoutScheduler } from "./scheduler.ts";
import { isTauri } from "./runtime.ts";
import { resolveLocalStorage, safeSetItem, type StorageLike } from "./storage.ts";
import type { TerminalOutputDelivery } from "./terminalOutputBatcher.ts";
import type { TerminalRenderMode } from "./terminalRenderMode.ts";

export const TERMINAL_PERFORMANCE_STORAGE_KEY = "ac.terminalPerformance.v1";

interface TerminalPerformanceCounters {
  frames: number;
  payload_units: number;
  focused_frames: number;
  background_frames: number;
  writes: number;
  write_units: number;
  realtime_writes: number;
  batch_flushes: number;
  batched_frames: number;
  max_batch_frames: number;
  max_batch_units: number;
}

export interface TerminalPerformanceSnapshot {
  readonly schema_version: "agent-console.terminal-performance.v1";
  readonly started_at_ms: number;
  readonly updated_at_ms: number;
  readonly current_mode: TerminalRenderMode;
  readonly current_selected_pane_realtime: boolean;
  readonly active_panes: number;
  readonly totals: TerminalPerformanceCounters;
  readonly by_mode: Record<TerminalRenderMode, TerminalPerformanceCounters>;
}

interface TerminalPerformanceFrame {
  readonly mode: TerminalRenderMode;
  readonly focused: boolean;
  readonly unitCount: number;
}

interface TerminalPerformanceWrite extends TerminalPerformanceFrame, TerminalOutputDelivery {}

export interface TerminalPerformanceRecorder {
  setMode(mode: TerminalRenderMode): void;
  setSelectedPaneRealtime(enabled: boolean): void;
  registerPane(): () => void;
  recordFrame(frame: TerminalPerformanceFrame): void;
  recordWrite(write: TerminalPerformanceWrite): void;
  snapshot(): TerminalPerformanceSnapshot;
  persistNow(): boolean;
  dispose(): void;
}

export interface TerminalPerformanceLifecycleTarget {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

interface TerminalPerformanceRecorderOptions<Timer> extends TimeoutScheduler<Timer> {
  readonly storage: StorageLike | null;
  readonly now?: () => number;
  readonly persistDelayMs?: number;
}

const DEFAULT_PERSIST_DELAY_MS = 5_000;

function emptyCounters(): TerminalPerformanceCounters {
  return {
    frames: 0,
    payload_units: 0,
    focused_frames: 0,
    background_frames: 0,
    writes: 0,
    write_units: 0,
    realtime_writes: 0,
    batch_flushes: 0,
    batched_frames: 0,
    max_batch_frames: 0,
    max_batch_units: 0,
  };
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function copyCounters(counters: TerminalPerformanceCounters): TerminalPerformanceCounters {
  return { ...counters };
}

export function createTerminalPerformanceRecorder<Timer>(
  options: TerminalPerformanceRecorderOptions<Timer>,
): TerminalPerformanceRecorder {
  const now = options.now ?? Date.now;
  const persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
  const startedAtMs = now();
  let updatedAtMs = startedAtMs;
  let currentMode: TerminalRenderMode = "realtime";
  let currentSelectedPaneRealtime = true;
  let activePanes = 0;
  let timer: Timer | null = null;
  let disposed = false;
  const totals = emptyCounters();
  const byMode: Record<TerminalRenderMode, TerminalPerformanceCounters> = {
    realtime: emptyCounters(),
    "focus-aware-smooth": emptyCounters(),
    "focus-aware-balanced": emptyCounters(),
    "focus-aware-efficient": emptyCounters(),
  };

  const snapshot = (): TerminalPerformanceSnapshot => ({
    schema_version: "agent-console.terminal-performance.v1",
    started_at_ms: startedAtMs,
    updated_at_ms: updatedAtMs,
    current_mode: currentMode,
    current_selected_pane_realtime: currentSelectedPaneRealtime,
    active_panes: activePanes,
    totals: copyCounters(totals),
    by_mode: {
      realtime: copyCounters(byMode.realtime),
      "focus-aware-smooth": copyCounters(byMode["focus-aware-smooth"]),
      "focus-aware-balanced": copyCounters(byMode["focus-aware-balanced"]),
      "focus-aware-efficient": copyCounters(byMode["focus-aware-efficient"]),
    },
  });

  const persistNow = () => {
    if (timer !== null) {
      options.clearTimeout(timer);
      timer = null;
    }
    return safeSetItem(options.storage, TERMINAL_PERFORMANCE_STORAGE_KEY, JSON.stringify(snapshot()));
  };

  const schedulePersist = () => {
    if (disposed || options.storage === null || timer !== null) {
      return;
    }
    timer = options.setTimeout(() => {
      timer = null;
      safeSetItem(options.storage, TERMINAL_PERFORMANCE_STORAGE_KEY, JSON.stringify(snapshot()));
    }, persistDelayMs);
  };

  const changed = () => {
    updatedAtMs = now();
    schedulePersist();
  };

  const increment = (mode: TerminalRenderMode, update: (counters: TerminalPerformanceCounters) => void) => {
    update(totals);
    update(byMode[mode]);
    changed();
  };

  return {
    setMode(mode) {
      if (disposed || mode === currentMode) {
        return;
      }
      currentMode = mode;
      changed();
    },
    setSelectedPaneRealtime(enabled) {
      if (disposed || enabled === currentSelectedPaneRealtime) {
        return;
      }
      currentSelectedPaneRealtime = enabled;
      changed();
    },
    registerPane() {
      if (disposed) {
        return () => undefined;
      }
      activePanes += 1;
      changed();
      let registered = true;
      return () => {
        if (!registered || disposed) {
          return;
        }
        registered = false;
        activePanes = Math.max(0, activePanes - 1);
        changed();
      };
    },
    recordFrame(frame) {
      if (disposed) {
        return;
      }
      const units = count(frame.unitCount);
      increment(frame.mode, (counters) => {
        counters.frames += 1;
        counters.payload_units += units;
        if (frame.focused) {
          counters.focused_frames += 1;
        } else {
          counters.background_frames += 1;
        }
      });
    },
    recordWrite(write) {
      if (disposed) {
        return;
      }
      const units = count(write.unitCount);
      const frames = count(write.frameCount);
      increment(write.mode, (counters) => {
        counters.writes += 1;
        counters.write_units += units;
        if (write.reason === "realtime" || write.reason === "protocol") {
          counters.realtime_writes += 1;
        } else {
          counters.batch_flushes += 1;
          counters.batched_frames += frames;
          counters.max_batch_frames = Math.max(counters.max_batch_frames, frames);
          counters.max_batch_units = Math.max(counters.max_batch_units, units);
        }
      });
    },
    snapshot,
    persistNow,
    dispose() {
      if (disposed) {
        return;
      }
      if (timer !== null) {
        options.clearTimeout(timer);
        timer = null;
      }
      disposed = true;
    },
  };
}

export function installTerminalPerformanceLifecyclePersistence(
  target: TerminalPerformanceLifecycleTarget,
  performanceRecorder: Pick<TerminalPerformanceRecorder, "persistNow">,
): () => void {
  const persist = () => {
    performanceRecorder.persistNow();
  };
  target.addEventListener("pagehide", persist);
  return () => target.removeEventListener("pagehide", persist);
}

let appRecorder: TerminalPerformanceRecorder | null | undefined;

function recorder(): TerminalPerformanceRecorder | null {
  if (appRecorder !== undefined) {
    return appRecorder;
  }
  if (!isTauri()) {
    appRecorder = null;
    return null;
  }
  appRecorder = createTerminalPerformanceRecorder({
    storage: resolveLocalStorage(),
    setTimeout: defaultScheduler.setTimeout,
    clearTimeout: defaultScheduler.clearTimeout,
  });
  if (typeof window !== "undefined") {
    installTerminalPerformanceLifecyclePersistence(window, appRecorder);
  }
  return appRecorder;
}

export function setTerminalPerformancePreferences(
  mode: TerminalRenderMode,
  selectedPaneRealtime: boolean,
): void {
  const current = recorder();
  current?.setMode(mode);
  current?.setSelectedPaneRealtime(selectedPaneRealtime);
}

export function registerTerminalPerformancePane(): () => void {
  return recorder()?.registerPane() ?? (() => undefined);
}

export function recordTerminalPerformanceFrame(frame: TerminalPerformanceFrame): void {
  recorder()?.recordFrame(frame);
}

export function recordTerminalPerformanceWrite(write: TerminalPerformanceWrite): void {
  recorder()?.recordWrite(write);
}
