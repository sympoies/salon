import type { AnimationFrameScheduler, TimeoutScheduler } from "./scheduler.ts";

export type TerminalLayoutSyncScheduler<FrameHandle, TimerHandle> =
  AnimationFrameScheduler<FrameHandle> & TimeoutScheduler<TimerHandle>;

export interface TerminalLayoutSyncHandle {
  readonly request: () => void;
  readonly dispose: () => void;
}

export interface FirstPayloadSyncState {
  pending: boolean;
}

export function createTerminalLayoutSync<FrameHandle, TimerHandle>(
  scheduler: TerminalLayoutSyncScheduler<FrameHandle, TimerHandle>,
  sync: () => void,
  settleDelayMs = 50,
): TerminalLayoutSyncHandle {
  let layoutFrame: FrameHandle | undefined;
  let layoutSettleTimer: TimerHandle | undefined;

  const request = () => {
    if (layoutFrame !== undefined) {
      scheduler.cancelAnimationFrame(layoutFrame);
    }
    if (layoutSettleTimer !== undefined) {
      scheduler.clearTimeout(layoutSettleTimer);
      layoutSettleTimer = undefined;
    }
    layoutFrame = scheduler.requestAnimationFrame(() => {
      layoutFrame = undefined;
      sync();
      layoutSettleTimer = scheduler.setTimeout(() => {
        layoutSettleTimer = undefined;
        sync();
      }, settleDelayMs);
    });
  };

  const dispose = () => {
    if (layoutFrame !== undefined) {
      scheduler.cancelAnimationFrame(layoutFrame);
      layoutFrame = undefined;
    }
    if (layoutSettleTimer !== undefined) {
      scheduler.clearTimeout(layoutSettleTimer);
      layoutSettleTimer = undefined;
    }
  };

  return { request, dispose };
}

export function shouldRequestFirstPayloadSync(
  state: FirstPayloadSyncState,
  wroteData: boolean,
): boolean {
  if (!wroteData || !state.pending) {
    return false;
  }
  state.pending = false;
  return true;
}
