import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { Reachable } from "./api.ts";
import { useAsyncPoll, type AsyncPollTick } from "./useAsyncPoll.ts";

export interface ReachablePollState<Data> {
  readonly data: Data;
  readonly reachable: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: (tick?: AsyncPollTick, fresh?: boolean) => Promise<void>;
}

export interface ReachablePollOptions<Result extends Reachable, Data> {
  readonly fetcher: (tick?: AsyncPollTick) => Promise<Result>;
  readonly selectData: (result: Result) => Data;
  readonly delayMs: number;
  readonly initialData: Data;
  readonly initialLoaded?: boolean;
  readonly initialReachable?: boolean;
  readonly initialError?: string | null;
  readonly retainDataWhenUnreachable?: boolean;
  readonly onSuccess?: (result: Result) => void;
}

export interface ReachablePollSink<Data> {
  readonly setData: (data: Data) => void;
  readonly setReachable: (reachable: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly setLoaded: (loaded: boolean) => void;
}

export interface ReachablePollRefreshOptions<Result extends Reachable, Data> {
  readonly fetcher: (tick?: AsyncPollTick) => Promise<Result>;
  readonly selectData: (result: Result) => Data;
  readonly isCurrent: () => boolean;
  readonly sink: ReachablePollSink<Data>;
  readonly tick?: AsyncPollTick;
  readonly retainDataWhenUnreachable?: boolean;
  readonly onSuccess?: (result: Result) => void;
}

export function hostReaderUnavailableText(label: string, error?: string | null): string {
  const message = `${label} is unavailable`;
  return error ? `${message}: ${error}` : `${message}.`;
}

export function HostReaderUnavailable({
  label,
  error,
}: {
  readonly label: string;
  readonly error?: string | null;
}) {
  return createElement("p", { className: "banner warn" }, hostReaderUnavailableText(label, error));
}

export async function runReachablePollRefresh<Result extends Reachable, Data>({
  fetcher,
  selectData,
  isCurrent,
  sink,
  tick,
  retainDataWhenUnreachable = false,
  onSuccess,
}: ReachablePollRefreshOptions<Result, Data>): Promise<void> {
  try {
    const result = await fetcher(tick);
    if (!isCurrent()) {
      return;
    }
    onSuccess?.(result);
    if (result.reachable || !retainDataWhenUnreachable) {
      sink.setData(selectData(result));
    }
    sink.setReachable(result.reachable);
    sink.setError(result.error ?? null);
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    sink.setReachable(false);
    sink.setError(err instanceof Error ? err.message : String(err));
  } finally {
    if (isCurrent()) {
      sink.setLoaded(true);
    }
  }
}

export function useReachablePoll<Result extends Reachable, Data>({
  fetcher,
  selectData,
  delayMs,
  initialData,
  initialLoaded = false,
  initialReachable = true,
  initialError = null,
  retainDataWhenUnreachable = false,
  onSuccess,
}: ReachablePollOptions<Result, Data>): ReachablePollState<Data> {
  const [data, setData] = useState<Data>(initialData);
  const [reachable, setReachable] = useState(initialReachable);
  const [loaded, setLoaded] = useState(initialLoaded);
  const [error, setError] = useState<string | null>(initialError);
  const liveRef = useRef(true);

  const inFlightRef = useRef<{ promise: Promise<void>; controller: AbortController } | null>(null);
  const refresh = useCallback((tick?: AsyncPollTick, fresh = false): Promise<void> => {
    if (inFlightRef.current) {
      // A write reconciliation must read after the write, even if an older
      // background snapshot is still arriving. Ordinary polls join it.
      return fresh ? inFlightRef.current.promise.then(() => refresh(tick, true)) : inFlightRef.current.promise;
    }
    if (!liveRef.current) return Promise.resolve();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (tick?.signal.aborted) return Promise.resolve();
    tick?.signal.addEventListener("abort", abort, { once: true });
    const isCurrent = () => liveRef.current && !controller.signal.aborted && (tick?.isCurrent() ?? true);
    const promise = Promise.resolve().then(() => {
      if (!isCurrent()) return;
      return runReachablePollRefresh({
      fetcher,
      selectData,
      isCurrent,
      sink: {
        setData,
        setReachable,
        setError,
        setLoaded,
      },
      tick: { signal: controller.signal, isCurrent, fresh },
      retainDataWhenUnreachable,
      onSuccess,
      });
    }).finally(() => {
      tick?.signal.removeEventListener("abort", abort);
      if (inFlightRef.current?.controller === controller) inFlightRef.current = null;
    });
    inFlightRef.current = { promise, controller };
    return promise;
  }, [fetcher, onSuccess, retainDataWhenUnreachable, selectData]);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      inFlightRef.current?.controller.abort();
      inFlightRef.current = null;
    };
  }, []);

  useAsyncPoll(refresh, delayMs);

  return { data, reachable, loaded, error, refresh };
}
