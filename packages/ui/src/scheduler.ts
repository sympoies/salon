export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type IntervalHandle = ReturnType<typeof globalThis.setInterval>;
type FrameHandle = number | TimerHandle;

export interface TimeoutScheduler<Timer = TimerHandle> {
  readonly setTimeout: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout: (handle: Timer) => void;
}

interface IntervalScheduler<Interval = IntervalHandle> {
  readonly setInterval: (callback: () => void, delayMs: number) => Interval;
  readonly clearInterval: (handle: Interval) => void;
}

export interface AnimationFrameScheduler<Frame = FrameHandle> {
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => Frame;
  readonly cancelAnimationFrame: (handle: Frame) => void;
}

export type Scheduler<
  Frame = FrameHandle,
  Timer = TimerHandle,
  Interval = IntervalHandle,
> = TimeoutScheduler<Timer> & IntervalScheduler<Interval> & AnimationFrameScheduler<Frame>;

export interface WindowSchedulerTarget<Frame, Timer, Interval> {
  readonly setTimeout: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout: (handle: Timer) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => Interval;
  readonly clearInterval: (handle: Interval) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => Frame;
  readonly cancelAnimationFrame: (handle: Frame) => void;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function requestFrame(callback: FrameRequestCallback): FrameHandle {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(nowMs()), 16);
}

function cancelFrame(handle: FrameHandle): void {
  if (typeof globalThis.cancelAnimationFrame === "function" && typeof handle === "number") {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle as TimerHandle);
}

export const defaultScheduler: Scheduler = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: cancelFrame,
};

export function createWindowScheduler<Frame, Timer, Interval>(
  target: WindowSchedulerTarget<Frame, Timer, Interval>,
): Scheduler<Frame, Timer, Interval> {
  return {
    setTimeout: target.setTimeout.bind(target),
    clearTimeout: target.clearTimeout.bind(target),
    setInterval: target.setInterval.bind(target),
    clearInterval: target.clearInterval.bind(target),
    requestAnimationFrame: target.requestAnimationFrame.bind(target),
    cancelAnimationFrame: target.cancelAnimationFrame.bind(target),
  };
}
