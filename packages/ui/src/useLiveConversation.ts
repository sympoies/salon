import { useEffect, useRef, useState } from "react";
import { listHistorySessions } from "./api.ts";
import { findHistoryEntry, type HistoryEntryResolution } from "./historyResumeById.ts";
import { useHistoryConversation } from "./HistoryConversation.tsx";
import { createAsyncPoller } from "./useAsyncPoll.ts";
import { useResourceEvents } from "./useResourceEvents.ts";
import { RESOURCE_RECONCILE_MS } from "./resourceEvents.ts";
import { resourceKey } from "@agent-console/shared/resources";
import type { Session } from "./types.ts";

/**
 * The service's history snapshot is cached, so a just-created session can be missing from it for a
 * while. A running session that has not matched yet shows a waiting state for this long before the
 * miss is reported as an error.
 */
const HISTORY_WAIT_MS = 60_000;

function providerLabel(session: Session): string {
  const provider = session.provider_resume?.provider ?? session.agent;
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider;
}

/** Shared live-session history reader for the full panel and desktop tiles. */
export function useLiveConversation(session: Session, {
  machineReachable = true, paused = false,
}: { readonly machineReachable?: boolean; readonly paused?: boolean } = {}) {
  const [error, setError] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const statusRef = useRef(session.status);
  statusRef.current = session.status;
  const conversation = useHistoryConversation(setError);
  const openConversation = conversation.open;
  const resetConversation = conversation.reset;
  const providerSessionId = session.provider_resume?.session_id;
  const label = providerLabel(session);
  const latestRef = useRef(conversation.refreshLatest);
  latestRef.current = conversation.refreshLatest;
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    resetConversation();
    setResolving(false);
    setWaiting(false);
    setError(undefined);
    if (!providerSessionId) return;
    let cancelled = false;
    let firstMissAt: number | undefined;
    let searching = false;
    let bound = false;
    // The first transcript may appear after this view opens. Reuse ordinary
    // refresh triggers for discovery until bound, then only refresh messages.
    const refresh = async () => {
      if (cancelled) return;
      if (bound) return latestRef.current();
      if (searching) return;
      searching = true;
      setResolving(true);
      try {
        const found = await findHistoryEntry(session.machine, { providerSessionId, label }, listHistorySessions)
          .catch((cause: Error): HistoryEntryResolution => ({ ok: false, error: cause.message }));
        if (cancelled) return;
        if (!found.ok) {
          // A running session's first transcript can lag the cached history snapshot: wait and keep
          // retrying instead of reporting a miss. A true miss (not running, past the window, or a
          // failed or limited search) keeps the error.
          firstMissAt ??= Date.now();
          if (found.notFound && statusRef.current === "running" && Date.now() - firstMissAt < HISTORY_WAIT_MS) {
            setWaiting(true);
            setError(undefined);
            return;
          }
          setWaiting(false);
          setError(found.error);
          return;
        }
        bound = true;
        setWaiting(false);
        await openConversation(found.session, found.latestMessagePaging);
      } finally {
        searching = false;
        if (!cancelled) setResolving(false);
      }
    };
    refreshRef.current = refresh;
    void refresh();
    return () => {
      cancelled = true;
      resetConversation();
    };
  }, [label, openConversation, resetConversation, providerSessionId, session.machine]);

  // A session that stops while waiting for its first history row is no longer expected to appear
  // soon: look once more so the miss is reported (or the row found) without a focus change.
  useEffect(() => {
    if (waiting && session.status !== "running") void refreshRef.current();
  }, [waiting, session.status]);

  // Turn completion refreshes immediately; periodic reads also pick up input
  // sent through the independently usable terminal.
  const completedAt = session.turn_state?.last_turn?.completed_at;
  const applyLatestRef = useRef(conversation.applyLatest);
  applyLatestRef.current = conversation.applyLatest;
  const pollingPausedRef = useRef(false);
  pollingPausedRef.current = conversation.loading || conversation.browsingOlder
    || (!conversation.latestMessagePaging && conversation.messagePage > 0);
  const conversationHealthy = useResourceEvents(
    machineReachable && session.status === "running" && !paused && conversation.session && !conversation.browsingOlder
      && (conversation.latestMessagePaging || conversation.messagePage === 0)
      ? { resource: "conversation", machine: conversation.session.machine, id: conversation.session.id } : null,
    (event) => {
      if (event && (!conversation.session || event.resource !== resourceKey({ resource: "conversation",
        machine: conversation.session.machine, id: conversation.session.id }))) return;
      if (event?.conversation && applyLatestRef.current(event.conversation)) return;
      if (!conversation.browsingOlder && (conversation.latestMessagePaging || conversation.messagePage === 0)) {
        void refreshRef.current();
      }
    },
  );
  useEffect(() => {
    if (!machineReachable || session.status !== "running" || paused) return;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pollingPausedRef.current) return;
      await refreshRef.current();
    };
    const poller = createAsyncPoller({ delayMs: conversationHealthy ? RESOURCE_RECONCILE_MS : 3000, task: refresh,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer) });
    poller.start();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      poller.stop();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [machineReachable, session.status, paused, conversationHealthy]);
  const seenCompletedAtRef = useRef(completedAt);
  useEffect(() => {
    if (seenCompletedAtRef.current === completedAt) return;
    seenCompletedAtRef.current = completedAt;
    void refreshRef.current();
  }, [completedAt]);

  return { conversation, providerSessionId, label, error, resolving: resolving || waiting };
}
