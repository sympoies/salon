import { SharedOutgoingReplies } from "./SharedOutgoingReplies.tsx";
import { IconButton } from "./IconButton.tsx";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AgentBadge } from "./AgentBadge.tsx";
import { resolveDashboardShortcutAction } from "./dashboardShortcuts.ts";
import { sessionLabel } from "./format.ts";
import { conversationTurnWorking, HistoryConversationView } from "./HistoryConversation.tsx";
import { OutgoingReplies } from "./OutgoingReplies.tsx";
import { useLiveConversation } from "./useLiveConversation.ts";
import { CloseIcon, RefreshIcon, ReplyIcon } from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import { ConversationComposer, type ConversationRecovery, type ConversationReplyDrafts } from "./ConversationComposer.tsx";
import { sessionKey } from "./layout.ts";
import { isMacTauri } from "./runtime.ts";
import type { Session } from "./types.ts";

/**
 * The user/assistant record of a live session, read from its provider history.
 * The terminal stays the view for following agent actions; this panel is the
 * clean read of what was asked and reported.
 */
export function LiveConversationPanel({ session, onClose, machineReachable = true, onBusyChange, replyDrafts, recovery, docked = false, showComposer = false, onTerminal }: {
  readonly session: Session;
  /** The Dashboard's resume of this session, for a stopped one (#921). */
  readonly recovery?: ConversationRecovery;
  readonly onClose: () => void;
  readonly machineReachable?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly replyDrafts?: ConversationReplyDrafts;
  readonly docked?: boolean;
  readonly showComposer?: boolean;
  readonly onTerminal?: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // A narrow panel keeps the reply editor collapsed until asked for, unless a
  // saved draft is waiting; the docked panel always shows it.
  const [composerOpen, setComposerOpen] = useState(() => replyDrafts?.has(sessionKey(session)) ?? false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Narrowing out of the dock keeps an active draft or send in view.
  const wasDocked = useRef(docked);
  useEffect(() => {
    if (wasDocked.current && !docked && (sending || replyDrafts?.has(sessionKey(session)))) setComposerOpen(true);
    wasDocked.current = docked;
  }, [docked, replyDrafts, sending, session]);
  const wasComposerOpen = useRef(composerOpen);
  useEffect(() => {
    if (!wasComposerOpen.current && composerOpen) panelRef.current?.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")?.focus();
    wasComposerOpen.current = composerOpen;
  }, [composerOpen]);
  const wasVoiceOpen = useRef(false);
  useEffect(() => {
    onBusyChange?.(sending || voiceOpen);
    return () => onBusyChange?.(false);
  }, [onBusyChange, sending, voiceOpen]);
  useEffect(() => {
    if (wasVoiceOpen.current && !voiceOpen) panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    wasVoiceOpen.current = voiceOpen;
  }, [voiceOpen]);
  const close = useCallback(() => {
    if (!sending && !voiceOpen) onClose();
  }, [onClose, sending, voiceOpen]);
  const { conversation, providerSessionId, label, error, resolving } = useLiveConversation(session, {
    machineReachable, paused: voiceOpen,
  });
  const openConversation = conversation.open;
  const refreshRef = useRef(conversation.refreshLatest);
  refreshRef.current = conversation.refreshLatest;

  // Refresh reads the newest messages now instead of waiting for the poll.
  // While one runs the button is aria-disabled rather than disabled, so a
  // keyboard user keeps focus inside the dialog.
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshNow = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  const { session: historySession, latestMessagePaging } = conversation;
  const jumpToLatest = useCallback(() => {
    if (historySession) void openConversation(historySession, latestMessagePaging);
  }, [historySession, latestMessagePaging, openConversation]);

  // The dashboard shortcut layer ignores keys from inside a dialog, so the
  // panel answers the Cmd+Y that opened it itself.
  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveDashboardShortcutAction({
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isMacTauri: isMacTauri(),
      editableTarget: false,
    });
    if (action !== "conversation") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, [close]);

  const outgoing = <><OutgoingReplies session={session} messages={conversation.messages} /><SharedOutgoingReplies session={session} /></>;
  return (
    <div ref={panelRef} hidden={voiceOpen}>
    <Modal
      androidBackEntry="session-conversation"
      modal={!docked}
      className={docked ? "conversation-modal conversation-dock" : "conversation-modal"}
      backdropClassName={docked ? "conversation-backdrop conversation-dock-backdrop" : "conversation-backdrop"}
      ariaLabelledby="conversation-title"
      onClose={close}
      busy={sending}
      onDialogKeyDown={onDialogKeyDown}
    >
      <header className="history-head conversation-head">
        <div>
          <h2 id="conversation-title">
            <AgentBadge agent={session.agent} decorative />
            <span>{sessionLabel(session)}</span>
          </h2>
          <p>{label} conversation on {session.machine}</p>
        </div>
        <div className="conversation-head-actions">
          <IconButton type="button" className={refreshing ? "btn icon-btn conversation-refresh is-busy" : "btn icon-btn conversation-refresh"}
            aria-label="Refresh conversation" title="Refresh" aria-busy={refreshing} aria-disabled={refreshing}
            disabled={!historySession} onClick={() => void refreshNow()}>
            <RefreshIcon />
          </IconButton>
          {onTerminal ? <button type="button" className="btn" aria-label="Switch to terminal"
            disabled={sending || voiceOpen} onClick={onTerminal}>Terminal</button> : null}
          {docked || showComposer ? null : (
            <IconButton type="button" className="btn icon-btn conversation-reply-toggle" aria-label="Reply" title="Reply"
              aria-expanded={composerOpen} aria-controls="conversation-composer"
              onClick={() => setComposerOpen((open) => !open)}>
              <ReplyIcon />
            </IconButton>
          )}
          <IconButton type="button" className="btn icon-btn" aria-label="Close conversation" title="Close" disabled={sending}
            onClick={close}>
            <CloseIcon />
          </IconButton>
        </div>
      </header>
      {error ? <div className="history-error" role="alert">{error}</div> : null}
      <section className="history-viewer conversation-viewer" aria-label="Conversation">
        {!providerSessionId ? (<>
          <p className="history-empty">
            This session has not reported a provider session ID yet. Its conversation appears here once the agent does.
          </p>
          {outgoing}
        </>) : conversation.session ? (
          <HistoryConversationView conversation={conversation} working={conversationTurnWorking(session.turn_state)} onJumpToLatest={jumpToLatest}
            outgoing={outgoing} />
        ) : (<>
          {resolving ? <p className="history-empty">Finding this session in history…</p> : null}
          {outgoing}
        </>)}
      </section>
      <ConversationComposer session={session} machineReachable={machineReachable} replyDrafts={replyDrafts} messages={conversation.messages}
        messagesReady={conversation.messagesLoaded && !resolving && !conversation.loading && !conversation.browsingOlder && conversation.messagePage === 0} recovery={recovery} onTerminal={onTerminal}
        hidden={!docked && !showComposer && !composerOpen} onBusyChange={setSending} onVoiceOpenChange={setVoiceOpen} />
    </Modal>
    </div>
  );
}
