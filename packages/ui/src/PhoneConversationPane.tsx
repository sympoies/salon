import { SharedOutgoingReplies } from "./SharedOutgoingReplies.tsx";
import { useCallback, useEffect, useState, type MutableRefObject, type TouchEvent as ReactTouchEvent } from "react";
import { ConversationComposer, type ConversationRecovery, type ConversationReplyDrafts } from "./ConversationComposer.tsx";
import { conversationTurnWorking, HistoryConversationView } from "./HistoryConversation.tsx";
import { OutgoingReplies } from "./OutgoingReplies.tsx";
import { sessionLabel } from "./format.ts";
import type { SessionSwipeDirection } from "./sessionSwipe.ts";
import { useLiveConversation } from "./useLiveConversation.ts";
import { useSessionSwipe } from "./useSessionSwipe.ts";
import type { Session } from "./types.ts";

// A drag that starts inside wide code or a table scrolls that block, not the
// session list.
function startsInHorizontalScroller(target: EventTarget | null, boundary: Element): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== boundary; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const overflowX = window.getComputedStyle(node).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

function hasTextSelection(): boolean {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed);
}

/**
 * The phone Conversation body of a focused session (#892).
 * The session header stays the focused slot's own, so only history, composer
 * and the horizontal session swipe live here.
 */
export function PhoneConversationPane({ session, machineReachable, replyDrafts, recovery, onTerminal, swipeEnabled, onSwipe, onBusyChange, refreshRef }: {
  readonly session: Session;
  /** The Dashboard's resume of this session, for a stopped one (#921). */
  readonly recovery?: ConversationRecovery;
  /** The switch to this session's terminal, for a turn that may be stuck (#921). */
  readonly onTerminal?: () => void;
  readonly machineReachable: boolean;
  readonly replyDrafts?: ConversationReplyDrafts;
  readonly swipeEnabled: boolean;
  readonly onSwipe: (direction: SessionSwipeDirection) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  /** Receives the header Refresh action for this conversation. */
  readonly refreshRef: MutableRefObject<(() => void) | null>;
}) {
  const [sending, setSending] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const busy = sending || voiceOpen;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const { conversation, providerSessionId, error, resolving } = useLiveConversation(session, {
    machineReachable, paused: voiceOpen,
  });
  const { session: historySession, latestMessagePaging, open: openConversation, refreshLatest } = conversation;
  useEffect(() => {
    refreshRef.current = historySession ? () => void refreshLatest() : null;
    return () => { refreshRef.current = null; };
  }, [historySession, refreshLatest, refreshRef]);
  const jumpToLatest = useCallback(() => {
    if (historySession) void openConversation(historySession, latestMessagePaging);
  }, [historySession, latestMessagePaging, openConversation]);
  const swipe = useSessionSwipe(swipeEnabled && !busy, onSwipe);
  const swipeHandlers = swipe ? {
    ...swipe,
    onTouchStart: (event: ReactTouchEvent) => {
      if (startsInHorizontalScroller(event.target, event.currentTarget)) swipe.onTouchCancel(event);
      else swipe.onTouchStart(event);
    },
    onTouchEnd: (event: ReactTouchEvent) => {
      if (hasTextSelection()) swipe.onTouchCancel(event);
      else swipe.onTouchEnd(event);
    },
  } : {};

  const outgoing = <><OutgoingReplies session={session} messages={conversation.messages} /><SharedOutgoingReplies session={session} messages={conversation.messages} /></>;
  return (
    // A double-click selects history text; it never toggles the focused session.
    <div className="phone-conversation-pane" onDoubleClick={(event) => event.stopPropagation()}>
      {error ? <div className="history-error" role="alert">{error}</div> : null}
      <section className="history-viewer phone-conversation-viewer" aria-label={`Conversation for ${sessionLabel(session)}`}
        {...swipeHandlers}>
        {!providerSessionId ? (<>
          <p className="history-empty">
            This session has not reported a provider session ID yet. Its conversation appears here once the agent does.
          </p>
          {outgoing}
        </>) : historySession ? (
          <HistoryConversationView conversation={conversation} uploadSessionId={session.id} working={conversationTurnWorking(session.turn_state)} onJumpToLatest={jumpToLatest}
            outgoing={outgoing} />
        ) : (<>
          {resolving ? <p className="history-empty">Finding this session in history…</p> : null}
          {outgoing}
        </>)}
      </section>
      <ConversationComposer session={session} machineReachable={machineReachable} replyDrafts={replyDrafts} messages={conversation.messages}
        messagesReady={conversation.messagesLoaded && !resolving && !conversation.loading && !conversation.browsingOlder && conversation.messagePage === 0} recovery={recovery} onTerminal={onTerminal}
        onBusyChange={setSending} onVoiceOpenChange={setVoiceOpen} />
    </div>
  );
}
