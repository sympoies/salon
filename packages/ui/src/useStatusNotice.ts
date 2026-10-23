import { useEffect, useRef, useState } from "react";
import { defaultScheduler, type TimeoutScheduler } from "./scheduler.ts";
import {
  attentionStatusNotice,
  hostFailureHosts,
  hostOfflineNotice,
  HOST_OFFLINE_REPEAT_MS,
  restoredStatusNotice,
  STARTUP_GRACE_MS,
  statusNoticeAutoDismissDelay,
  unreachableStatusNotice,
  type StatusNotice,
} from "./statusNotice.ts";

export interface StatusNoticeOptions {
  /** Clock for the repeat window; defaults to Date.now. */
  readonly now?: () => number;
  /** When provided, host-offline toasts wait for the first successful load and the startup grace. */
  readonly loaded?: boolean;
  /** Known machine names; a host toast is accepted only for these. */
  readonly machines?: readonly string[];
}

export function useStatusNotice<Timer = ReturnType<typeof globalThis.setTimeout>>(
  error: string | null,
  scheduler: TimeoutScheduler<Timer> = defaultScheduler as unknown as TimeoutScheduler<Timer>,
  options: StatusNoticeOptions = {},
): { readonly notice: StatusNotice | null; readonly dismiss: () => void } {
  const [notice, setNotice] = useState<StatusNotice | null>(null);
  const lastError = useRef<string | null>(null);
  const currentNotice = useRef<StatusNotice | null>(notice);
  currentNotice.current = notice;
  const now = options.now ?? Date.now;
  const graceEnabled = options.loaded !== undefined;
  const loaded = options.loaded ?? true;
  const [graceElapsed, setGraceElapsed] = useState(false);
  const lastHostToast = useRef(new Map<string, number>());
  const machinesKey = (options.machines ?? []).join("\u0000");

  useEffect(() => {
    if (!graceEnabled || graceElapsed) return;
    const timer = scheduler.setTimeout(() => setGraceElapsed(true), STARTUP_GRACE_MS);
    return () => scheduler.clearTimeout(timer);
  }, [graceEnabled, graceElapsed, scheduler]);

  const inGrace = graceEnabled && (!loaded || !graceElapsed);

  useEffect(() => {
    if (error) {
      lastError.current = error;
      const hosts = hostFailureHosts(error, machinesKey ? machinesKey.split("\u0000") : []);
      if (hosts) {
        if (inGrace) { setNotice(null); return; }
        const at = now();
        const fresh = hosts.some(host => {
          const last = lastHostToast.current.get(host);
          return last === undefined || at - last >= HOST_OFFLINE_REPEAT_MS;
        });
        if (!fresh) { setNotice(null); return; }
        for (const host of hosts) lastHostToast.current.set(host, at);
        setNotice(hostOfflineNotice(error));
        return;
      }
      setNotice(error.startsWith("Console server is unreachable")
        ? unreachableStatusNotice(error)
        : attentionStatusNotice(error));
      return;
    }
    const previous = lastError.current;
    lastError.current = null;
    setNotice(previous?.startsWith("Console server is unreachable") ? restoredStatusNotice() : null);
  }, [error, inGrace, machinesKey, now]);

  useEffect(() => {
    const delay = statusNoticeAutoDismissDelay(notice);
    if (delay === null) return;
    const timer = scheduler.setTimeout(() => {
      setNotice((current) => current === notice ? null : current);
    }, delay);
    return () => scheduler.clearTimeout(timer);
  }, [notice, scheduler]);

  return { notice, dismiss: () => setNotice(null) };
}
