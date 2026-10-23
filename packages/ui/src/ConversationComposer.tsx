import { useSharedOutbox, usesSharedOutbox } from "./sharedOutboxClient.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { conversationOutbox, queuedReplyDeliverablePhase, queuedReplyTargetAllowed, useConversationOutbox } from "./conversationOutbox.ts";
import { uploadAttachment } from "./api.ts";
import { ConversationAttachIcon, ConversationMicIcon, ConversationSendIcon } from "./icons.tsx";
import { shellQuotePathForTerminal } from "./shellQuote.ts";
import { isMacTauri } from "./runtime.ts";
import { filesFromTerminalClipboardData, terminalClipboardActionErrorMessage, terminalPasteEventAction } from "./terminalClipboard.ts";
import { isMacosFilePasteCandidate, readMacosClipboardFiles } from "./terminalNativeClipboard.ts";
import { SpeechComposer } from "./SpeechComposer.tsx";
import { parseTurnStateV1 } from "./sessionActivity.ts";
import { isSessionResumeAvailable, sessionLabel } from "./format.ts";
import { sessionKey } from "./layout.ts";
import { SILENT_TURN_MS, silentTurnMinutes, stuckTurn } from "./stuckTurn.ts";
import type { HistoryMessage, Session } from "./types.ts";

// A working session queues replies; the message list shows Working (#942).
const BUSY_REPLY_HINT = "busy";

const UNKNOWN_REPLY_OUTCOME = "The reply may have been sent. A busy session shows it as a queued message; check the session before trying again.";

export interface ConversationReplyDraft {
  readonly text: string;
  readonly incarnation: string | undefined;
  readonly error: string;
  readonly outcomeUnknown: boolean;
  readonly sending?: boolean;
}
export type ConversationReplyDrafts = Map<string, ConversationReplyDraft>;
export interface ConversationRecovery { onRecover(): void; readonly pending: boolean }

// Each dashboard owns its draft map. Subscribers share pending/unknown state
// synchronously, including when a tile and the full pane coexist or remount.
const draftListeners = new WeakMap<ConversationReplyDrafts, Map<string, Set<() => void>>>();

function subscribeDraft(drafts: ConversationReplyDrafts, key: string, listener: () => void) {
  let keys = draftListeners.get(drafts);
  if (!keys) { keys = new Map(); draftListeners.set(drafts, keys); }
  let listeners = keys.get(key);
  if (!listeners) { listeners = new Set(); keys.set(key, listeners); }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) keys.delete(key);
  };
}

function publishDraft(drafts: ConversationReplyDrafts, key: string, draft: ConversationReplyDraft) {
  const becameEmpty = Boolean(drafts.get(key)?.text) && !draft.text;
  if (!draft.text && !draft.error && !draft.outcomeUnknown && !draft.sending) drafts.delete(key);
  else drafts.set(key, draft);
  for (const listener of draftListeners.get(drafts)?.get(key) ?? []) listener();
  if (becameEmpty) conversationOutbox().wake();
}

