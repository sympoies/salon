import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { SessionRefreshOutcome } from "./sessionRefresh.ts";

export type { SessionRefreshOutcome } from "./sessionRefresh.ts";

export const SESSION_REFRESHED_MESSAGE = "Session info updated";

export interface SessionRefreshTarget {
  readonly machine: string;
  readonly id: string;
}

/** Progress of the hook's own refresh; `message` is ready for a transient notice. */
export type SessionRefreshState =
  | { readonly status: "idle" }
  | { readonly status: "refreshing" }
  | { readonly status: "updated"; readonly message: string; readonly changed: readonly string[] }
  | { readonly status: "failed"; readonly message: string };

export interface SessionRefreshControl {
  /** Re-reads one session on its host and applies the refreshed record to the dashboard. */
  refresh(target: SessionRefreshTarget): Promise<SessionRefreshOutcome>;
}

/** The dashboard provides this; outside it, a refresh fails without a request. */
export const SessionRefreshContext = createContext<SessionRefreshControl>({
  refresh: async () => ({ ok: false, message: "Session refresh is unavailable here." }),
});

/**
 * Extension point for refreshing one session's info on demand, for example from
 * a role-icon tap. `refresh` resolves with the final state; a call made while
 * one is running shares it. Nothing runs in the background.
 */
export function useSessionRefresh(): {
  readonly state: SessionRefreshState;
  refresh(target: SessionRefreshTarget): Promise<SessionRefreshState>;
} {
  const control = useContext(SessionRefreshContext);
  const [state, setState] = useState<SessionRefreshState>({ status: "idle" });
  const running = useRef<Promise<SessionRefreshState> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = useCallback((target: SessionRefreshTarget) => {
    if (running.current) return running.current;
    setState({ status: "refreshing" });
    const run = control.refresh(target).then((outcome): SessionRefreshState => {
      const done: SessionRefreshState = outcome.ok
        ? { status: "updated", message: SESSION_REFRESHED_MESSAGE, changed: outcome.changed }
        : { status: "failed", message: outcome.message };
      if (mounted.current) setState(done);
      return done;
    }).finally(() => { running.current = null; });
    running.current = run;
    return run;
  }, [control]);
  return { state, refresh };
}
