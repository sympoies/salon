import { ConversationImages } from "./ConversationImages.tsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, Fragment, type ReactNode, type RefObject } from "react";
import type { ConversationSnapshot } from "@agent-console/shared/resources";
import { normalizeActivityTurnState } from "@agent-console/shared/activity";
import { listHistoryMessages } from "./api.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { SessionNotice } from "./SessionNotice.tsx";
import { parseSessionNotice } from "@agent-console/shared";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { unwrapPastedContent } from "./pastedContent.ts";
import type { HistoryMessage, HistoryMessagesResponse, HistorySession } from "./types.ts";

const HISTORY_PAGE_SIZE = 50;
const HISTORY_MESSAGE_WINDOW = 100;
// A reader this close to the bottom keeps following the newest message.
const FOLLOW_LATEST_SLACK_PX = 48;

type ScrollAdjustment =
  | { readonly kind: "bottom" }
  | { readonly kind: "anchor"; readonly messageId: string; readonly top: number };

type MessageQuery = { readonly cursor?: string; readonly direction?: "latest" | "older" };

function messageDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function messageTimeLabel(date: Date | undefined): string | undefined {
  return date && [date.getHours(), date.getMinutes()].map(part => String(part).padStart(2, "0")).join(":");
}

function messageDayLabel(date: Date): string {
  return date.toDateString() === new Date().toDateString() ? "今天"
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export interface HistoryConversation {
  readonly session: HistorySession | undefined;
  readonly latestMessagePaging: boolean;
  readonly messages: readonly HistoryMessage[];
  /** At least one successful message result has hydrated the current history. */
  readonly messagesLoaded: boolean;
  readonly messageCursor: string | undefined;
  readonly olderCursor: string | undefined;
  readonly browsingOlder: boolean;
  readonly messagePage: number;
  readonly messagePageCursors: readonly (string | undefined)[];
  readonly loading: boolean;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly open: (session: HistorySession, latestMessagePaging: boolean) => Promise<void>;
  readonly reset: () => void;
  readonly loadOlder: () => Promise<void>;
  readonly loadPage: (
    cursor: string | undefined,
    page: number,
    cursors: readonly (string | undefined)[],
  ) => Promise<boolean>;
  /** Re-read the newest messages unless the reader is browsing older ones. */
  readonly refreshLatest: () => Promise<void>;
  /** Consume a latest-page snapshot; false asks the caller to use HTTP. */
  readonly applyLatest: (snapshot: ConversationSnapshot) => boolean;
}

/**
 * One history conversation's paged messages. History and the live-session
 * panel share it; each owner reports errors through its own banner.
 */
export function useHistoryConversation(onError: (message: string | undefined) => void): HistoryConversation {
  const [session, setSession] = useState<HistorySession>();
  const [latestMessagePaging, setLatestMessagePaging] = useState(false);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messageCursor, setMessageCursor] = useState<string>();
  const [olderCursor, setOlderCursor] = useState<string>();
  const [browsingOlder, setBrowsingOlder] = useState(false);
  const [messagePage, setMessagePage] = useState(0);
  const [messagePageCursors, setMessagePageCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(false);
  // A turn that completes mid-load waits for that load instead of aborting it,
  // which could be the reader's own Load older or page click.
  const [refreshQueued, setRefreshQueued] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestKindRef = useRef<MessageQuery["direction"] | "page">("page");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollAdjustmentRef = useRef<ScrollAdjustment | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const adjustment = scrollAdjustmentRef.current;
    if (!viewport || !adjustment) return;
    scrollAdjustmentRef.current = null;
    if (adjustment.kind === "bottom") {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-history-message-id]")]
      .find((element) => element.dataset.historyMessageId === adjustment.messageId);
    if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - adjustment.top;
  }, [messages]);

  // Only the newest request settles; a superseded one resolves to null. The
  // caller clears `loading` together with its results, so no render shows a
  // settled load before the state it produced.
  const fetchMessages = useCallback(async (
    target: HistorySession,
    query: MessageQuery,
  ): Promise<HistoryMessagesResponse | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    requestKindRef.current = query.direction ?? "page";
    setLoading(true);
    const result: HistoryMessagesResponse = await listHistoryMessages(
      target.machine,
      target.id,
      query,
      controller.signal,
    ).catch((cause: Error): HistoryMessagesResponse => ({
      ok: false,
      messages: [],
      ...(controller.signal.aborted ? {} : { error: cause.message }),
    }));
    if (abortRef.current !== controller || controller.signal.aborted) return null;
    abortRef.current = null;
    return result;
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setMessagesLoaded(false);
    setMessageCursor(undefined);
    setOlderCursor(undefined);
    setBrowsingOlder(false);
    setMessagePage(0);
    setMessagePageCursors([undefined]);
  }, []);

  const open = useCallback(async (target: HistorySession, latestPaging: boolean) => {
    setSession(target);
    setLatestMessagePaging(latestPaging);
    clear();
    onError(undefined);
    const result = await fetchMessages(target, latestPaging ? { direction: "latest" } : {});
    if (!result) return;
    setLoading(false);
    if (!result.ok) {
      onError(result.error ?? "Conversation could not be loaded");
      return;
    }
    if (latestPaging) scrollAdjustmentRef.current = { kind: "bottom" };
    setMessagesLoaded(true);
    setMessages(result.messages.slice(0, HISTORY_PAGE_SIZE));
    setMessageCursor(result.nextCursor);
    setOlderCursor(result.olderCursor);
  }, [clear, fetchMessages, onError]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSession(undefined);
    clear();
    setLoading(false);
    setRefreshQueued(false);
  }, [clear]);

  const loadOlder = useCallback(async () => {
    if (!session || !olderCursor || loading) return;
    const viewport = viewportRef.current;
    const anchorMessage = messages[0];
    const anchorElement = viewport && anchorMessage
      ? [...viewport.querySelectorAll<HTMLElement>("[data-history-message-id]")]
        .find((element) => element.dataset.historyMessageId === anchorMessage.id)
      : undefined;
    onError(undefined);
    const result = await fetchMessages(session, { direction: "older", cursor: olderCursor });
    if (!result) return;
    setLoading(false);
    if (!result.ok) {
      onError(result.error ?? "Older conversation messages could not be loaded");
      return;
    }
    if (anchorMessage && anchorElement) {
      scrollAdjustmentRef.current = {
        kind: "anchor",
        messageId: anchorMessage.id,
        top: anchorElement.getBoundingClientRect().top,
      };
    }
    setMessagesLoaded(true);
    setMessages((current) => [...result.messages, ...current].slice(0, HISTORY_MESSAGE_WINDOW));
    setOlderCursor(result.olderCursor);
    setBrowsingOlder(true);
  }, [fetchMessages, loading, messages, olderCursor, onError, session]);

  const loadPage = useCallback(async (
    cursor: string | undefined,
    page: number,
    cursors: readonly (string | undefined)[],
  ): Promise<boolean> => {
    if (!session) return false;
    const result = await fetchMessages(session, { cursor });
    if (!result) return false;
    setLoading(false);
    if (!result.ok) {
      onError(result.error ?? "Conversation could not be loaded");
      return false;
    }
    setMessagesLoaded(true);
    setMessages(result.messages.slice(0, HISTORY_PAGE_SIZE));
    setMessageCursor(result.nextCursor);
    setMessagePage(page);
    setMessagePageCursors(cursors);
    return true;
  }, [fetchMessages, onError, session]);

  const refreshLatest = useCallback(async () => {
    if (!session) return;
    if (loading) {
      setRefreshQueued(true);
      return;
    }
    if (!latestMessagePaging) {
      if (await loadPage(messagePageCursors[messagePage], messagePage, messagePageCursors)) onError(undefined);
      return;
    }
    if (browsingOlder) return;
    const result = await fetchMessages(session, { direction: "latest" });
    if (!result) return;
    setLoading(false);
    if (!result.ok) {
      onError(result.error ?? "Conversation could not be loaded");
      return;
    }
    onError(undefined);
    // Honor the reader's current position: they may have scrolled while the
    // latest page was in flight. The old page is still mounted at this point.
    const viewport = viewportRef.current;
    const following = !viewport
      || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_LATEST_SLACK_PX;
    if (following) scrollAdjustmentRef.current = { kind: "bottom" };
    setMessagesLoaded(true);
    setMessages(result.messages.slice(0, HISTORY_PAGE_SIZE));
    setOlderCursor(result.olderCursor);
  }, [
    browsingOlder,
    fetchMessages,
    latestMessagePaging,
    loadPage,
    loading,
    messagePage,
    messagePageCursors,
    onError,
    session,
  ]);

  const applyLatest = useCallback((snapshot: ConversationSnapshot): boolean => {
    if (!session || !latestMessagePaging) return false;
    // Refs change synchronously when navigation starts, before loading renders.
    // Consume ignored latest snapshots so a fallback refresh cannot cancel it.
    if (browsingOlder) return true;
    if ((abortRef.current || loading) && requestKindRef.current !== "latest") {
      // A successful older load pauses this refresh; a failed one must not lose
      // the only changed event and wait until the periodic reconcile.
      setRefreshQueued(true);
      return true;
    }
    const viewport = viewportRef.current;
    const following = !viewport
      || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_LATEST_SLACK_PX;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setRefreshQueued(false);
    onError(undefined);
    if (following) scrollAdjustmentRef.current = { kind: "bottom" };
    setMessagesLoaded(true);
    setMessages(snapshot.messages);
    setOlderCursor(snapshot.older_cursor);
    setMessageCursor(snapshot.next_cursor);
    return true;
  }, [session, latestMessagePaging, browsingOlder, loading, onError]);

  // Drain a queued refresh against the state the finished load produced; the
  // browsing-older guard still applies then.
  useEffect(() => {
    if (!refreshQueued || loading) return;
    setRefreshQueued(false);
    void refreshLatest();
  }, [loading, refreshLatest, refreshQueued]);

  return {
    session,
    latestMessagePaging,
    messages,
    messagesLoaded,
    messageCursor,
    olderCursor,
    browsingOlder,
    messagePage,
    messagePageCursors,
    loading,
    viewportRef,
    open,
    reset,
    loadOlder,
    loadPage,
    refreshLatest,
    applyLatest,
  };
}

