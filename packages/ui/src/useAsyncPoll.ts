import { useEffect } from "react";
import { defaultScheduler, type TimeoutScheduler, type TimerHandle as DefaultTimerHandle } from "./scheduler.ts";

export interface AsyncPollTick {
  readonly signal: AbortSignal;
  readonly fresh?: boolean;
  isCurrent(): boolean;
}

export type AsyncPollTask = (tick: AsyncPollTick) => Promise<void> | void;

export interface AsyncPoller {
  start(): void;
  stop(): void;
}

export interface AsyncPollerOptions<TimerHandle = DefaultTimerHandle> {
  readonly delayMs: number | (() => number);
  readonly task: AsyncPollTask;
  readonly setTimeout?: TimeoutScheduler<TimerHandle>["setTimeout"];
  readonly clearTimeout?: TimeoutScheduler<TimerHandle>["clearTimeout"];
  readonly onError?: (error: unknown) => void;
}

export function createAsyncPoller<TimerHandle = DefaultTimerHandle>({
  delayMs,
  task,
  setTimeout = defaultScheduler.setTimeout as TimeoutScheduler<TimerHandle>["setTimeout"],
  clearTimeout = defaultScheduler.clearTimeout as TimeoutScheduler<TimerHandle>["clearTimeout"],
  onError,
}: AsyncPollerOptions<TimerHandle>): AsyncPoller {
  let active = false;
  let generation = 0;
  let timer: TimerHandle | null = null;
  let controller: AbortController | null = null;

  const clearScheduled = () => {
    if (timer === null) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  };

  const run = async () => {
    if (!active) {
      return;
    }

    const tickGeneration = generation;
    const tickController = new AbortController();
    controller = tickController;

    const tick: AsyncPollTick = {
      signal: tickController.signal,
      isCurrent: () =>
        active &&
        generation === tickGeneration &&
        controller === tickController &&
        !tickController.signal.aborted,
    };

    try {
      await task(tick);
    } catch (error) {
      if (tick.isCurrent()) {
        onError?.(error);
      }
    }

    if (tick.isCurrent()) {
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, typeof delayMs === "function" ? delayMs() : delayMs);
    }
  };

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      void run();
    },
    stop() {
      if (!active && timer === null && controller === null) {
        return;
      }
      active = false;
      generation += 1;
      clearScheduled();
      controller?.abort();
      controller = null;
    },
  };
}

export function useAsyncPoll(task: AsyncPollTask, delayMs: number, onError?: (error: unknown) => void): void {
  useEffect(() => {
    const poller = createAsyncPoller({ task, delayMs, onError });
    poller.start();
    return () => poller.stop();
  }, [delayMs, onError, task]);
}
