import { useEffect, useRef, useState } from "react";
import { listHistorySessions } from "./api.ts";
import { findHistoryEntry } from "./historyResumeById.ts";
import { useHistoryConversation } from "./HistoryConversation.tsx";
import { conversationOutbox } from "./conversationOutbox.ts";
import { createAsyncPoller } from "./useAsyncPoll.ts";
import { useResourceEvents } from "./useResourceEvents.ts";
import { RESOURCE_RECONCILE_MS } from "./resourceEvents.ts";
import { resourceKey } from "@agent-console/shared/resources";
import type { Session } from "./types.ts";

function providerLabel(session: Session): string {
  const provider = session.provider_resume?.provider ?? session.agent;
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider === "dsh" ? "DSH" : provider;
}

/** Shared live-session history reader for the full panel and desktop tiles. */
export function useLiveConversation(session: Session, {
  machineReachable = true, paused = false,
}: { readonly machineReachable?: boolean; readonly paused?: boolean } = {}) {
  const [error, setError] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const conversation = useHistoryConversation(setError);
  const openConversation = conversation.open;
  const providerSessionId = session.provider_resume?.session_id;
  const label = providerLabel(session);

  useEffect(() => {
    if (!providerSessionId) return;
    let cancelled = false;
    setResolving(true);
    setError(undefined);
    void findHistoryEntry(session.machine, { providerSessionId, label }, listHistorySessions)
      .catch((cause: Error) => ({ ok: false as const, error: cause.message }))
      .then(async (found) => {
        if (cancelled) return;
        setResolving(false);
        if (!found.ok) {
          setError(found.error);
          return;
        }
        await openConversation(found.session, found.latestMessagePaging);
      });
    return () => {
      cancelled = true;
    };
  }, [label, openConversation, providerSessionId, session.machine]);

  // A reply this browser sent is delivered once the transcript shows it (#969).
  const messages = conversation.messages;
  useEffect(() => {
    if (messages.length > 0) void conversationOutbox().confirmFromTranscript(session, messages).catch(() => {});
  }, [messages, session]);

  // Turn completion refreshes immediately; periodic reads also pick up input
  // sent through the independently usable terminal.
  const completedAt = session.turn_state?.last_turn?.completed_at;
  const applyLatestRef = useRef(conversation.applyLatest);
  applyLatestRef.current = conversation.applyLatest;
  const refreshRef = useRef(conversation.refreshLatest);
  refreshRef.current = conversation.refreshLatest;
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

  return { conversation, providerSessionId, label, error, resolving };
}