/** A live session's turn is running, so its message list ends with Working (#942). */
export function conversationTurnWorking(turnState: unknown): boolean {
  const phase = normalizeActivityTurnState(turnState)?.phase;
  return phase === "working" || phase === "starting";
}

export function HistoryConversationView({
  conversation,
  onJumpToLatest,
  working = false,
  outgoing = null,
}: {
  readonly conversation: HistoryConversation;
  readonly onJumpToLatest: () => void;
  /** Show the agent's Working line at the end of the latest messages. */
  readonly working?: boolean;
  /** The owner's own replies from this browser, after the messages (#969). */
  readonly outgoing?: ReactNode;
}) {
  const {
    session,
    latestMessagePaging,
    messages,
    messageCursor,
    olderCursor,
    browsingOlder,
    messagePage,
    messagePageCursors,
    loading,
  } = conversation;
  const showWorking = working && !browsingOlder && (latestMessagePaging || messageCursor === null);
  // Keep a reader who follows the latest messages at the bottom as the line appears.
  useLayoutEffect(() => {
    const viewport = conversation.viewportRef.current;
    if (!showWorking || !viewport) return;
    const line = viewport.querySelector<HTMLElement>(".history-working");
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_LATEST_SLACK_PX + (line?.offsetHeight ?? 0)) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [showWorking, conversation.viewportRef]);
  return (
    <>
      <div className="history-messages" ref={conversation.viewportRef}>
        {latestMessagePaging && olderCursor ? (
          <button className="btn ghost history-load-older" type="button" disabled={loading} onClick={() => void conversation.loadOlder()}>
            {loading ? "Loading…" : "Load older"}
          </button>
        ) : null}
        {messages.map((message, index) => {
          const notice = parseSessionNotice(message.text);
          const date = messageDate(message.timestamp);
          const previous = messages[index - 1];
          const previousDate = messageDate(previous?.timestamp);
          const newDay = Boolean(date && date.toDateString() !== previousDate?.toDateString());
          const sentAt = messageTimeLabel(date);
          const user = message.role === "user";
          const showAvatar = !user && (newDay || previous?.role !== message.role);
          const imageOnly = Boolean(session && message.images?.length && !message.text.trim() && message.role !== "goal");
          const time = sentAt ? <time dateTime={message.timestamp}>{sentAt}</time> : null;
          return (
            <Fragment key={message.id}>
              {newDay && date ? <div className="history-day-separator"><span>{messageDayLabel(date)}</span></div> : null}
              <article data-history-message-id={message.id}
                aria-label={notice ? "System notice" : user ? "You" : message.role === "goal" ? "Goal" : session?.provider ?? "Agent"}
                className={notice ? "history-message is-notice" : `history-message is-${message.role}${!user && !showAvatar ? " is-continuation" : ""}`}>
                {notice ? <SessionNotice notice={notice} raw={message.text} time={time} suppressImages={Boolean(message.images?.length)}>
                  {message.images?.length && session ? <ConversationImages key={`${session.machine}/${session.id}`} machine={session.machine} history={session.id} images={message.images} /> : null}
                </SessionNotice> : <>
                {showAvatar ? <AgentBadge agent={session?.provider ?? "unknown"} decorative /> : null}
                {user && !imageOnly ? time : null}
                <div className={`history-bubble${imageOnly ? " is-image-only" : ""}`}>{message.role === "goal" ? <span className="history-goal-label">Goal</span> : null}<MessageMarkdown text={user ? unwrapPastedContent(message.text) : message.text} suppressImages={Boolean(message.images?.length)} />{message.images?.length && session ? <ConversationImages key={`${session.machine}/${session.id}`} machine={session.machine} history={session.id} images={message.images} /> : null}{imageOnly ? time : null}</div>
                {!user && !imageOnly ? time : null}
                </>}
              </article>
            </Fragment>
          );
        })}
        {loading && messages.length === 0 ? <p>Loading conversation…</p> : null}
        {browsingOlder ? null : outgoing}
        {showWorking ? <p className="history-working" role="status">
          Working<span className="history-working-dots" aria-hidden="true"><span /><span /><span /></span>
        </p> : null}
      </div>
      {latestMessagePaging ? (
        browsingOlder ? (
          <div className="history-pagination">
            <button className="btn ghost" type="button" disabled={loading} onClick={onJumpToLatest}>Jump to latest</button>
          </div>
        ) : null
      ) : <div className="history-pagination">
        {messagePage > 0 ? (
          <button className="btn ghost" type="button" disabled={loading} onClick={() => {
            const page = messagePage - 1;
            void conversation.loadPage(messagePageCursors[page], page, messagePageCursors);
          }}>Previous</button>
        ) : null}
        {messageCursor ? (
          <button className="btn ghost" type="button" disabled={loading} onClick={() => {
            const cursors = [...messagePageCursors.slice(0, messagePage + 1), messageCursor];
            void conversation.loadPage(messageCursor, messagePage + 1, cursors);
          }}>{loading ? "Loading…" : "Next"}</button>
        ) : null}
      </div>}
    </>
  );
}
