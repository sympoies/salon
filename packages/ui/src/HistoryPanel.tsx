import { IconButton } from "./IconButton.tsx";
import { FilterDisclosure } from "./FilterDisclosure.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listHistorySessions,
  lookupLiveHistorySession,
  resumeHistorySession,
  setHistoryStar,
  type CreateSessionResult,
  type HistoryStarResult,
} from "./api.ts";
import type { HistorySession, HistorySessionsResponse } from "./types.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { HistoryConversationView, useHistoryConversation } from "./HistoryConversation.tsx";
import { applyHistoryStar } from "./historyStars.ts";
import { Modal } from "./Modal.tsx";
import { CloseIcon, StarIcon } from "./icons.tsx";
import { SessionBadges } from "./extensions.tsx";
import { historyMarkerItem, type CoordinatorTreeItem } from "./coordinatorTree.ts";
import { isTauri } from "./runtime.ts";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import { compactPromptPreview } from "./voicePrompt.ts";
import { createAsyncPoller, type AsyncPollTick } from "./useAsyncPoll.ts";

const HISTORY_PAGE_SIZE = 50;
const HISTORY_CATALOG_REFRESH_MS = 30_000;
const RESUME_LOOKUP_ATTEMPTS = 5;
const RESUME_LOOKUP_INTERVAL_MS = 500;
const RESUME_LOOKUP_TIMEOUT_MS = 4_000;

export interface HistoryPanelProps {
  readonly machines: readonly string[];
  /** Live sessions, so a row badges exactly like the same session in the session list. */
  readonly liveSessions?: Parameters<typeof historyMarkerItem>[1];
  readonly onClose: () => void;
  /**
   * The live session the resume created. The Dashboard uses it to land the user
   * on that session; History closes itself once this returns.
   */
  readonly onResumed: (resumed: { readonly machine: string; readonly id: string }) => void | Promise<void>;
}

function sessionTitle(session: HistorySession): string {
  return session.title?.trim() || "Untitled session";
}

function firstPromptPreview(session: HistorySession): string | undefined {
  const preview = session.first_user_prompt_preview ?? session.prompt_preview;
  return preview === undefined ? undefined : compactPromptPreview(preview);
}

function harnessLabel(provider: HistorySession["provider"]): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function projectLabel(session: HistorySession): string {
  const repoName = session.repo_name?.trim();
  if (repoName) return repoName;
  const normalized = session.cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || session.cwd;
}