export function ConversationComposer({ session, machineReachable, replyDrafts, messages = [], messagesReady = false, recovery, onTerminal, composerId = "conversation-composer", hidden = false, onBusyChange, onVoiceOpenChange }: {
  readonly session: Session;
  readonly machineReachable: boolean;
  readonly replyDrafts?: ConversationReplyDrafts;
  /** The conversation transcript, whose last message a stuck turn resends (#921). */
  readonly messages?: readonly HistoryMessage[];
  /** The latest history page has settled; its first snapshot is hydration, not activity. */
  readonly messagesReady?: boolean;
  /** The Dashboard's resume of this session, with its pending state (#921). */
  readonly recovery?: ConversationRecovery;
  /** The view's switch to this session's terminal, where it has one (#921). */
  readonly onTerminal?: () => void;
  readonly composerId?: string;
  readonly hidden?: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onVoiceOpenChange: (open: boolean) => void;
}) {
  const key = sessionKey(session);
  const localDrafts = useRef<ConversationReplyDrafts>(new Map()).current;
  const drafts = replyDrafts ?? localDrafts;
  const emptyDraft = useMemo<ConversationReplyDraft>(() => ({
    text: "", incarnation: session.session_incarnation, error: "", outcomeUnknown: false,
  }), [session.session_incarnation]);
  const subscribe = useCallback((listener: () => void) => subscribeDraft(drafts, key, listener), [drafts, key]);
  const readDraft = useCallback(() => drafts.get(key) ?? emptyDraft, [drafts, key, emptyDraft]);
  const reply = useSyncExternalStore(subscribe, readDraft, readDraft);
  const { text: draft, incarnation: draftIncarnation, error, outcomeUnknown } = reply;
  const sending = reply.sending ?? false;
  const outbox = useConversationOutbox();
  const shared = useSharedOutbox(session);
  const sharedReply = usesSharedOutbox(session);
  const sharedPending = sharedReply && shared.targets(session).some(row =>
    row.admissions.length > 0 || row.snapshot.items.some(item =>
      item.state !== "submitted" && item.state !== "cancelled" && item.state !== "refused"));
  const queued = outbox.items(session);
  const outboxVersion = outbox.snapshot();
  const updateReply = useCallback((patch: Partial<ConversationReplyDraft>) => {
    const before = readDraft();
    publishDraft(drafts, key, { ...before, ...patch });
  }, [drafts, key, readDraft]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "34px";
      const height = draft ? Math.max(34, textarea.scrollHeight) : 34;
      textarea.style.height = `${Math.min(120, height)}px`;
      textarea.style.overflowY = height > 120 ? "auto" : "hidden";
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft, hidden]);
  // After an upload the caret waits on the empty line below the paths (#963).
  const caretToEnd = useRef(false);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!caretToEnd.current || !textarea) return;
    caretToEnd.current = false;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [draft]);
  // A reply is its own bubble in the conversation, so no "Sent" notice (#969).
  const [voiceToken, setVoiceToken] = useState(0);
  const [uploading, setUploading] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentIncarnation = useRef(session.session_incarnation);
  currentIncarnation.current = session.session_incarnation;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onBusyChange(sending || queued.some(item => outbox.isSending(item.id))); }, [onBusyChange, sending, queued, outbox, outboxVersion]);

  const state = parseTurnStateV1(session.turn_state);
  const provider = session.provider_resume?.provider ?? session.agent;
  const restarted = Boolean(draft) && draftIncarnation !== session.session_incarnation;
  const hint = restarted ? "This session restarted. Discard this draft before replying to the new session."
    : !machineReachable || session.status !== "running" ? "This session is unavailable. Return to the terminal to check it."
    : !session.session_incarnation ? "This session cannot confirm a safe reply target. Use the terminal."
    : provider !== "codex" && provider !== "claude" ? "Replies are unavailable for this provider. Use the terminal."
    : state?.phase === "working" || state?.phase === "starting" ? BUSY_REPLY_HINT
    : "";
  // A stopped session the Dashboard can resume offers Recover here instead of
  // the terminal hint (#921); a failed startup keeps its own Retry there.
  const recoverable = Boolean(recovery) && machineReachable && !restarted && isSessionResumeAvailable(session)
    && session.startup?.state !== "failed";
  const status = error || uploading || (hint === BUSY_REPLY_HINT || recoverable ? "" : hint);
  // A failed turn names its cause and offers one tap to try again (#921).
  const stuck = hint || state?.phase === "needs_input" || state?.current_turn?.attention
    ? null : stuckTurn(state, session.auto_resume, messages);
  const [resending, setResending] = useState(false);
  // A working turn with no activity for a while may be stuck (#921). Activity
  // is the phase change, the newest transcript message, or a turn state
  // revision this page saw change; opening the page is not activity.
  const [revisionSeen, setRevisionSeen] = useState(() => ({ key: `${key}:${state?.revision}`, at: 0 }));
  const revisionKey = `${key}:${state?.revision}`;
  if (revisionSeen.key !== revisionKey) setRevisionSeen({ key: revisionKey, at: Date.now() });
  const latestMessage = messages.at(-1);
  const [messageSeen, setMessageSeen] = useState(() => ({ key, ready: messagesReady, latest: latestMessage, at: 0 }));
  if (messageSeen.key !== key) {
    setMessageSeen({ key, ready: messagesReady, latest: latestMessage, at: 0 });
  } else if (messagesReady && (!messageSeen.ready || messageSeen.latest?.id !== latestMessage?.id
    || messageSeen.latest?.text !== latestMessage?.text)) {
    // The first settled page (even an empty one) only seeds the comparison.
    // Later messages/streaming text are activity even without a usable clock.
    setMessageSeen({ key, ready: true, latest: latestMessage,
      at: messageSeen.ready && latestMessage ? Date.now() : messageSeen.at });
  }
  const newestMessageAt = messages.reduce((latest, message) => Math.max(latest, Date.parse(message.timestamp ?? "") || 0), 0);
  const lastActivityAt = Math.max(Date.parse(state?.phase_changed_at ?? "") || 0, newestMessageAt, revisionSeen.at, messageSeen.at);
  const [now, setNow] = useState(() => Date.now());
  const silentMinutes = hint === BUSY_REPLY_HINT ? silentTurnMinutes(state?.phase, lastActivityAt, Date.now()) : null;
  useEffect(() => {
    if (hint !== BUSY_REPLY_HINT || state?.phase !== "working") return;
    // Wake when the turn would turn silent, then each minute to keep counting.
    const quiet = Date.now() - lastActivityAt;
    const timer = setTimeout(() => setNow(Date.now()), quiet < SILENT_TURN_MS ? SILENT_TURN_MS - quiet : 60_000 - (quiet % 60_000));
    return () => clearTimeout(timer);
  }, [hint, state?.phase, lastActivityAt, now]);
  // The resend waits for any tracked reply and for the draft, as a typed reply would.
  const resendAction = stuck?.action && queued.length === 0 && !sharedPending && !draft && !sending && !resending ? stuck.action : undefined;
  const canSend = (!hint || hint === BUSY_REPLY_HINT) && !sending && !uploading && !outcomeUnknown && Boolean(draft.trim());
  const deliveryTarget = useRef({ session, machineReachable });
  deliveryTarget.current = { session, machineReachable };
  useEffect(() => {
    void outbox.reconcile(session, machineReachable).catch(() => {});
    void outbox.expire(session).catch(() => {});
    if (!queued.some(item => item.state === "queued")) return;
    void outbox.deliver(session, machineReachable, () => {
      const current = deliveryTarget.current;
      const draft = readDraft();
      return sessionKey(current.session) === key && current.session.session_incarnation === session.session_incarnation
        && queuedReplyTargetAllowed(current.session, current.machineReachable) && queuedReplyDeliverablePhase(current.session)
        && !draft.text && !draft.sending && !draft.outcomeUnknown;
    }).catch(() => {});
  }, [outbox, outboxVersion, session, machineReachable, readDraft, draft]);

  const updateDraft = (text: string) => {
    updateReply({ text, incarnation: draft ? draftIncarnation : session.session_incarnation, error: outcomeUnknown ? UNKNOWN_REPLY_OUTCOME : "" });
  };
  // Files go to the session's host; their quoted paths join the draft, as the
  // terminal's Upload does, and are sent with the next reply (#942).
  // An uncertain earlier reply keeps its notice, as typing and voice do.
  const failed = (message: string) => updateReply({ error: readDraft().outcomeUnknown ? `${message} ${UNKNOWN_REPLY_OUTCOME}` : message });
  const attach = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setUploading(files.length === 1 ? "Uploading file…" : `Uploading ${files.length} files…`);
    updateReply({ error: readDraft().outcomeUnknown ? UNKNOWN_REPLY_OUTCOME : "" });
    const paths: string[] = [];
    try {
      for (const file of files) {
        const result = await uploadAttachment(session.machine, session.id, file);
        if (!result.ok || !result.path) {
          failed(result.error ?? `Upload failed: ${file.name}`);
          return;
        }
        paths.push(result.path);
      }
      // One path per line, then an empty line where the message goes (#963).
      const current = readDraft();
      const separator = current.text && !current.text.endsWith("\n") ? "\n" : "";
      caretToEnd.current = true;
      updateReply({ text: `${current.text}${separator}${paths.map(shellQuotePathForTerminal).join("\n")}\n`,
        incarnation: current.text ? current.incarnation : session.session_incarnation });
    } catch {
      failed(files.length === 1 ? "Upload failed" : "Some uploads failed");
    } finally {
      if (mounted.current) setUploading("");
    }
  };
  const attachBlocked = sending || Boolean(uploading) || restarted || (Boolean(hint) && hint !== BUSY_REPLY_HINT);
  // Paste and drop take the terminal's file extraction and the same upload as the
  // paperclip. Files win over any path text beside them, so a client-local path
  // is never sent; plain text stays an ordinary textarea paste (#1049).
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    const text = data.getData("text");
    const macTauri = isMacTauri();
    const action = terminalPasteEventAction({
      files: filesFromTerminalClipboardData(data), text, canPasteTerminal: true, canReadNativeFiles: macTauri,
      hasNativeFileCandidate: macTauri && isMacosFilePasteCandidate(Array.from(data.types), text),
    });
    if (action.kind !== "upload-files" && action.kind !== "read-native-files") return;
    event.preventDefault();
    if (attachBlocked) return;
    void (action.kind === "upload-files" ? Promise.resolve(action.files) : readMacosClipboardFiles())
      .then(attach, () => failed(terminalClipboardActionErrorMessage(action)));
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const files = filesFromTerminalClipboardData(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    if (!attachBlocked) void attach(files);
  };
  const send = async () => {
    const currentDraft = readDraft();
    if (!canSend || currentDraft.sending || currentDraft.outcomeUnknown) return;
    const incarnation = currentDraft.incarnation;
    updateReply({ sending: true, error: "" });
    try {
      await shared.enqueue(session, currentDraft.text.trim());
      if (currentIncarnation.current === incarnation) updateReply({ text: "", error: "", outcomeUnknown: false });
    } catch (cause) {
      updateReply({ error: cause instanceof Error ? cause.message : "Could not save the reply. Your draft has been kept." });
    } finally {
      updateReply({ sending: false });
    }
  };

  const resend = async (text: string) => {
    setResending(true);
    try {
      await shared.enqueue(session, text);
    } catch (cause) {
      updateReply({ error: cause instanceof Error ? cause.message : "Could not resend. Use the terminal." });
    } finally {
      if (mounted.current) setResending(false);
    }
  };

  return (
    <footer id={composerId} className="conversation-composer" hidden={hidden} onDragOver={onDragOver} onDrop={onDrop}>
      {recoverable && recovery ? <div className="conversation-stuck" role="status">
        <span className="conversation-stuck-text">This session stopped.</span>
        <button type="button" className="btn ghost" aria-busy={recovery.pending} disabled={recovery.pending}
          onClick={() => recovery.onRecover()}>Recover</button>
      </div> : null}
      {silentMinutes !== null ? <div className="conversation-stuck" role="status">
        <span className="conversation-stuck-text">{`Possibly stuck: no activity for ${silentMinutes} min.${onTerminal ? "" : " Check the terminal."}`}</span>
        {onTerminal ? <button type="button" className="btn ghost" onClick={onTerminal}>Open terminal</button> : null}
      </div> : null}
      {stuck ? <div className="conversation-stuck" role="status">
        <span className="conversation-stuck-text">{stuck.text}</span>
        {resendAction ? <button type="button" className="btn ghost" onClick={() => void resend(resendAction.text)}>{resendAction.label}</button> : null}
      </div> : null}
      <div className="conversation-composer-row">
        <button type="button" className="conversation-attach" aria-label="Attach files" title="Attach files"
          disabled={attachBlocked}
          onClick={() => fileInputRef.current?.click()}><ConversationAttachIcon /></button>
        <input ref={fileInputRef} type="file" multiple className="conversation-file-input" tabIndex={-1} aria-hidden="true"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void attach(files);
          }} />
        <textarea ref={textareaRef} aria-label="Reply to session" placeholder="Reply to this session…" rows={1}
          value={draft} disabled={sending} onChange={(event) => updateDraft(event.target.value)} onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            // Keep the phone keyboard newline behavior aligned with Dashboard's layout.
            if (window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1024px)").matches) return;
            event.preventDefault();
            void send();
          }} />
        {/* Mic while the composer is empty, send once it has text (#942). */}
        {draft.trim() || sending ? <button type="button" className="conversation-send" aria-label="Send reply" title={sending ? "Sending…" : "Send reply"}
          aria-busy={sending} disabled={!canSend} onClick={() => void send()}>
          <ConversationSendIcon />
        </button> : <button type="button" className="conversation-voice" aria-label="Voice" title="Voice"
          disabled={restarted || !session.session_incarnation}
          onClick={() => {
            if (!draft) updateReply({ incarnation: session.session_incarnation });
            setVoiceToken((token) => token + 1);
          }}><ConversationMicIcon /></button>}
      </div>
      {status ? <p className={error ? "history-error" : "conversation-hint"} role={error ? "alert" : "status"}>{status}</p> : null}
      <div className="conversation-composer-actions">
        {restarted ? <button type="button" className="btn ghost" disabled={sending} onClick={() => {
          updateReply({ text: "", incarnation: session.session_incarnation, error: "", outcomeUnknown: false });
        }}>Discard draft</button> : null}
        {outcomeUnknown ? <button type="button" className="btn ghost" onClick={() => {
          updateReply({ outcomeUnknown: false, error: "" });
        }}>I checked the session</button> : null}
      </div>
      <SpeechComposer machine={session.machine} id={session.id} sessionIncarnation={draftIncarnation ?? session.session_incarnation ?? ""}
        targetLabel={sessionLabel(session)} showTrigger={false} openRequestToken={voiceToken}
        onBeforeOpen={() => {}} onOpenChange={onVoiceOpenChange}
        onTranscript={(text) => {
          const current = readDraft();
          updateReply({ text: current.text ? `${current.text}\n${text}` : text, error: current.outcomeUnknown ? UNKNOWN_REPLY_OUTCOME : "" });
        }} />
    </footer>
  );
}