function waitForLookupInterval(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function SessionContext({ session, marker }: { readonly session: HistorySession; readonly marker: CoordinatorTreeItem }) {
  return (
    <span className="history-session-context">
      <span className="history-context-badges">
        <span className="history-context-badge history-harness-badge">
          <AgentBadge agent={session.provider} decorative />
          {harnessLabel(session.provider)}
        </span>
        <span className="history-context-badge history-project-badge" title={session.cwd}>
          {projectLabel(session)}
        </span>
        <SessionBadges item={marker} surface="history" />
        {session.archived_at ? (
          <span className="history-context-badge history-archive-badge">Archived</span>
        ) : null}
      </span>
      <span className="history-project-path" title={session.cwd}>{session.cwd}</span>
    </span>
  );
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const datePart = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${datePart} ${timePart}`;
}

export function HistoryPanel({ machines, liveSessions = [], onClose, onResumed }: HistoryPanelProps) {
  const [machine, setMachine] = useState(machines[0] ?? "");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<"" | HistorySession["provider"]>("");
  const [sessions, setSessions] = useState<readonly HistorySession[]>([]);
  const [latestMessagePaging, setLatestMessagePaging] = useState(false);
  const [starAvailable, setStarAvailable] = useState(false);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [starPending, setStarPending] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [sessionPage, setSessionPage] = useState(0);
  const [sessionPageCursors, setSessionPageCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(false);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeOutcomeUnknown, setResumeOutcomeUnknown] = useState(false);
  const [closeAfterBackCleanup, setCloseAfterBackCleanup] = useState(false);
  const [error, setErrorState] = useState<string>();
  const catalogErrorRef = useRef(false);
  const setError = useCallback((message: string | undefined) => {
    catalogErrorRef.current = false;
    setErrorState(message);
  }, []);
  const [notice, setNotice] = useState<string>();
  const catalogAbortRef = useRef<AbortController | null>(null);
  const resumeLookupAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const conversation = useHistoryConversation(setError);
  const selected = conversation.session;
  const resetConversation = conversation.reset;
  const openConversation = conversation.open;
  const canRefreshCatalog = Boolean(machine) && selected === undefined && sessionPage === 0
    && !resuming && !resumeOutcomeUnknown && !starPending;
  const refreshAllowedRef = useRef(canRefreshCatalog);
  refreshAllowedRef.current = canRefreshCatalog;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resumeLookupAbortRef.current?.abort();
      resumeLookupAbortRef.current = null;
    };
  }, []);

  const loadSessions = useCallback(async (
    cursor?: string,
    page = 0,
    cursors: readonly (string | undefined)[] = [undefined],
    tick?: AsyncPollTick,
  ) => {
    if (!machine) return;
    if (tick && (!tick.isCurrent() || !refreshAllowedRef.current
      || document.visibilityState !== "visible" || catalogAbortRef.current)) return;
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    const abortRefresh = () => {
      controller.abort();
      if (catalogAbortRef.current === controller) catalogAbortRef.current = null;
    };
    tick?.signal.addEventListener("abort", abortRefresh, { once: true });
    if (!tick) {
      setCatalogSettled(false);
      setLoading(true);
      setError(undefined);
      setNotice(undefined);
    }
    const result: HistorySessionsResponse = await listHistorySessions(machine, {
      q: query,
      provider: provider || undefined,
      cursor,
      limit: HISTORY_PAGE_SIZE,
    }, controller.signal).catch((cause: Error): HistorySessionsResponse => ({
      ok: false,
      sessions: [],
      truncated: false,
      ...(controller.signal.aborted ? {} : { error: cause.message }),
    }));
    tick?.signal.removeEventListener("abort", abortRefresh);
    if (catalogAbortRef.current !== controller || controller.signal.aborted) return;
    catalogAbortRef.current = null;
    if (tick && (!tick.isCurrent() || !refreshAllowedRef.current || document.visibilityState !== "visible")) return;
    if (!tick) {
      setLoading(false);
      setCatalogSettled(true);
    }
    if (!result.ok) {
      if (!tick) {
        catalogErrorRef.current = true;
        setErrorState(result.error ?? "History could not be loaded");
      }
      return;
    }
    if (catalogErrorRef.current) {
      catalogErrorRef.current = false;
      setErrorState(undefined);
    }
    setSessions(result.sessions.slice(0, HISTORY_PAGE_SIZE));
    setLatestMessagePaging(result.latestMessagePaging === true);
    setStarAvailable(result.starAvailable === true);
    setResumeAvailable(result.resumeAvailable === true);
    setNextCursor(result.nextCursor);
    if (!tick) {
      setResumeOutcomeUnknown(false);
      setSessionPage(page);
      setSessionPageCursors(cursors);
      resetConversation();
    }
    setNotice(result.truncated ? "The daemon scan limit was reached; narrow the metadata filters." : undefined);
  }, [machine, provider, query, resetConversation]);

  useEffect(() => {
    setCatalogSettled(false);
    const timer = window.setTimeout(() => void loadSessions(), 200);
    return () => {
      window.clearTimeout(timer);
      catalogAbortRef.current?.abort();
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!canRefreshCatalog || !catalogSettled) return;
    // The first quiet interval begins after the initial/filter read settles.
    // Later reads remain completion-relative and serialized by the poller.
    let initial = true;
    const poller = createAsyncPoller({
      delayMs: HISTORY_CATALOG_REFRESH_MS,
      task: async tick => {
        if (initial) { initial = false; return; }
        await loadSessions(undefined, 0, [undefined], tick);
      },
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: timer => window.clearTimeout(timer),
    });
    poller.start();
    return () => poller.stop();
  }, [canRefreshCatalog, catalogSettled, loadSessions]);

  // The daemon owns the star, so the toggle waits for its acknowledgement and
  // then reorders locally with the same rule the next page would apply.
  const toggleStar = useCallback(async (session: HistorySession) => {
    setStarPending(session.id);
    setError(undefined);
    const result = await setHistoryStar(session.machine, session.id, !session.starred_at)
      .catch((cause: Error): HistoryStarResult => ({ ok: false, error: cause.message }));
    setStarPending(undefined);
    if (!result.ok) {
      setError(result.error ?? "The star could not be saved");
      return;
    }
    setSessions((current) => applyHistoryStar(current, session.id, result.starredAt));
  }, []);

  const openSession = useCallback(async (session: HistorySession) => {
    setResumeOutcomeUnknown(false);
    await openConversation(session, latestMessagePaging);
  }, [latestMessagePaging, openConversation]);

  const returnToSessionList = useCallback(() => {
    resetConversation();
    setError(undefined);
  }, [resetConversation]);
  useAndroidBackEntry("history-conversation", selected !== undefined, () => {
    if (resuming) return false;
    returnToSessionList();
  });
  const closeHistory = useCallback(() => {
    if (closeAfterBackCleanup) return;
    if (selected !== undefined && isTauri()) {
      setCloseAfterBackCleanup(true);
      returnToSessionList();
      return;
    }
    onClose();
  }, [closeAfterBackCleanup, onClose, returnToSessionList, selected]);
  useEffect(() => {
    if (!closeAfterBackCleanup || selected !== undefined) return;
    const finishClose = () => {
      setCloseAfterBackCleanup(false);
      onClose();
    };
    window.addEventListener("popstate", finishClose, { once: true });
    return () => window.removeEventListener("popstate", finishClose);
  }, [closeAfterBackCleanup, onClose, selected]);

  const resume = useCallback(async () => {
    if (!selected || resuming || resumeOutcomeUnknown || !resumeAvailable || !selected.resumable) return;
    setResuming(true);
    setError(undefined);
    const result = await resumeHistorySession(selected.machine, selected.id)
      .catch((): CreateSessionResult => ({
        ok: false,
        outcomeUnknown: true,
        error: "Resume transport failed.",
      }));
    if (!mountedRef.current) return;
    const errorPrefix = result.errorCode ? `${result.errorCode}: ` : "";
    if (result.outcomeUnknown || (result.ok && !result.id)) {
      let liveSessionId: string | undefined;
      let inventoryChecked = false;
      const lookupController = new AbortController();
      resumeLookupAbortRef.current = lookupController;
      const lookupDeadline = setTimeout(() => lookupController.abort(), RESUME_LOOKUP_TIMEOUT_MS);
      try {
        for (let attempt = 0; attempt < RESUME_LOOKUP_ATTEMPTS && !lookupController.signal.aborted; attempt += 1) {
          try {
            liveSessionId = await lookupLiveHistorySession(
              selected.machine,
              selected.provider,
              selected.provider_session_id,
              lookupController.signal,
            );
            inventoryChecked = true;
          } catch {
            // A transient read failure is retried within the same bounded lookup window.
          }
          if (liveSessionId || attempt + 1 === RESUME_LOOKUP_ATTEMPTS || lookupController.signal.aborted) break;
          await waitForLookupInterval(RESUME_LOOKUP_INTERVAL_MS, lookupController.signal);
        }
      } finally {
        clearTimeout(lookupDeadline);
        if (resumeLookupAbortRef.current === lookupController) resumeLookupAbortRef.current = null;
      }
      if (!mountedRef.current) return;
      if (liveSessionId) {
        setResuming(false);
        closeHistory();
        await onResumed({ machine: selected.machine, id: liveSessionId });
        return;
      }
      setResuming(false);
      setResumeOutcomeUnknown(true);
      const failure = result.error ?? (result.ok
        ? "History resume returned no created session."
        : "Resume could not be confirmed.");
      setError(`${errorPrefix}${failure} ${inventoryChecked
        ? "Live sessions were checked; refresh before trying again."
        : "Live sessions could not be checked; refresh before trying again."}`);
      return;
    }
    setResuming(false);
    if (!result.ok || !result.id) {
      setError(`${errorPrefix}${result.error ?? "Session could not be resumed"}`);
      return;
    }
    // Close before handing up, not after: the handoff awaits a full session-list
    // refresh, and this panel stays interactive across it. Closing afterwards
    // would run a closure captured before that await against state the user may
    // have changed meanwhile — returning to the session list mid-await would
    // leave the panel waiting for an unwind that already happened.
    closeHistory();
    await onResumed({ machine: selected.machine, id: result.id });
  }, [closeHistory, onResumed, resumeAvailable, resumeOutcomeUnknown, resuming, selected]);

  return (
    <Modal
      androidBackEntry="session-history"
      onClose={closeHistory}
      busy={resuming || closeAfterBackCleanup}
      className={`history-modal ${selected ? "is-viewing" : "is-listing"}`}
      backdropClassName="history-backdrop"
      ariaLabelledby="history-title"
    >
      <header className="history-head">
        <div>
          <h2 id="history-title">Session History</h2>
          <p>Searches metadata and the bounded prompt preview only — never conversation text.</p>
        </div>
        <IconButton
          type="button"
          className="btn icon-btn"
          aria-label="Close history"
          disabled={resuming || closeAfterBackCleanup}
          onClick={closeHistory}
        >
          <CloseIcon />
        </IconButton>
      </header>
      <FilterDisclosure id="history-filters" className="history-filter-panel"
        summary={`${machine || "No machine"} · ${provider ? harnessLabel(provider) : "All providers"}${query.trim() ? ` · ${query.trim()}` : ""}`}>
        <div className="history-filters">
          <label>
            <span>Machine</span>
            <select aria-label="History machine" value={machine} onChange={(event) => setMachine(event.target.value)}>
              {machines.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            <span>Provider</span>
            <select aria-label="History provider" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
              <option value="">All</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label className="history-search">
            <span>Metadata search</span>
            <input
              aria-label="History metadata search"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title, prompt preview, ID, repo, cwd, date…"
              type="search"
            />
          </label>
        </div>
      </FilterDisclosure>
      {error ? <div className="history-error" role="alert">{error}</div> : null}
      {notice ? <div className="history-notice" role="status">{notice}</div> : null}

      <div className={`history-body ${selected ? "is-viewing" : "is-listing"}`}>
        <section className="history-list" aria-label="Historical sessions">
          {sessions.map((session) => (
            <div className="history-row-shell" key={`${session.machine}/${session.id}`}>
              <button
                type="button"
                className={`control-row control-row--record history-row ${selected?.id === session.id ? "is-selected" : ""}`}
                onClick={() => void openSession(session)}
              >
                <strong className="history-row-title">{sessionTitle(session)}</strong>
                <SessionContext session={session} marker={historyMarkerItem(session, liveSessions)} />
                <span className="history-row-meta">{dateLabel(session.updated_at)}</span>
                {firstPromptPreview(session) ? (
                  <span className="history-row-preview"><b>Start</b>{firstPromptPreview(session)}</span>
                ) : null}
                {session.last_user_prompt_preview ? (
                  <span className="history-row-preview"><b>Latest</b>{compactPromptPreview(session.last_user_prompt_preview)}</span>
                ) : null}
              </button>
              {starAvailable ? (
                <IconButton
                  type="button"
                  className={`history-star${session.starred_at ? " is-starred" : ""}`}
                  aria-pressed={Boolean(session.starred_at)}
                  aria-label={`${session.starred_at ? "Unstar" : "Star"} ${sessionTitle(session)}`}
                  disabled={starPending === session.id}
                  onClick={() => void toggleStar(session)}
                >
                  <StarIcon filled={Boolean(session.starred_at)} />
                </IconButton>
              ) : null}
            </div>
          ))}
          {sessions.length === 0 && !loading ? <p className="history-empty">No matching sessions.</p> : null}
          <div className="history-pagination">
            {sessionPage > 0 ? (
              <button className="btn ghost" type="button" disabled={loading} onClick={() => {
                const page = sessionPage - 1;
                void loadSessions(sessionPageCursors[page], page, sessionPageCursors);
              }}>Previous</button>
            ) : null}
            {nextCursor ? (
              <button className="btn ghost" type="button" disabled={loading} onClick={() => {
                const cursors = [...sessionPageCursors.slice(0, sessionPage + 1), nextCursor];
                void loadSessions(nextCursor, sessionPage + 1, cursors);
              }}>{loading ? "Loading…" : "Next"}</button>
            ) : null}
          </div>
        </section>
        <section className="history-viewer" aria-label="Conversation">
          {selected ? (
            <>
              <header className="history-viewer-head">
                <div>
                  <strong>{sessionTitle(selected)}</strong>
                  <span className="history-viewer-meta"><SessionContext session={selected} marker={historyMarkerItem(selected, liveSessions)} /></span>
                  <code className="history-session-id" title={selected.provider_session_id}>{selected.provider_session_id}</code>
                </div>
                <div className="history-viewer-actions">
                  <button className="btn ghost history-back" type="button" onClick={returnToSessionList}>
                    Back to sessions
                  </button>
                  <button className="btn" type="button" disabled={resuming || resumeOutcomeUnknown || !resumeAvailable || !selected.resumable} onClick={() => void resume()}>
                    {resuming ? "Resuming…" : "Resume"}
                  </button>
                </div>
              </header>
              <HistoryConversationView conversation={conversation} onJumpToLatest={() => void openSession(selected)} />
            </>
          ) : <p className="history-empty">Select a session to browse its conversation.</p>}
        </section>
      </div>
    </Modal>
  );
}
