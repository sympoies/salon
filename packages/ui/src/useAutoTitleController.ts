import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  glance,
  listSessions,
  fetchSessionRetitleReadiness,
  fetchSessionRetitleV3Operation,
  fetchSessionRetitleV3Readiness,
  requestSessionRetitle,
  requestSessionRetitleV3,
  summarizeSessionTitle,
  updateSessionTitle,
  type ApiResult,
  type UpdateSessionTitleResult,
} from "./api.ts";
import {
  autoTitleStatesEqual,
  deriveAutoTitleStateFromSession,
  isAutoTitlePlaceholder,
  promptTitleSuffix,
  readAutoTitleStates,
  recoverAutoTitleBase,
  writeAutoTitleStates,
  type AutoTitleStates,
} from "./autoTitle.ts";
import {
  applyCreatePromptAutoTitleSummary,
  applyManualRetitleSummary,
  applyTurnPromptAutoTitleSummary,
  commitSummarizedTitle,
  prepareTurnCompletionAutoTitleSummary,
  type CreatePromptAutoTitleSummaryResult,
  type TurnPromptAutoTitleSummaryResult,
} from "./autoTitleFlow.ts";
import { sessionKey } from "./layout.ts";
import { parseTurnStateV1 } from "./sessionActivity.ts";
import { isActivityTurnWaitingPhase } from "@agent-console/shared/activity";
import { resolveLocalStorage } from "./storage.ts";
import { recordDebugEvent } from "./debugLog.ts";
import { createTurnTitleIdleScheduler, type TurnTitleIdleScheduler } from "./turnTitleIdle.ts";
import type { DashboardSession, Session, SessionsResponse } from "./types.ts";
import type {
  TitleSummaryPhase,
  TitleSummaryRequest,
  TitleSummaryTrace,
} from "@agent-console/shared/api";
import {
  emptySessionTitleState,
  normalizeSessionTitleState,
  userSessionTitleState,
  type SessionTitleState,
} from "@agent-console/shared/title";
import {
  SESSION_RETITLE_V3_HISTORY_CONFLICT,
  createManualSessionRetitleRequest,
  createManualSessionRetitleV3Request,
  sessionRetitleErrorMessage,
  sessionRetitleStatusMessage,
  sessionRetitleV3FailureMessage,
  sessionRetitleV3LifecycleOutcome,
  sessionRetitleV3StatusMessage,
} from "./sessionRetitle.ts";

const TURN_TITLE_IDLE_MS = 12_000;
const MAX_PROVIDER_PROMPT_EVENT_IDS_PER_SESSION = 256;
const MAX_COMPLETION_ATTEMPTS = 3;
const COMPLETION_RETRY_BASE_MS = 5_000;
const COMPLETION_BATCH_CONCURRENCY = 2;
const TITLE_PATCH_TIMEOUT_MS = 15_000;
const MAX_MANUAL_TITLE_CONFLICT_RETRIES = 2;
// A v3 history conflict means the provider decision lost a race with the
// session's own output. One retry against refreshed fences is the difference
// between a busy session that can be retitled and one that never can; each
// attempt costs a provider call, so the budget stays at one.
const MAX_MANUAL_V3_HISTORY_CONFLICT_RETRIES = 1;
let titleSummaryAttemptSequence = 0;

function createTitleSummaryAttemptId(): string {
  titleSummaryAttemptSequence += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `title_${Date.now().toString(36)}_${titleSummaryAttemptSequence.toString(36)}_${random}`;
}

function titleSummaryTrace(
  session: Pick<Session, "machine" | "id">,
  phase: TitleSummaryPhase,
  attempt: number,
  attemptId = createTitleSummaryAttemptId(),
): TitleSummaryTrace {
  return {
    attemptId,
    machine: session.machine,
    sessionId: session.id,
    phase,
    attempt,
  };
}

function recordTitleLifecycle(trace: TitleSummaryTrace, outcome: string): void {
  recordDebugEvent({
    source: "client",
    route: "/title-lifecycle",
    ok: null,
    machine: trace.machine,
    session_id: trace.sessionId,
    operation: "title",
    phase: trace.phase,
    outcome,
    attempt_id: trace.attemptId,
    attempt: trace.attempt,
  });
}

async function summarizeSessionTitleWithTrace(body: TitleSummaryRequest, trace: TitleSummaryTrace) {
  recordTitleLifecycle(trace, "summary_started");
  try {
    const result = await summarizeSessionTitle({ ...body, trace });
    recordTitleLifecycle(
      trace,
      result.ok ? result.diagnosticReason ?? result.source ?? "response_missing_source" : "request_failed",
    );
    return result;
  } catch (error) {
    recordTitleLifecycle(trace, "request_error");
    throw error;
  }
}

interface RetitleFeedback {
  readonly key: string;
  readonly state: "working" | "updated" | "failed" | "updating" | "committed" | "unchanged" | "degraded_cached" | "terminal_failure";
  // The actionable reason behind a failed state, shown on hover while the
  // transient badge is visible.
  readonly detail?: string;
}

// A manual v3 attempt either settled on its own or lost the commit race and
// handed its terminal reporting to the caller, which may retry it once.
type DaemonV3ManualAttempt =
  | { readonly kind: "settled" }
  | { readonly kind: "history_conflict"; readonly finish: () => void };

interface PendingTurnTitleRefresh {
  readonly session: Pick<Session, "machine" | "id" | "created_at" | "session_incarnation">;
  readonly prompt: string;
  readonly baseTitle: string | null;
  readonly expectedCurrentTitle: string | null;
}

type InitialPromptSummarySession = Pick<
  Session,
  | "machine"
  | "id"
  | "created_at"
  | "session_incarnation"
  | "title"
  | "title_state"
  | "title_state_supported"
  | "title_revision"
  | "retitle_path"
>;

interface InitialPromptSummaryState {
  readonly prompt: string;
  readonly session: InitialPromptSummarySession;
  readonly token: symbol;
  readonly attemptId: string;
  readonly baseTitle: string | null;
  readonly fallbackTitle: string;
  expectedCurrentTitle: string | null;
  supersededAutomaticTitle: string | null;
  supersededPreviousTitle: string | null;
  attempts: number;
  completionObserved: boolean;
  retainWhileUnlisted: boolean;
  readonly fenceToCapturedIncarnation: boolean;
  inFlight: boolean;
  nextRetryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  queuedAction: Pick<PendingTurnTitleRefresh, "session" | "prompt"> | null;
}

interface AutoTitleDependencyOptions {
  readonly currentTitle?: () => Promise<string | null | undefined>;
  readonly token?: symbol;
  readonly expectedTitleRevision?: number;
  readonly expectedSessionIncarnation?: string;
  readonly expectedSessionTitle?: string | null;
  readonly titleStateSupported?: boolean;
  readonly titleCasSupported?: boolean;
  readonly trace?: TitleSummaryTrace;
  readonly requireSummarizer?: boolean;
}

interface IncarnationTitleWork {
  readonly session: Session;
  readonly sameSessionRecord: boolean;
  readonly initialSummary: InitialPromptSummaryState | undefined;
  readonly hasCompletionQueuedAction: boolean;
  readonly completionQueuedAction: Pick<PendingTurnTitleRefresh, "session" | "prompt"> | null;
  readonly previousTitleRevision: number | undefined;
  readonly transition: CommittedTitleTransition | undefined;
  readonly activeTurnSummary: PendingTurnTitleRefresh | undefined;
}

interface ActiveTurnTitleSummary {
  readonly pending: PendingTurnTitleRefresh;
  readonly token: symbol;
}

interface CommittedTitleTransition {
  readonly previousTitle: string | null;
  readonly committedTitle: string | null;
  readonly rebasePendingTitle: boolean;
  readonly committed: boolean;
}

export function shouldConsumeTitleTransition(
  transition: { readonly previousTitle: string | null; readonly committed: boolean } | undefined,
  expectedCurrentTitle: string | null,
): boolean {
  return Boolean(transition?.committed && transition.previousTitle === expectedCurrentTitle);
}

interface CompletionAttempt {
  readonly completionId: string;
  readonly attemptId: string;
  attempts: number;
  inFlight: boolean;
  terminal: boolean;
  nextRetryAt: number;
  token: symbol | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface CompletionCandidate {
  readonly key: string;
  readonly session: Session;
  readonly completionId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly token: symbol;
}

interface ManualTitleUpdateAttempt {
  readonly token: symbol;
  readonly previousState: AutoTitleStates[string] | undefined;
}

interface PreparedCompletionCandidate {
  readonly candidate: CompletionCandidate;
  readonly title: string | null;
  readonly titleState?: SessionTitleState;
  readonly expectedTitleRevision: number | undefined;
}

export function structuredTitleStateForSession(
  session: Pick<Session, "title" | "title_state" | "title_state_supported"> | undefined,
): SessionTitleState | undefined {
  if (session?.title_state_supported !== true) {
    return undefined;
  }
  return normalizeSessionTitleState(session.title_state)
    ?? userSessionTitleState(session.title)
    ?? emptySessionTitleState();
}

function initialPromptSummarySession(session: InitialPromptSummarySession): InitialPromptSummaryState["session"] {
  return {
    machine: session.machine,
    id: session.id,
    created_at: session.created_at,
    session_incarnation: session.session_incarnation,
    title: session.title,
    title_state: session.title_state,
    title_state_supported: session.title_state_supported,
    title_revision: session.title_revision,
    retitle_path: session.retitle_path,
  };
}

function authoritativeCompletionId(session: Session): string | null {
  const turnState = parseTurnStateV1(session.turn_state);
  const lastTurn = turnState?.last_turn;
  const completedAt = lastTurn?.completed_at?.trim();
  if (
    !isActivityTurnWaitingPhase(turnState?.phase)
    || turnState.source?.confidence !== "authoritative"
    || lastTurn?.outcome !== "completed"
    || !completedAt
  ) {
    return null;
  }
  return `${lastTurn.provider_turn_id?.trim() || completedAt}:${completedAt}`;
}

function providerPromptBelongsToCompletedTurn(session: Session, submittedAt: string | undefined): boolean {
  if (!submittedAt) {
    return false;
  }
  const completedAt = parseTurnStateV1(session.turn_state)?.last_turn?.completed_at;
  if (!completedAt) {
    return false;
  }
  const submittedMs = Date.parse(submittedAt);
  const completedMs = Date.parse(completedAt);
  return Number.isFinite(submittedMs) && Number.isFinite(completedMs) && submittedMs <= completedMs;
}

function machineUnavailable(response: SessionsResponse, machine: string): boolean {
  const machineStatus = response.machines.find((status) => status.name === machine);
  return machineStatus ? !machineStatus.ok : !response.ok;
}

function isProvisionalAutoTitle(session: Pick<Session, "title" | "title_state">): boolean {
  return isAutoTitlePlaceholder(session.title)
    || (
      (session.title === null || session.title === undefined)
      && session.title_state?.topic_source === "none"
      && session.title_state.activity === null
    );
}

interface UseAutoTitleControllerOptions {
  readonly applyLiveSessionList: (res: SessionsResponse) => void;
  readonly enabledMachinesRef: RefObject<readonly string[]>;
  readonly focusedKey: string | null;
  readonly liveRef: RefObject<boolean>;
  readonly liveSessionKeys?: ReadonlySet<string>;
  readonly refresh: () => Promise<void>;
  readonly sessionsByKey: ReadonlyMap<string, Session>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setRetitleFeedback: (value: RetitleFeedback) => void;
  readonly setSessions: Dispatch<SetStateAction<DashboardSession[]>>;
  readonly showRetitleFeedback: (value: RetitleFeedback) => void;
  readonly activeTerminalSlotKey: () => string | null;
}

export interface UseAutoTitleControllerResult {
  readonly updateAutoTitleStates: (updater: (prev: AutoTitleStates) => AutoTitleStates) => void;
  readonly rememberSessionTitle: (machine: string, id: string, title: string | null) => void;
  readonly updateManualSessionTitle: (session: Session, title: string | null) => Promise<ApiResult>;
  readonly applyCreatePromptSummary: (
    session: InitialPromptSummarySession,
    prompt: string,
    baseTitle: string | null,
    fallbackTitle: string,
  ) => Promise<void>;
  readonly noteTurnPromptSubmitted: (
    session: Session,
    prompt: string,
    eventId?: string,
    submittedAt?: string,
  ) => void;
  readonly noteTurnOutput: (session: Session) => void;
  readonly retitleSession: (session: Session) => Promise<void>;
  readonly retitleFocusedSession: () => Promise<void>;
}

export function useAutoTitleController({
  applyLiveSessionList,
  enabledMachinesRef,
  focusedKey,
  liveRef,
  liveSessionKeys,
  refresh,
  sessionsByKey,
  setError,
  setRetitleFeedback,
  setSessions,
  showRetitleFeedback,
  activeTerminalSlotKey,
}: UseAutoTitleControllerOptions): UseAutoTitleControllerResult {
  const [autoTitleStates, setAutoTitleStates] = useState<AutoTitleStates>(() =>
    readAutoTitleStates(resolveLocalStorage()),
  );
  const [completionRetryEpoch, setCompletionRetryEpoch] = useState(0);
  const autoTitleStatesRef = useRef(autoTitleStates);
  const committedTitleTransitionsRef = useRef<Map<string, CommittedTitleTransition>>(new Map());
  const completionAttemptsRef = useRef<Map<string, CompletionAttempt>>(new Map());
  const completionBatchTailRef = useRef<Promise<void>>(Promise.resolve());
  const providerPromptEventIdsRef = useRef<Map<string, string[]>>(new Map());
  const initialProviderPromptSeenRef = useRef<Set<string>>(new Set());
  const initialPromptSummariesRef = useRef<Map<string, InitialPromptSummaryState>>(new Map());
  const completionQueuedActionsRef = useRef<Map<
    string,
    Pick<PendingTurnTitleRefresh, "session" | "prompt"> | null
  >>(new Map());
  const titleMutationGenerationsRef = useRef<Map<string, symbol>>(new Map());
  const titleMutationIncarnationsRef = useRef<Map<string, string>>(new Map());
  const titleRevisionsRef = useRef<Map<string, number>>(new Map());
  const titleRevisionIncarnationsRef = useRef<Map<string, string>>(new Map());
  const titleCasCapabilitiesRef = useRef<Set<string>>(new Set());
  const titlePatchTailsRef = useRef<Map<string, Promise<void>>>(new Map());
  const titlePatchAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const activeTurnSummariesRef = useRef<Map<string, ActiveTurnTitleSummary>>(new Map());
  const manualTitleUpdateAttemptsRef = useRef<Map<string, ManualTitleUpdateAttempt>>(new Map());
  const controllerActiveRef = useRef(true);
  const sessionsByKeyRef = useRef(sessionsByKey);
  const sessionIncarnationsRef = useRef<Map<
    string,
    { readonly createdAt: string | undefined; readonly incarnation: string }
  >>(new Map());
  const incarnationOwnershipResetsRef = useRef<Set<string>>(new Set());
  const incarnationTitleWorkRef = useRef<Map<string, IncarnationTitleWork>>(new Map());
  sessionsByKeyRef.current = sessionsByKey;
  for (const [key, session] of sessionsByKey) {
    const incarnation = session.session_incarnation;
    const pendingInitialSummary = initialPromptSummariesRef.current.get(key);
    if (
      pendingInitialSummary?.retainWhileUnlisted
      && (
        (
          incarnation !== undefined
          && pendingInitialSummary.session.session_incarnation === incarnation
        )
        || (
          session.created_at !== undefined
          && pendingInitialSummary.session.created_at === session.created_at
        )
      )
    ) {
      pendingInitialSummary.retainWhileUnlisted = false;
    }
    const previousIdentity = sessionIncarnationsRef.current.get(key);
    const cachedRevisionIncarnation = titleRevisionIncarnationsRef.current.get(key);
    const pendingMutationIncarnation = titleMutationIncarnationsRef.current.get(key);
    const renderedIncarnationChanged = Boolean(
      incarnation && previousIdentity && incarnation !== previousIdentity.incarnation,
    );
    const cachedRevisionIncarnationChanged = Boolean(
      incarnation && cachedRevisionIncarnation && incarnation !== cachedRevisionIncarnation,
    );
    const pendingMutationIncarnationChanged = Boolean(
      incarnation && pendingMutationIncarnation && incarnation !== pendingMutationIncarnation,
    );
    if (
      incarnation
      && (
        renderedIncarnationChanged
        || cachedRevisionIncarnationChanged
        || pendingMutationIncarnationChanged
      )
    ) {
      const capturedCreateIncarnationChanged = Boolean(
        pendingInitialSummary?.fenceToCapturedIncarnation
        && pendingInitialSummary.session.session_incarnation
        && incarnation !== pendingInitialSummary.session.session_incarnation,
      );
      const sameSessionRecord = !capturedCreateIncarnationChanged
        && previousIdentity !== undefined
        && session.created_at !== undefined
        && previousIdentity.createdAt !== undefined
        && session.created_at === previousIdentity.createdAt;
      const initialSummary = pendingInitialSummary;
      const hasCompletionQueuedAction = completionQueuedActionsRef.current.has(key);
      const completionQueuedAction = completionQueuedActionsRef.current.get(key) ?? null;
      const previousTitleRevision = titleRevisionsRef.current.get(key);
      const transition = committedTitleTransitionsRef.current.get(key);
      const activeTurnSummary = activeTurnSummariesRef.current.get(key)?.pending;
      incarnationTitleWorkRef.current.set(key, {
        session,
        sameSessionRecord,
        initialSummary: sameSessionRecord ? initialSummary : undefined,
        hasCompletionQueuedAction: sameSessionRecord && hasCompletionQueuedAction,
        completionQueuedAction: sameSessionRecord ? completionQueuedAction : null,
        previousTitleRevision,
        transition: sameSessionRecord ? transition : undefined,
        activeTurnSummary: sameSessionRecord ? activeTurnSummary : undefined,
      });
      if (initialSummary?.retryTimer !== null && initialSummary?.retryTimer !== undefined) {
        clearTimeout(initialSummary.retryTimer);
      }
      initialPromptSummariesRef.current.delete(key);
      completionQueuedActionsRef.current.delete(key);
      titleMutationGenerationsRef.current.delete(key);
      titleMutationIncarnationsRef.current.delete(key);
      titleRevisionsRef.current.delete(key);
      titleRevisionIncarnationsRef.current.delete(key);
      titleCasCapabilitiesRef.current.delete(key);
      titlePatchTailsRef.current.delete(key);
      activeTurnSummariesRef.current.delete(key);
      const completionAttempt = completionAttemptsRef.current.get(key);
      if (completionAttempt?.retryTimer) clearTimeout(completionAttempt.retryTimer);
      completionAttemptsRef.current.delete(key);
      manualTitleUpdateAttemptsRef.current.delete(key);
      if (!sameSessionRecord) {
        committedTitleTransitionsRef.current.delete(key);
      }
      if (!sameSessionRecord) {
        providerPromptEventIdsRef.current.delete(key);
        initialProviderPromptSeenRef.current.delete(key);
        incarnationOwnershipResetsRef.current.add(key);
      }
    }
    if (incarnation) {
      sessionIncarnationsRef.current.set(key, {
        createdAt: session.created_at,
        incarnation,
      });
    }
    const revision = session.title_revision;
    const known = titleRevisionsRef.current.get(key);
    const knownIncarnation = titleRevisionIncarnationsRef.current.get(key);
    if (revision !== undefined && incarnation) {
      titleCasCapabilitiesRef.current.add(key);
      if (knownIncarnation !== incarnation || known === undefined || revision >= known) {
        titleRevisionsRef.current.set(key, revision);
        titleRevisionIncarnationsRef.current.set(key, incarnation);
      }
    } else {
      titleCasCapabilitiesRef.current.delete(key);
      titleRevisionsRef.current.delete(key);
      titleRevisionIncarnationsRef.current.delete(key);
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const discardInitialPromptSummary = useCallback((key: string) => {
    const state = initialPromptSummariesRef.current.get(key);
    if (state?.retryTimer !== null && state?.retryTimer !== undefined) {
      clearTimeout(state.retryTimer);
    }
    initialPromptSummariesRef.current.delete(key);
    if (state && titleMutationGenerationsRef.current.get(key) === state.token) {
      titleMutationGenerationsRef.current.delete(key);
      titleMutationIncarnationsRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    controllerActiveRef.current = true;
    for (const [key, session] of sessionsByKeyRef.current) {
      if (session.title_revision !== undefined && session.session_incarnation) {
        titleCasCapabilitiesRef.current.add(key);
        titleRevisionsRef.current.set(key, session.title_revision);
        titleRevisionIncarnationsRef.current.set(key, session.session_incarnation);
        sessionIncarnationsRef.current.set(key, {
          createdAt: session.created_at,
          incarnation: session.session_incarnation,
        });
      }
    }
    return () => {
      controllerActiveRef.current = false;
      for (const state of initialPromptSummariesRef.current.values()) {
        if (state.retryTimer !== null) {
          clearTimeout(state.retryTimer);
        }
      }
      initialPromptSummariesRef.current.clear();
      for (const attempt of completionAttemptsRef.current.values()) {
        if (attempt.retryTimer) clearTimeout(attempt.retryTimer);
      }
      completionQueuedActionsRef.current.clear();
      titleMutationGenerationsRef.current.clear();
      titleMutationIncarnationsRef.current.clear();
      titleRevisionsRef.current.clear();
      titleRevisionIncarnationsRef.current.clear();
      titleCasCapabilitiesRef.current.clear();
      sessionIncarnationsRef.current.clear();
      incarnationOwnershipResetsRef.current.clear();
      incarnationTitleWorkRef.current.clear();
      completionAttemptsRef.current.clear();
      providerPromptEventIdsRef.current.clear();
      initialProviderPromptSeenRef.current.clear();
      committedTitleTransitionsRef.current.clear();
      manualTitleUpdateAttemptsRef.current.clear();
      for (const controller of titlePatchAbortControllersRef.current) {
        controller.abort();
      }
      titlePatchAbortControllersRef.current.clear();
      activeTurnSummariesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    autoTitleStatesRef.current = autoTitleStates;
    writeAutoTitleStates(resolveLocalStorage(), autoTitleStates);
  }, [autoTitleStates]);

  useEffect(() => {
    const hasLiveSession = (key: string) => liveSessionKeys?.has(key) ?? sessionsByKey.has(key);
    for (const key of providerPromptEventIdsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        providerPromptEventIdsRef.current.delete(key);
      }
    }
    for (const key of initialProviderPromptSeenRef.current) {
      if (!hasLiveSession(key)) {
        initialProviderPromptSeenRef.current.delete(key);
      }
    }
    for (const [key, state] of initialPromptSummariesRef.current) {
      if (
        !hasLiveSession(key)
        && (!state.retainWhileUnlisted || !titleMutationGenerationsRef.current.has(key))
      ) {
        discardInitialPromptSummary(key);
      }
    }
    for (const key of completionQueuedActionsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        completionQueuedActionsRef.current.delete(key);
      }
    }
    for (const key of titleMutationGenerationsRef.current.keys()) {
      const initialSummary = initialPromptSummariesRef.current.get(key);
      if (!hasLiveSession(key) && !initialSummary?.retainWhileUnlisted) {
        titleMutationGenerationsRef.current.delete(key);
        titleMutationIncarnationsRef.current.delete(key);
      }
    }
    for (const key of titleRevisionsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        titleRevisionsRef.current.delete(key);
        titleRevisionIncarnationsRef.current.delete(key);
        titleCasCapabilitiesRef.current.delete(key);
      }
    }
    for (const key of committedTitleTransitionsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        committedTitleTransitionsRef.current.delete(key);
      }
    }
    for (const key of completionAttemptsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        const attempt = completionAttemptsRef.current.get(key);
        if (attempt?.retryTimer) clearTimeout(attempt.retryTimer);
        completionAttemptsRef.current.delete(key);
      }
    }
    for (const key of manualTitleUpdateAttemptsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        manualTitleUpdateAttemptsRef.current.delete(key);
      }
    }
    for (const key of sessionIncarnationsRef.current.keys()) {
      if (!hasLiveSession(key)) {
        sessionIncarnationsRef.current.delete(key);
      }
    }
  }, [discardInitialPromptSummary, liveSessionKeys, sessionsByKey]);

  const updateAutoTitleStates = useCallback((updater: (prev: AutoTitleStates) => AutoTitleStates) => {
    const prev = autoTitleStatesRef.current;
    const candidate = updater(prev);
    const next = autoTitleStatesEqual(prev, candidate) ? prev : candidate;
    autoTitleStatesRef.current = next;
    setAutoTitleStates(next);
  }, []);

  useEffect(() => {
    if (incarnationOwnershipResetsRef.current.size === 0) {
      return;
    }
    const keys = new Set(incarnationOwnershipResetsRef.current);
    incarnationOwnershipResetsRef.current.clear();
    updateAutoTitleStates((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        delete next[key];
      }
      return next;
    });
  }, [sessionsByKey, updateAutoTitleStates]);

  useEffect(() => {
    updateAutoTitleStates((prev) => {
      let next = prev;
      for (const [key, session] of sessionsByKey) {
        if (next[key] !== undefined || session.title_state_supported !== true) {
          continue;
        }
        const titleState = normalizeSessionTitleState(session.title_state);
        if (!titleState) {
          continue;
        }
        if (next === prev) {
          next = { ...prev };
        }
        next[key] = deriveAutoTitleStateFromSession(
          undefined,
          session.title ?? null,
          titleState,
        );
      }
      return next;
    });
  }, [sessionsByKey, updateAutoTitleStates]);

  const beginTitleMutation = useCallback((key: string, expectedIncarnation?: string): symbol => {
    const token = Symbol(key);
    titleMutationGenerationsRef.current.set(key, token);
    if (expectedIncarnation) {
      titleMutationIncarnationsRef.current.set(key, expectedIncarnation);
    } else {
      titleMutationIncarnationsRef.current.delete(key);
    }
    return token;
  }, []);

  const isTitleMutationCurrent = useCallback(
    (key: string, token: symbol): boolean => {
      if (
        !controllerActiveRef.current
        || titleMutationGenerationsRef.current.get(key) !== token
      ) {
        return false;
      }
      const expectedIncarnation = titleMutationIncarnationsRef.current.get(key);
      const renderedIncarnation = sessionsByKeyRef.current.get(key)?.session_incarnation;
      return !expectedIncarnation
        || !renderedIncarnation
        || renderedIncarnation === expectedIncarnation;
    },
    [],
  );

  const enqueueTitlePatch = useCallback((
    key: string,
    action: () => Promise<UpdateSessionTitleResult>,
  ): Promise<UpdateSessionTitleResult> => {
    const previous = titlePatchTailsRef.current.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    titlePatchTailsRef.current.set(key, tail);
    void tail.then(() => {
      if (titlePatchTailsRef.current.get(key) === tail) {
        titlePatchTailsRef.current.delete(key);
      }
    });
    return result;
  }, []);

  const updateTitleWithTimeout = useCallback((
    key: string,
    machine: string,
    id: string,
    title: string | null,
    expectedTitleRevision: number | undefined,
    expectedSessionIncarnation: string | undefined,
    expectedSessionTitle: string | null | undefined,
    titleState?: SessionTitleState,
    titleCasSupported?: boolean,
  ): Promise<UpdateSessionTitleResult> => {
    const hasTitleCas = titleCasSupported ?? titleCasCapabilitiesRef.current.has(key);
    if (!hasTitleCas || expectedTitleRevision === undefined) {
      return Promise.resolve({
        ok: false,
        error: "session daemon does not expose title revision support",
      });
    }
    if (!expectedSessionIncarnation) {
      return Promise.resolve({
        ok: false,
        error: "session daemon does not expose a unique session incarnation",
      });
    }
    if (expectedSessionTitle === undefined) {
      return Promise.resolve({
        ok: false,
        error: "session daemon does not expose the observed title state",
      });
    }
    const controller = new AbortController();
    titlePatchAbortControllersRef.current.add(controller);
    return new Promise<UpdateSessionTitleResult>((resolve) => {
      let settled = false;
      const finish = (result: UpdateSessionTitleResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        titlePatchAbortControllersRef.current.delete(controller);
        const renderedSession = sessionsByKeyRef.current.get(key);
        const responseMatchesCurrentIncarnation = renderedSession === undefined
          || renderedSession.session_incarnation === expectedSessionIncarnation;
        if (result.titleRevision !== undefined && hasTitleCas && responseMatchesCurrentIncarnation) {
          titleCasCapabilitiesRef.current.add(key);
          titleRevisionsRef.current.set(key, result.titleRevision);
          titleRevisionIncarnationsRef.current.set(key, expectedSessionIncarnation);
        }
        resolve(result);
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish({ ok: false, error: "title update timed out" });
      }, TITLE_PATCH_TIMEOUT_MS);
      void updateSessionTitle(
        machine,
        id,
        title,
        controller.signal,
        expectedTitleRevision,
        expectedSessionIncarnation,
        expectedSessionTitle,
        titleState,
      ).then(
        finish,
        (error: unknown) => finish({
          ok: false,
          error: error instanceof Error && error.message ? error.message : "title update failed",
        }),
      );
    });
  }, []);

  const baseTitleForSession = useCallback((key: string, currentTitle: string | null | undefined): string | null => {
    const sessionTitleState = sessionsByKeyRef.current.get(key)?.title_state;
    if (sessionTitleState) {
      return sessionTitleState.topic;
    }
    const state = autoTitleStatesRef.current[key];
    if (state) {
      return state.baseTitleConfirmed ? state.baseTitle : null;
    }
    const baseTitle = recoverAutoTitleBase(currentTitle, sessionTitleState);
    if (baseTitle) {
      updateAutoTitleStates((prev) => ({
        ...prev,
        [key]: { baseTitle, baseTitleConfirmed: true, disabled: false, ownedTitle: currentTitle ?? null },
      }));
    }
    return baseTitle;
  }, [updateAutoTitleStates]);

  const rememberSessionTitle = useCallback((
    machine: string,
    id: string,
    title: string | null,
    titleState?: SessionTitleState,
    expectedSessionIncarnation?: string,
  ) => {
    const key = `${machine}/${id}`;
    const titleRevision = titleRevisionsRef.current.get(key);
    setSessions((prev) => prev.map((item) => {
      if (
        item.machine !== machine
        || item.id !== id
        || (
          expectedSessionIncarnation !== undefined
          && item.session_incarnation !== expectedSessionIncarnation
        )
      ) {
        return item;
      }
      return {
        ...item,
        title,
        ...(titleState ? { title_state: titleState } : {}),
        ...(titleRevision === undefined ? {} : { title_revision: titleRevision }),
      };
    }));
  }, [setSessions]);

  const updateManualSessionTitle = useCallback(async (session: Session, title: string | null): Promise<ApiResult> => {
    const key = sessionKey(session);
    discardInitialPromptSummary(key);
    completionQueuedActionsRef.current.delete(key);
    beginTitleMutation(key, session.session_incarnation);
    const priorAttempt = manualTitleUpdateAttemptsRef.current.get(key);
    const attempt: ManualTitleUpdateAttempt = {
      token: Symbol(key),
      previousState: priorAttempt?.previousState ?? autoTitleStatesRef.current[key],
    };
    manualTitleUpdateAttemptsRef.current.set(key, attempt);
    updateAutoTitleStates((prev) => {
      const current = prev[key];
      const recoveredBase = current ? null : recoverAutoTitleBase(session.title, session.title_state);
      return {
        ...prev,
        [key]: current
          ? { ...current, disabled: true }
          : {
              baseTitle: recoveredBase,
              baseTitleConfirmed: recoveredBase !== null,
              disabled: true,
              ownedTitle: session.title ?? null,
            },
      };
    });

    let result: ApiResult;
    const manualTitleState = (title ? userSessionTitleState(title) : null) ?? emptySessionTitleState();
    const canonicalTitle = manualTitleState.topic;
    const structuredTitleState = session.title_state_supported === true
      ? manualTitleState ?? undefined
      : undefined;
    try {
      result = await enqueueTitlePatch(key, async () => {
        if (!controllerActiveRef.current) {
          return { ok: false, error: "title controller unmounted" };
        }
        let expectedSessionTitle = session.title ?? null;
        let candidate = await updateTitleWithTimeout(
          key,
          session.machine,
          session.id,
          canonicalTitle,
          titleRevisionsRef.current.get(key),
          session.session_incarnation,
          expectedSessionTitle,
          structuredTitleState,
        );
        for (
          let retry = 0;
          candidate.conflict && retry < MAX_MANUAL_TITLE_CONFLICT_RETRIES;
          retry += 1
        ) {
          if (candidate.actualTitle === undefined) {
            break;
          }
          expectedSessionTitle = candidate.actualTitle;
          candidate = await updateTitleWithTimeout(
            key,
            session.machine,
            session.id,
            canonicalTitle,
            titleRevisionsRef.current.get(key),
            session.session_incarnation,
            expectedSessionTitle,
            structuredTitleState,
          );
        }
        return candidate;
      });
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error && error.message ? error.message : "title update failed",
      };
    }
    if (manualTitleUpdateAttemptsRef.current.get(key)?.token !== attempt.token) {
      return result;
    }
    manualTitleUpdateAttemptsRef.current.delete(key);
    if (!result.ok) {
      let authoritativeTitle: string | null | undefined;
      try {
        const response = await listSessions(enabledMachinesRef.current);
        if (liveRef.current) {
          applyLiveSessionList(response);
        }
        const authoritativeSession = response.sessions.find((item) => sessionKey(item) === key);
        authoritativeTitle = authoritativeSession?.title;
        if (
          authoritativeSession?.title_revision !== undefined
          && authoritativeSession.session_incarnation
        ) {
          titleRevisionsRef.current.set(key, authoritativeSession.title_revision);
          titleRevisionIncarnationsRef.current.set(key, authoritativeSession.session_incarnation);
          titleCasCapabilitiesRef.current.add(key);
        } else if (authoritativeSession) {
          titleRevisionsRef.current.delete(key);
          titleRevisionIncarnationsRef.current.delete(key);
          titleCasCapabilitiesRef.current.delete(key);
        }
      } catch {
        authoritativeTitle = undefined;
      }
      const tentativeTransition = committedTitleTransitionsRef.current.get(key);
      if (
        authoritativeTitle !== undefined
        && tentativeTransition
        && !tentativeTransition.committed
        && tentativeTransition.previousTitle === (attempt.previousState?.ownedTitle ?? session.title ?? null)
        && tentativeTransition.committedTitle === authoritativeTitle
      ) {
        committedTitleTransitionsRef.current.set(key, { ...tentativeTransition, committed: true });
        updateAutoTitleStates((prev) => ({
          ...prev,
          [key]: {
            baseTitle: attempt.previousState?.baseTitleConfirmed
              ? attempt.previousState.baseTitle
              : authoritativeTitle,
            baseTitleConfirmed: true,
            disabled: false,
            ownedTitle: authoritativeTitle,
          },
        }));
        rememberSessionTitle(
          session.machine,
          session.id,
          authoritativeTitle,
          undefined,
          session.session_incarnation,
        );
        return result;
      }
      updateAutoTitleStates((prev) => {
        if (attempt.previousState) {
          return { ...prev, [key]: attempt.previousState };
        }
        const { [key]: _removed, ...next } = prev;
        return next;
      });
      void refreshRef.current();
      return result;
    }

    updateAutoTitleStates((prev) => ({
      ...prev,
      [key]: {
        baseTitle: canonicalTitle,
        baseTitleConfirmed: true,
        disabled: true,
        ownedTitle: canonicalTitle,
      },
    }));
    rememberSessionTitle(
      session.machine,
      session.id,
      canonicalTitle,
      structuredTitleState,
      session.session_incarnation,
    );
    return result;
  }, [
    beginTitleMutation,
    applyLiveSessionList,
    discardInitialPromptSummary,
    enabledMachinesRef,
    enqueueTitlePatch,
    liveRef,
    rememberSessionTitle,
    updateTitleWithTimeout,
    updateAutoTitleStates,
  ]);

  const fetchLiveSession = useCallback(async (key: string): Promise<Session | undefined> => {
    const res = await listSessions(enabledMachinesRef.current);
    if (liveRef.current) {
      applyLiveSessionList(res);
    }
    return res.sessions.find((item) => sessionKey(item) === key);
  }, [applyLiveSessionList, enabledMachinesRef, liveRef]);

  const fetchLiveTitle = useCallback(async (key: string): Promise<string | null> => (
    (await fetchLiveSession(key))?.title ?? null
  ), [fetchLiveSession]);

  const isAutoTitleDisabled = useCallback((key: string) => Boolean(autoTitleStatesRef.current[key]?.disabled), []);

  const makeAutoTitleDeps = useCallback((
    key: string,
    options: AutoTitleDependencyOptions = {},
  ) => {
    const {
      currentTitle = () => fetchLiveTitle(key),
      token,
      expectedTitleRevision,
      expectedSessionIncarnation,
      expectedSessionTitle,
      titleStateSupported,
      titleCasSupported,
      trace,
      requireSummarizer = false,
    } = options;
    const isCurrent = () => token === undefined || isTitleMutationCurrent(key, token);
    return {
      summarizeTitle: async (body: TitleSummaryRequest) => {
        const result = trace
          ? await summarizeSessionTitleWithTrace(body, trace)
          : await summarizeSessionTitle(body);
        return requireSummarizer && (!result.ok || result.source !== "summarizer")
          ? { ok: false, error: result.ok ? "title summarizer unavailable" : result.error }
          : result;
      },
      updateTitle: (
        machine: string,
        id: string,
        title: string | null,
        titleState?: SessionTitleState,
      ) => enqueueTitlePatch(
        key,
        async () => {
          if (!isCurrent()) {
            return { ok: false, error: "title mutation superseded" };
          }
          if (trace) recordTitleLifecycle(trace, "patch_started");
          try {
            const result = await updateTitleWithTimeout(
              key,
              machine,
              id,
              title,
              expectedTitleRevision,
              expectedSessionIncarnation,
              expectedSessionTitle,
              (titleStateSupported ?? sessionsByKeyRef.current.get(key)?.title_state_supported === true)
                ? titleState
                : undefined,
              titleCasSupported,
            );
            if (trace) recordTitleLifecycle(trace, result.ok ? "patch_confirmed" : "patch_failed");
            return result;
          } catch (error) {
            if (trace) recordTitleLifecycle(trace, "patch_error");
            throw error;
          }
        },
      ),
      currentTitle: async () => {
        if (!isCurrent()) {
          return undefined;
        }
        const title = await currentTitle();
        return isCurrent() ? title : undefined;
      },
      rememberTitle: (
        machine: string,
        id: string,
        title: string | null,
        titleState?: SessionTitleState,
      ) => {
        if (isCurrent()) {
          rememberSessionTitle(
            machine,
            id,
            title,
            titleState,
            expectedSessionIncarnation,
          );
        }
      },
      onError: (message: string) => {
        if (isCurrent()) {
          setError(message);
        }
      },
      refresh: () => {
        if (isCurrent()) {
          void refreshRef.current();
        }
      },
    };
  }, [
    enqueueTitlePatch,
    fetchLiveTitle,
    isTitleMutationCurrent,
    rememberSessionTitle,
    setError,
    updateTitleWithTimeout,
  ]);

  const runTurnPromptSummary = useCallback(
    async (key: string, pending: PendingTurnTitleRefresh) => {
      const titleSnapshot = sessionsByKeyRef.current.get(key);
      const expectedTitleRevision = titleRevisionsRef.current.get(key);
      const token = beginTitleMutation(key, pending.session.session_incarnation);
      activeTurnSummariesRef.current.set(key, { pending, token });
      const committedCreateTitle = committedTitleTransitionsRef.current.get(key);
      const consumeCommittedTitle = shouldConsumeTitleTransition(
        committedCreateTitle,
        pending.expectedCurrentTitle,
      );
      const expectedCurrentTitle = consumeCommittedTitle
        && committedCreateTitle?.rebasePendingTitle
        ? committedCreateTitle.committedTitle
        : pending.expectedCurrentTitle;
      if (consumeCommittedTitle) {
        committedTitleTransitionsRef.current.delete(key);
      }
      const trace = titleSummaryTrace(pending.session, "turn", 1);
      try {
        const result = await applyTurnPromptAutoTitleSummary({
          session: pending.session,
          prompt: pending.prompt,
          baseTitle: baseTitleForSession(key, expectedCurrentTitle) ?? pending.baseTitle,
          titleState: structuredTitleStateForSession(titleSnapshot),
          expectedCurrentTitle,
          isDisabled: () => isAutoTitleDisabled(key),
          glance,
          ...makeAutoTitleDeps(key, {
            token,
            expectedTitleRevision,
            expectedSessionIncarnation: pending.session.session_incarnation,
            expectedSessionTitle: expectedCurrentTitle ?? null,
            trace,
          }),
          onTitlePending: (title) => {
            if (!isTitleMutationCurrent(key, token)) {
              return;
            }
            committedTitleTransitionsRef.current.set(key, {
              previousTitle: expectedCurrentTitle,
              committedTitle: title,
              rebasePendingTitle: false,
              committed: false,
            });
          },
          onTitleCommitted: (title, titleState) => {
            if (!isTitleMutationCurrent(key, token)) {
              return;
            }
            committedTitleTransitionsRef.current.set(key, {
              previousTitle: expectedCurrentTitle,
              committedTitle: title,
              rebasePendingTitle: false,
              committed: true,
            });
            updateAutoTitleStates((prev) => {
              const current = prev[key];
              return current?.disabled
                ? prev
                : {
                    ...prev,
                    [key]: {
                      baseTitle: titleState?.topic
                        ?? (!current?.baseTitleConfirmed ? title : current.baseTitle ?? pending.baseTitle),
                      baseTitleConfirmed: titleState
                        ? titleState.topic_source !== "none"
                        : true,
                      disabled: false,
                      ownedTitle: title,
                    },
                  };
            });
          },
        });
        recordTitleLifecycle(trace, result.replaceAll("-", "_"));
      } catch (error) {
        recordTitleLifecycle(trace, "flow_error");
        throw error;
      } finally {
        if (activeTurnSummariesRef.current.get(key)?.token === token) {
          activeTurnSummariesRef.current.delete(key);
        }
      }
    },
    [
      baseTitleForSession,
      beginTitleMutation,
      isAutoTitleDisabled,
      isTitleMutationCurrent,
      makeAutoTitleDeps,
      updateAutoTitleStates,
    ],
  );

  const runInitialPromptSummary = useCallback(
    async (
      key: string,
      state: InitialPromptSummaryState,
    ): Promise<CreatePromptAutoTitleSummaryResult> => {
      const renderedTitleSnapshot = sessionsByKeyRef.current.get(key);
      if (renderedTitleSnapshot) {
        const capturedCreateIncarnationChanged = Boolean(
          state.fenceToCapturedIncarnation
          && state.session.session_incarnation
          && renderedTitleSnapshot.session_incarnation
          && renderedTitleSnapshot.session_incarnation !== state.session.session_incarnation,
        );
        const sameSessionRecord = !capturedCreateIncarnationChanged
          && (
            renderedTitleSnapshot.session_incarnation === state.session.session_incarnation
            || (
              renderedTitleSnapshot.created_at !== undefined
              && state.session.created_at !== undefined
              && renderedTitleSnapshot.created_at === state.session.created_at
            )
          );
        if (!sameSessionRecord || (renderedTitleSnapshot.title ?? null) !== state.expectedCurrentTitle) {
          return "stale-title";
        }
      }
      const titleSnapshot = renderedTitleSnapshot ?? state.session;
      const expectedCurrentTitle = renderedTitleSnapshot?.title ?? state.expectedCurrentTitle;
      const expectedTitleRevision = renderedTitleSnapshot
        ? titleRevisionsRef.current.get(key) ?? renderedTitleSnapshot.title_revision
        : state.session.title_revision;
      const expectedSessionIncarnation = titleSnapshot.session_incarnation;
      const titleCasSupported = expectedTitleRevision !== undefined
        && expectedSessionIncarnation !== undefined;
      const trace = titleSummaryTrace(state.session, "initial", state.attempts, state.attemptId);
      try {
        return await applyCreatePromptAutoTitleSummary({
          session: state.session,
          prompt: state.prompt,
          baseTitle: state.baseTitle,
          titleState: structuredTitleStateForSession(titleSnapshot),
          fallbackTitle: state.fallbackTitle,
          expectedCurrentTitle,
          isDisabled: () => isAutoTitleDisabled(key),
          ...makeAutoTitleDeps(key, {
            currentTitle: async () => {
              if (isAutoTitleDisabled(key)) {
                return undefined;
              }
              const currentSession = sessionsByKeyRef.current.get(key);
              if (!currentSession) {
                return expectedCurrentTitle;
              }
              const title = await fetchLiveTitle(key);
              return isAutoTitleDisabled(key) ? undefined : title;
            },
            token: state.token,
            expectedTitleRevision,
            expectedSessionIncarnation,
            expectedSessionTitle: expectedCurrentTitle,
            titleStateSupported: titleSnapshot.title_state_supported === true,
            titleCasSupported,
            trace,
            requireSummarizer: true,
          }),
          onTitlePending: (title) => {
            if (
              !isTitleMutationCurrent(key, state.token)
              || initialPromptSummariesRef.current.get(key)?.token !== state.token
            ) {
              return;
            }
            committedTitleTransitionsRef.current.set(key, {
              previousTitle: expectedCurrentTitle,
              committedTitle: title,
              rebasePendingTitle: true,
              committed: false,
            });
          },
          onTitleCommitted: (title, titleState) => {
            if (
              !isTitleMutationCurrent(key, state.token)
              || initialPromptSummariesRef.current.get(key)?.token !== state.token
            ) {
              return;
            }
            committedTitleTransitionsRef.current.set(key, {
              previousTitle: expectedCurrentTitle,
              committedTitle: title,
              rebasePendingTitle: true,
              committed: true,
            });
            updateAutoTitleStates((prev) => {
              const current = prev[key];
              return current?.disabled
                ? prev
                : {
                    ...prev,
                    [key]: {
                      baseTitle: titleState?.topic ?? (state.baseTitle === null ? title : state.baseTitle),
                      baseTitleConfirmed: titleState
                        ? titleState.topic_source !== "none"
                        : true,
                      disabled: false,
                      ownedTitle: title,
                    },
                  };
            });
          },
        });
      } catch (error) {
        if (isTitleMutationCurrent(key, state.token)) {
          setError(error instanceof Error && error.message ? error.message : "title update failed");
          void refreshRef.current();
        }
        return "update-failed";
      }
    },
    [
      fetchLiveTitle,
      isAutoTitleDisabled,
      isTitleMutationCurrent,
      makeAutoTitleDeps,
      setError,
      updateAutoTitleStates,
    ],
  );

  const runTurnPromptSummaryRef = useRef(runTurnPromptSummary);
  runTurnPromptSummaryRef.current = runTurnPromptSummary;
  const turnTitleSchedulerRef = useRef<TurnTitleIdleScheduler<PendingTurnTitleRefresh> | null>(null);
  if (turnTitleSchedulerRef.current === null) {
    turnTitleSchedulerRef.current = createTurnTitleIdleScheduler<PendingTurnTitleRefresh>({
      idleMs: TURN_TITLE_IDLE_MS,
      run: (key, pending) => void runTurnPromptSummaryRef.current(key, pending),
    });
  }
  const turnTitleScheduler = turnTitleSchedulerRef.current;

  const cancelLegacyAutoTitleWork = useCallback((
    session: Pick<Session, "machine" | "id" | "session_incarnation">,
  ) => {
    const key = sessionKey(session);
    const pendingIdleWork = turnTitleScheduler.take(key);
    const hadLegacyWork = initialPromptSummariesRef.current.has(key)
      || activeTurnSummariesRef.current.has(key)
      || completionQueuedActionsRef.current.has(key)
      || completionAttemptsRef.current.has(key)
      || pendingIdleWork !== undefined;
    discardInitialPromptSummary(key);
    completionQueuedActionsRef.current.delete(key);
    activeTurnSummariesRef.current.delete(key);
    const completionAttempt = completionAttemptsRef.current.get(key);
    if (completionAttempt?.retryTimer) clearTimeout(completionAttempt.retryTimer);
    completionAttemptsRef.current.delete(key);
    if (hadLegacyWork) {
      beginTitleMutation(key, session.session_incarnation);
    }
  }, [beginTitleMutation, discardInitialPromptSummary, turnTitleScheduler]);

  useEffect(() => () => turnTitleScheduler.dispose(), [turnTitleScheduler]);

  const startInitialPromptSummary = useCallback(function startInitialPromptSummary(
    key: string,
    state: InitialPromptSummaryState,
  ): Promise<void> {
    if (state.inFlight || state.attempts >= MAX_COMPLETION_ATTEMPTS) {
      return Promise.resolve();
    }
    if (state.nextRetryAt > Date.now()) {
      if (state.retryTimer === null) {
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          if (initialPromptSummariesRef.current.get(key) !== state) {
            return;
          }
          const currentSession = sessionsByKeyRef.current.get(key);
          if (
            currentSession
            && currentSession.title === state.expectedCurrentTitle
          ) {
            void startInitialPromptSummary(key, state);
          }
        }, state.nextRetryAt - Date.now());
      }
      return Promise.resolve();
    }
    const attemptedTitle = state.expectedCurrentTitle;
    state.inFlight = true;
    state.attempts += 1;
    return runInitialPromptSummary(key, state).then(async (result) => {
      const trace = titleSummaryTrace(state.session, "initial", state.attempts, state.attemptId);
      recordTitleLifecycle(trace, result.replaceAll("-", "_"));
      if (initialPromptSummariesRef.current.get(key) !== state) {
        return;
      }
      state.inFlight = false;
      if (
        (result === "update-failed" || result === "stale-title")
        && isTitleMutationCurrent(key, state.token)
      ) {
        const liveTitle = await fetchLiveTitle(key);
        if (initialPromptSummariesRef.current.get(key) !== state) {
          return;
        }
        const transition = committedTitleTransitionsRef.current.get(key);
        if (
          typeof liveTitle === "string"
          && (
            liveTitle === state.supersededAutomaticTitle
            || liveTitle === state.supersededPreviousTitle
          )
        ) {
          state.expectedCurrentTitle = liveTitle;
          if (liveTitle === state.supersededAutomaticTitle) {
            state.supersededAutomaticTitle = null;
          }
          if (liveTitle === state.supersededPreviousTitle) {
            state.supersededPreviousTitle = null;
          }
          committedTitleTransitionsRef.current.delete(key);
          rememberSessionTitle(
            state.session.machine,
            state.session.id,
            liveTitle,
            undefined,
            state.session.session_incarnation,
          );
        } else if (
          liveTitle !== undefined
          && transition
          && !transition.committed
          && transition.previousTitle === attemptedTitle
          && transition.committedTitle === liveTitle
        ) {
          committedTitleTransitionsRef.current.delete(key);
          if (transition.rebasePendingTitle) {
            updateAutoTitleStates((prev) => {
              const current = prev[key];
              return current?.disabled
                ? prev
                : {
                    ...prev,
                    [key]: {
                      baseTitle: state.baseTitle === null ? liveTitle : state.baseTitle,
                      baseTitleConfirmed: true,
                      disabled: false,
                      ownedTitle: liveTitle,
                    },
                  };
            });
          } else {
            state.expectedCurrentTitle = liveTitle;
            rememberSessionTitle(
            state.session.machine,
            state.session.id,
            liveTitle,
            undefined,
            state.session.session_incarnation,
          );
          }
        } else if (result === "update-failed") {
          rememberSessionTitle(
            state.session.machine,
            state.session.id,
            attemptedTitle,
            undefined,
            state.session.session_incarnation,
          );
        }
      }
      const current = autoTitleStatesRef.current[key];
      if (current?.baseTitleConfirmed && !current.disabled && current.ownedTitle !== undefined) {
        discardInitialPromptSummary(key);
        if (state.queuedAction) {
          turnTitleScheduler.set(key, {
            ...state.queuedAction,
            baseTitle: current.baseTitle,
            expectedCurrentTitle: current.ownedTitle,
          });
        }
        return;
      }
      if (current?.disabled) {
        discardInitialPromptSummary(key);
        return;
      }
      if (state.attempts >= MAX_COMPLETION_ATTEMPTS) {
        recordTitleLifecycle(trace, "retry_exhausted");
        completionQueuedActionsRef.current.set(key, state.queuedAction);
        const completionAttempt = completionAttemptsRef.current.get(key);
        if (completionAttempt?.retryTimer) clearTimeout(completionAttempt.retryTimer);
        completionAttemptsRef.current.delete(key);
        discardInitialPromptSummary(key);
        void refreshRef.current();
        return;
      }
      state.nextRetryAt = Date.now()
        + COMPLETION_RETRY_BASE_MS * (2 ** Math.max(0, state.attempts - 1));
      recordTitleLifecycle(trace, "retry_scheduled");
      const currentSession = sessionsByKeyRef.current.get(key);
      if (
        currentSession
        && currentSession.title === state.expectedCurrentTitle
      ) {
        void startInitialPromptSummary(key, state);
      }
    });
  }, [
    discardInitialPromptSummary,
    fetchLiveTitle,
    isTitleMutationCurrent,
    rememberSessionTitle,
    runInitialPromptSummary,
    turnTitleScheduler,
    updateAutoTitleStates,
  ]);

  useLayoutEffect(() => {
    if (incarnationTitleWorkRef.current.size === 0) {
      return;
    }
    const changes = Array.from(incarnationTitleWorkRef.current.entries());
    incarnationTitleWorkRef.current.clear();
    for (const [key, change] of changes) {
      const pendingTurn = turnTitleScheduler.take(key);
      if (!change.sameSessionRecord) {
        continue;
      }
      const resumedIdentity = {
        machine: change.session.machine,
        id: change.session.id,
        created_at: change.session.created_at,
        session_incarnation: change.session.session_incarnation,
      };
      const resumedTitle = change.session.title ?? null;
      const revisionAdvanced = change.previousTitleRevision !== undefined
        && change.session.title_revision !== undefined
        && change.session.title_revision > change.previousTitleRevision;
      const snapshotConfirmsTransition = Boolean(
        change.transition
        && change.transition.committedTitle === resumedTitle
        && (change.transition.committed || revisionAdvanced),
      );
      if (snapshotConfirmsTransition && change.transition) {
        committedTitleTransitionsRef.current.set(key, { ...change.transition, committed: true });
        updateAutoTitleStates((prev) => {
          const current = prev[key];
          return current?.disabled
            ? prev
            : {
                ...prev,
                [key]: deriveAutoTitleStateFromSession(
                  current,
                  resumedTitle,
                  change.session.title_state,
                ),
              };
        });
      }
      const state = autoTitleStatesRef.current[key];
      const titleMatchesTransition = (expectedTitle: string | null | undefined) => Boolean(
        change.transition
        && snapshotConfirmsTransition
        && change.transition.previousTitle === expectedTitle,
      );
      const titleMatchesOwnership = state?.ownedTitle === undefined
        || state.ownedTitle === resumedTitle
        || titleMatchesTransition(state.ownedTitle);
      const pendingMatches = !pendingTurn
        || pendingTurn.expectedCurrentTitle === resumedTitle
        || titleMatchesTransition(pendingTurn.expectedCurrentTitle);
      const initialMatches = !change.initialSummary
        || change.initialSummary.expectedCurrentTitle === resumedTitle
        || titleMatchesTransition(change.initialSummary.expectedCurrentTitle);
      const activeMatches = !change.activeTurnSummary
        || change.activeTurnSummary.expectedCurrentTitle === resumedTitle
        || titleMatchesTransition(change.activeTurnSummary.expectedCurrentTitle);
      if (!titleMatchesOwnership || !pendingMatches || !initialMatches || !activeMatches) {
        committedTitleTransitionsRef.current.delete(key);
        updateAutoTitleStates((prev) => {
          const current = prev[key];
          return current
            ? { ...prev, [key]: { ...current, disabled: true } }
            : prev;
        });
        continue;
      }
      if (pendingTurn) {
        turnTitleScheduler.set(key, {
          ...pendingTurn,
          session: resumedIdentity,
        });
      }
      if (change.activeTurnSummary && !snapshotConfirmsTransition) {
        void runTurnPromptSummary(key, {
          ...change.activeTurnSummary,
          session: resumedIdentity,
        });
      }
      if (change.hasCompletionQueuedAction) {
        completionQueuedActionsRef.current.set(key, change.completionQueuedAction
          ? { ...change.completionQueuedAction, session: resumedIdentity }
          : null);
      }
      if (!change.initialSummary) {
        continue;
      }
      const previous = change.initialSummary;
      if (snapshotConfirmsTransition) {
        if (previous.queuedAction) {
          turnTitleScheduler.set(key, {
            ...previous.queuedAction,
            session: resumedIdentity,
            baseTitle: autoTitleStatesRef.current[key]?.baseTitle ?? resumedTitle,
            expectedCurrentTitle: resumedTitle,
          });
        }
        continue;
      }
      const token = beginTitleMutation(key, change.session.session_incarnation);
      const restarted: InitialPromptSummaryState = {
        ...previous,
        session: initialPromptSummarySession(change.session),
        token,
        attempts: Math.max(0, previous.attempts - (previous.inFlight ? 1 : 0)),
        completionObserved: previous.completionObserved
          || authoritativeCompletionId(change.session) !== null,
        retainWhileUnlisted: false,
        inFlight: false,
        nextRetryAt: 0,
        retryTimer: null,
        queuedAction: previous.queuedAction
          ? { ...previous.queuedAction, session: resumedIdentity }
          : null,
      };
      initialPromptSummariesRef.current.set(key, restarted);
      void startInitialPromptSummary(key, restarted);
    }
  }, [
    beginTitleMutation,
    runTurnPromptSummary,
    sessionsByKey,
    startInitialPromptSummary,
    turnTitleScheduler,
    updateAutoTitleStates,
  ]);

  const applyCreatePromptSummary = useCallback(
    async (
      session: InitialPromptSummarySession,
      prompt: string,
      baseTitle: string | null,
      fallbackTitle: string,
    ) => {
      const key = sessionKey(session);
      if (session.retitle_path === "daemon_v2" || session.retitle_path === "daemon_v3") {
        cancelLegacyAutoTitleWork(session);
        return;
      }
      const renderedSession = sessionsByKeyRef.current.get(key);
      if (
        session.session_incarnation
        && renderedSession?.session_incarnation
        && renderedSession.session_incarnation !== session.session_incarnation
      ) {
        return;
      }
      const token = beginTitleMutation(key, session.session_incarnation);
      updateAutoTitleStates((prev) => ({
        ...prev,
        [key]: {
          baseTitle,
          baseTitleConfirmed: baseTitle !== null,
          disabled: false,
          ownedTitle: session.title ?? null,
        },
      }));
      const expectedCurrentTitle = session.title ?? null;
      const initialState: InitialPromptSummaryState = {
        prompt,
        session: initialPromptSummarySession(session),
        token,
        attemptId: createTitleSummaryAttemptId(),
        baseTitle,
        fallbackTitle,
        expectedCurrentTitle,
        supersededAutomaticTitle: null,
        supersededPreviousTitle: null,
        attempts: 0,
        completionObserved: false,
        retainWhileUnlisted: true,
        fenceToCapturedIncarnation: true,
        inFlight: false,
        nextRetryAt: 0,
        retryTimer: null,
        queuedAction: null,
      };
      initialPromptSummariesRef.current.set(key, initialState);
      await startInitialPromptSummary(key, initialState);
    },
    [beginTitleMutation, cancelLegacyAutoTitleWork, startInitialPromptSummary, updateAutoTitleStates],
  );

  const noteTurnPromptSubmitted = useCallback(
    (session: Session, prompt: string, eventId?: string, submittedAt?: string) => {
      const key = sessionKey(session);
      if (session.retitle_path === "daemon_v2" || session.retitle_path === "daemon_v3") {
        cancelLegacyAutoTitleWork(session);
        return;
      }
      const state = autoTitleStatesRef.current[key];
      if (!state || state.disabled) {
        discardInitialPromptSummary(key);
        return;
      }
      if (state.ownedTitle === undefined) {
        updateAutoTitleStates((prev) => ({
          ...prev,
          [key]: { ...state, disabled: true },
        }));
        return;
      }
      const committedCreateTitle = committedTitleTransitionsRef.current.get(key);
      const followsCommittedTransition = Boolean(
        committedCreateTitle
        && committedCreateTitle.committed
        && committedCreateTitle.previousTitle === session.title
        && committedCreateTitle.committedTitle === state?.ownedTitle,
      );
      const followsTentativeTransition = Boolean(
        committedCreateTitle
        && !committedCreateTitle.committed
        && committedCreateTitle.previousTitle === state.ownedTitle
        && committedCreateTitle.committedTitle === session.title,
      );
      if (
        state.ownedTitle !== session.title
        && !followsCommittedTransition
        && !followsTentativeTransition
      ) {
        updateAutoTitleStates((prev) => ({
          ...prev,
          [key]: { ...state, disabled: true },
        }));
        return;
      }
      const titlePrompt = promptTitleSuffix(prompt);
      if (!titlePrompt) {
        return;
      }
      const providerPromptSeenBefore = initialProviderPromptSeenRef.current.has(key);
      initialProviderPromptSeenRef.current.add(key);
      const completionDerivedTransition = committedCreateTitle
        && !providerPromptSeenBefore
        && providerPromptBelongsToCompletedTurn(session, submittedAt)
        && !committedCreateTitle.rebasePendingTitle
        && (
          isAutoTitlePlaceholder(committedCreateTitle.previousTitle)
          || committedCreateTitle.previousTitle === null
        )
        && (
          committedCreateTitle.previousTitle === (session.title ?? null)
          || committedCreateTitle.committedTitle === (session.title ?? null)
        )
        ? committedCreateTitle
        : null;
      const normalizedEventId = eventId?.trim();
      if (normalizedEventId) {
        const eventIds = providerPromptEventIdsRef.current.get(key) ?? [];
        if (eventIds.includes(normalizedEventId)) {
          return;
        }
        eventIds.push(normalizedEventId);
        if (eventIds.length > MAX_PROVIDER_PROMPT_EVENT_IDS_PER_SESSION) {
          eventIds.splice(0, eventIds.length - MAX_PROVIDER_PROMPT_EVENT_IDS_PER_SESSION);
        }
        providerPromptEventIdsRef.current.set(key, eventIds);
      }
      const pendingInitialSummary = initialPromptSummariesRef.current.get(key);
      if (pendingInitialSummary) {
        if (titlePrompt !== pendingInitialSummary.prompt) {
          pendingInitialSummary.queuedAction = {
            session: {
              machine: session.machine,
              id: session.id,
              created_at: session.created_at,
              session_incarnation: session.session_incarnation,
            },
            prompt: titlePrompt,
          };
        }
        return;
      }
      if (completionQueuedActionsRef.current.has(key)) {
        completionQueuedActionsRef.current.set(key, {
          session: {
            machine: session.machine,
            id: session.id,
            created_at: session.created_at,
            session_incarnation: session.session_incarnation,
          },
          prompt: titlePrompt,
        });
        return;
      }
      const establishesInitialIntent = (
        isProvisionalAutoTitle(session)
        && !state.baseTitleConfirmed
      ) || completionDerivedTransition !== null;
      if (establishesInitialIntent) {
        const completionAttempt = completionAttemptsRef.current.get(key);
        if (completionAttempt?.retryTimer) clearTimeout(completionAttempt.retryTimer);
        completionAttemptsRef.current.delete(key);
        const token = beginTitleMutation(key, session.session_incarnation);
        updateAutoTitleStates((prev) => ({
          ...prev,
          [key]: {
            baseTitle: null,
            baseTitleConfirmed: false,
            disabled: false,
            ownedTitle: session.title ?? null,
          },
        }));
        const initialState: InitialPromptSummaryState = {
          prompt: titlePrompt,
          session: initialPromptSummarySession(session),
          token,
          attemptId: createTitleSummaryAttemptId(),
          baseTitle: null,
          fallbackTitle: titlePrompt,
          expectedCurrentTitle: session.title ?? null,
          supersededAutomaticTitle: completionDerivedTransition?.committedTitle ?? null,
          supersededPreviousTitle: completionDerivedTransition?.previousTitle ?? null,
          attempts: 0,
          completionObserved: authoritativeCompletionId(session) !== null,
          retainWhileUnlisted: false,
          fenceToCapturedIncarnation: false,
          inFlight: false,
          nextRetryAt: 0,
          retryTimer: null,
          queuedAction: null,
        };
        initialPromptSummariesRef.current.set(key, initialState);
        void startInitialPromptSummary(key, initialState);
        return;
      }
      turnTitleScheduler.set(key, {
        session: {
          machine: session.machine,
          id: session.id,
          created_at: session.created_at,
          session_incarnation: session.session_incarnation,
        },
        prompt: titlePrompt,
        baseTitle: baseTitleForSession(key, session.title),
        expectedCurrentTitle: session.title ?? null,
      });
    },
    [
      baseTitleForSession,
      beginTitleMutation,
      cancelLegacyAutoTitleWork,
      discardInitialPromptSummary,
      startInitialPromptSummary,
      turnTitleScheduler,
      updateAutoTitleStates,
    ],
  );

  const prepareCompletionSummary = useCallback(
    async (key: string, session: Session, trace: TitleSummaryTrace) => {
      return prepareTurnCompletionAutoTitleSummary({
        session: { machine: session.machine, id: session.id },
        baseTitle: null,
        titleState: structuredTitleStateForSession(session),
        expectedCurrentTitle: session.title ?? null,
        isDisabled: () => isAutoTitleDisabled(key),
        glance,
        summarizeTitle: (body) => summarizeSessionTitleWithTrace(body, trace),
      });
    },
    [isAutoTitleDisabled],
  );

  const commitCompletionTitle = useCallback(
    async (
      key: string,
      session: Session,
      title: string | null,
      titleState: SessionTitleState | undefined,
      expectedTitleRevision: number | undefined,
      token: symbol,
      trace: TitleSummaryTrace,
    ) => {
      return commitSummarizedTitle({
        session: { machine: session.machine, id: session.id },
        ...makeAutoTitleDeps(key, {
          token,
          expectedTitleRevision,
          expectedSessionIncarnation: session.session_incarnation,
          expectedSessionTitle: session.title ?? null,
          trace,
        }),
        onTitlePending: (title) => {
          if (!isTitleMutationCurrent(key, token)) {
            return;
          }
          committedTitleTransitionsRef.current.set(key, {
            previousTitle: session.title ?? null,
            committedTitle: title,
            rebasePendingTitle: false,
            committed: false,
          });
        },
        onTitleCommitted: (title, committedTitleState) => {
          if (!isTitleMutationCurrent(key, token)) {
            return;
          }
          committedTitleTransitionsRef.current.set(key, {
            previousTitle: session.title ?? null,
            committedTitle: title,
            rebasePendingTitle: false,
            committed: true,
          });
          updateAutoTitleStates((prev) => {
            const current = prev[key];
            return current?.disabled
              ? prev
              : {
                  ...prev,
                  [key]: {
                    baseTitle: committedTitleState?.topic ?? title,
                    baseTitleConfirmed: committedTitleState
                      ? committedTitleState.topic_source !== "none"
                      : true,
                    disabled: false,
                    ownedTitle: title,
                  },
                };
          });
          const queuedAction = completionQueuedActionsRef.current.get(key);
          completionQueuedActionsRef.current.delete(key);
          if (queuedAction) {
            turnTitleScheduler.set(key, {
              ...queuedAction,
              baseTitle: committedTitleState?.topic ?? title,
              expectedCurrentTitle: title,
            });
          }
        },
      }, title, titleState);
    },
    [isTitleMutationCurrent, makeAutoTitleDeps, turnTitleScheduler, updateAutoTitleStates],
  );

  const finishCompletionAttempt = useCallback((
    candidate: CompletionCandidate,
    result: TurnPromptAutoTitleSummaryResult,
  ) => {
    const trace = titleSummaryTrace(
      candidate.session,
      "completion",
      candidate.attempt,
      candidate.attemptId,
    );
    recordTitleLifecycle(trace, result.replaceAll("-", "_"));
    const attempt = completionAttemptsRef.current.get(candidate.key);
    if (
      !attempt
      || attempt.completionId !== candidate.completionId
      || attempt.token !== candidate.token
    ) {
      return;
    }
    attempt.inFlight = false;
    if (result === "glance-failed" || result === "summary-failed" || result === "update-failed") {
      if (attempt.attempts >= MAX_COMPLETION_ATTEMPTS) {
        recordTitleLifecycle(trace, "retry_exhausted");
        attempt.terminal = true;
        completionQueuedActionsRef.current.delete(candidate.key);
        return;
      }
      attempt.nextRetryAt = Date.now()
        + COMPLETION_RETRY_BASE_MS * (2 ** Math.max(0, attempt.attempts - 1));
      recordTitleLifecycle(trace, "retry_scheduled");
      const retryDelay = Math.max(0, attempt.nextRetryAt - Date.now());
      if (attempt.retryTimer) clearTimeout(attempt.retryTimer);
      attempt.retryTimer = setTimeout(() => {
        attempt.retryTimer = null;
        if (
          controllerActiveRef.current
          && completionAttemptsRef.current.get(candidate.key) === attempt
          && !attempt.terminal
        ) {
          setCompletionRetryEpoch((value) => value + 1);
        }
      }, retryDelay);
      return;
    }
    if (attempt.retryTimer) {
      clearTimeout(attempt.retryTimer);
      attempt.retryTimer = null;
    }
    attempt.terminal = true;
    if (result !== "updated") {
      completionQueuedActionsRef.current.delete(candidate.key);
    }
  }, []);

  const runCompletionBatch = useCallback(async (candidates: readonly CompletionCandidate[]) => {
    let response: SessionsResponse;
    try {
      response = await listSessions(enabledMachinesRef.current);
    } catch {
      for (const candidate of candidates) {
        finishCompletionAttempt(candidate, "glance-failed");
      }
      return;
    }
    if (liveRef.current) {
      applyLiveSessionList(response);
    }
    const liveSessions = new Map(response.sessions.map((session) => [sessionKey(session), session] as const));
    const prepared: PreparedCompletionCandidate[] = [];
    let nextIndex = 0;
    const runWorker = async () => {
      while (nextIndex < candidates.length) {
        const candidate = candidates[nextIndex++];
        if (!candidate) {
          return;
        }
        if (machineUnavailable(response, candidate.session.machine)) {
          finishCompletionAttempt(candidate, "glance-failed");
          continue;
        }
        const liveSession = liveSessions.get(candidate.key);
        const ownership = autoTitleStatesRef.current[candidate.key];
        if (
          !liveSession
          || !ownership
          || ownership.disabled
          || liveSession.title !== candidate.session.title
          || ownership.ownedTitle === undefined
          || ownership.ownedTitle !== liveSession.title
          || !isProvisionalAutoTitle(liveSession)
          || initialPromptSummariesRef.current.has(candidate.key)
          || !isTitleMutationCurrent(candidate.key, candidate.token)
        ) {
          finishCompletionAttempt(candidate, ownership?.disabled ? "disabled" : "stale-title");
          continue;
        }
        if (authoritativeCompletionId(liveSession) !== candidate.completionId) {
          finishCompletionAttempt(candidate, "stale-title");
          continue;
        }
        try {
          const result = await prepareCompletionSummary(
            candidate.key,
            liveSession,
            titleSummaryTrace(liveSession, "completion", candidate.attempt, candidate.attemptId),
          );
          if (result.result === "candidate") {
            prepared.push({
              candidate,
              title: result.title,
              expectedTitleRevision: liveSession.title_revision,
              ...(result.titleState ? { titleState: result.titleState } : {}),
            });
          } else {
            finishCompletionAttempt(candidate, result.result);
          }
        } catch {
          finishCompletionAttempt(candidate, "summary-failed");
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(COMPLETION_BATCH_CONCURRENCY, candidates.length) },
        () => runWorker(),
      ),
    );
    if (prepared.length === 0) {
      return;
    }

    let finalResponse: SessionsResponse;
    try {
      finalResponse = await listSessions(enabledMachinesRef.current);
    } catch {
      for (const { candidate } of prepared) {
        finishCompletionAttempt(candidate, "glance-failed");
      }
      return;
    }
    if (liveRef.current) {
      applyLiveSessionList(finalResponse);
    }
    const finalSessions = new Map(finalResponse.sessions.map((session) => [sessionKey(session), session] as const));
    for (const { candidate, title, titleState, expectedTitleRevision } of prepared) {
      if (machineUnavailable(finalResponse, candidate.session.machine)) {
        finishCompletionAttempt(candidate, "glance-failed");
        continue;
      }
      const finalSession = finalSessions.get(candidate.key);
      const ownership = autoTitleStatesRef.current[candidate.key];
      if (
        !finalSession
        || !ownership
        || ownership.disabled
        || finalSession.title !== candidate.session.title
        || ownership.ownedTitle === undefined
        || ownership.ownedTitle !== finalSession.title
        || finalSession.title_revision !== expectedTitleRevision
        || !isProvisionalAutoTitle(finalSession)
        || authoritativeCompletionId(finalSession) !== candidate.completionId
        || initialPromptSummariesRef.current.has(candidate.key)
        || !isTitleMutationCurrent(candidate.key, candidate.token)
      ) {
        finishCompletionAttempt(candidate, ownership?.disabled ? "disabled" : "stale-title");
        continue;
      }
      try {
        const result = await commitCompletionTitle(
          candidate.key,
          finalSession,
          title,
          titleState,
          expectedTitleRevision,
          candidate.token,
          titleSummaryTrace(finalSession, "completion", candidate.attempt, candidate.attemptId),
        );
        finishCompletionAttempt(candidate, result);
      } catch {
        finishCompletionAttempt(candidate, "update-failed");
      }
    }
  }, [
    applyLiveSessionList,
    commitCompletionTitle,
    enabledMachinesRef,
    finishCompletionAttempt,
    isTitleMutationCurrent,
    liveRef,
    prepareCompletionSummary,
  ]);

  useEffect(() => {
    const candidates: CompletionCandidate[] = [];
    for (const [key, session] of sessionsByKey) {
      if (session.retitle_path === "daemon_v2" || session.retitle_path === "daemon_v3") {
        cancelLegacyAutoTitleWork(session);
        continue;
      }
      const state = autoTitleStatesRef.current[key];
      const completionId = authoritativeCompletionId(session);
      const initialSummary = initialPromptSummariesRef.current.get(key);
      if (initialSummary) {
        if (!state || state.disabled) {
          discardInitialPromptSummary(key);
          continue;
        }
        if (
          completionId
          && session.title === initialSummary.expectedCurrentTitle
        ) {
          initialSummary.completionObserved = true;
          if (!initialSummary.inFlight) {
            void startInitialPromptSummary(key, initialSummary);
          }
        }
        continue;
      }
      if (
        !state
        || state.disabled
        || !isProvisionalAutoTitle(session)
        || !completionId
      ) {
        continue;
      }
      let attempt = completionAttemptsRef.current.get(key);
      if (!attempt || attempt.completionId !== completionId) {
        if (attempt?.retryTimer) clearTimeout(attempt.retryTimer);
        attempt = {
          completionId,
          attemptId: createTitleSummaryAttemptId(),
          attempts: 0,
          inFlight: false,
          terminal: false,
          nextRetryAt: 0,
          token: null,
          retryTimer: null,
        };
        completionAttemptsRef.current.set(key, attempt);
      }
      if (
        attempt.inFlight
        || attempt.terminal
        || attempt.attempts >= MAX_COMPLETION_ATTEMPTS
        || attempt.nextRetryAt > Date.now()
      ) {
        continue;
      }
      attempt.inFlight = true;
      attempt.attempts += 1;
      const token = beginTitleMutation(key, session.session_incarnation);
      attempt.token = token;
      candidates.push({
        key,
        session,
        completionId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempts,
        token,
      });
    }
    if (candidates.length > 0) {
      completionBatchTailRef.current = completionBatchTailRef.current
        .catch(() => undefined)
        .then(() => runCompletionBatch(candidates))
        .catch(() => {
          for (const candidate of candidates) {
            finishCompletionAttempt(candidate, "summary-failed");
          }
        });
    }
  }, [
    beginTitleMutation,
    cancelLegacyAutoTitleWork,
    discardInitialPromptSummary,
    finishCompletionAttempt,
    runCompletionBatch,
    sessionsByKey,
    startInitialPromptSummary,
    turnTitleScheduler,
    completionRetryEpoch,
  ]);

  const noteTurnOutput = useCallback(
    (session: Session) => {
      if (session.retitle_path === "daemon_v2" || session.retitle_path === "daemon_v3") return;
      turnTitleScheduler.bump(sessionKey(session));
    },
    [turnTitleScheduler],
  );

  const applyDaemonV2ManualRetitle = useCallback(async (
    session: Session,
    key: string,
    token: symbol,
    trace: TitleSummaryTrace,
  ): Promise<void> => {
    const readiness = await fetchSessionRetitleReadiness(session.machine).catch(() => ({
      ok: false as const,
      error: "Retitle readiness is unavailable.",
    }));
    if (!isTitleMutationCurrent(key, token)) return;
    if (!readiness.ok || !readiness.readiness) {
      setError(readiness.error ?? "Retitle readiness is unavailable.");
      recordTitleLifecycle(trace, "daemon_v2_readiness_unavailable");
      showRetitleFeedback({ key, state: "failed" });
      return;
    }
    if (readiness.readiness.status === "unavailable") {
      setError(sessionRetitleStatusMessage(readiness.readiness));
      recordTitleLifecycle(trace, `daemon_v2_${readiness.readiness.reason_code}`);
      showRetitleFeedback({ key, state: "failed" });
      return;
    }
    if (readiness.readiness.status === "degraded") {
      setError(sessionRetitleStatusMessage(readiness.readiness));
    }
    let candidate = session;
    let response;
    for (let attempt = 0; ; attempt += 1) {
      const request = createManualSessionRetitleRequest(candidate);
      if (!request) {
        setError("Retitle requires current session and title revision data. Refresh and try again.");
        recordTitleLifecycle(trace, "daemon_v2_missing_fence");
        showRetitleFeedback({ key, state: "failed" });
        return;
      }
      response = await requestSessionRetitle(candidate.machine, candidate.id, request).catch(() => ({
        ok: false as const,
        error: "Retitle request failed.",
        errorCode: undefined,
      }));
      if (
        response.ok
        || response.errorCode !== "title-revision-conflict"
        || attempt >= MAX_MANUAL_TITLE_CONFLICT_RETRIES
      ) {
        break;
      }
      const refreshed = await fetchLiveSession(key).catch(() => undefined);
      if (!isTitleMutationCurrent(key, token)) return;
      if (!refreshed || refreshed.session_incarnation !== session.session_incarnation) {
        break;
      }
      candidate = refreshed;
      recordTitleLifecycle(trace, "daemon_v2_title_revision_retry");
    }
    if (!isTitleMutationCurrent(key, token)) return;
    if (!response.ok || !response.retitle) {
      setError(sessionRetitleErrorMessage(response.errorCode, response.error));
      recordTitleLifecycle(trace, `daemon_v2_${response.errorCode ?? "failed"}`);
      showRetitleFeedback({ key, state: "failed" });
      void refreshRef.current();
      return;
    }
    const { retitle } = response;
    const current = sessionsByKeyRef.current.get(key);
    if (
      current
      && (
        current.session_incarnation !== retitle.session.session_incarnation
        || (current.title_revision ?? 0) > retitle.session.title_revision
      )
    ) {
      recordTitleLifecycle(trace, "daemon_v2_stale_response");
      void refreshRef.current();
      return;
    }
    titleRevisionsRef.current.set(key, retitle.session.title_revision);
    titleRevisionIncarnationsRef.current.set(key, retitle.session.session_incarnation);
    setSessions((previous) => previous.map((candidate) => (
      sessionKey(candidate) === key
      && candidate.session_incarnation === retitle.session.session_incarnation
      && (candidate.title_revision ?? 0) <= retitle.session.title_revision
        ? {
            ...candidate,
            title: retitle.session.title,
            title_state: retitle.session.title_state,
            title_revision: retitle.session.title_revision,
          }
        : candidate
    )));
    updateAutoTitleStates((previous) => ({
      ...previous,
      [key]: deriveAutoTitleStateFromSession(
        previous[key],
        retitle.session.title,
        retitle.session.title_state,
      ),
    }));
    recordTitleLifecycle(trace, `daemon_v2_${retitle.outcome}`);
    showRetitleFeedback({ key, state: retitle.changed ? "updated" : "unchanged" });
  }, [fetchLiveSession, isTitleMutationCurrent, setError, setSessions, showRetitleFeedback, updateAutoTitleStates]);

  const attemptDaemonV3ManualRetitle = useCallback(async (
    session: Session,
    key: string,
    token: symbol,
    trace: TitleSummaryTrace,
  ): Promise<DaemonV3ManualAttempt> => {
    const settled: DaemonV3ManualAttempt = { kind: "settled" };
    const failTerminally = (
      outcome: "terminal_failure" | "degraded_cached",
      failureClass: string | undefined,
    ) => {
      const message = sessionRetitleV3FailureMessage(outcome, failureClass);
      setError(message);
      recordTitleLifecycle(trace, sessionRetitleV3LifecycleOutcome(outcome, failureClass));
      showRetitleFeedback({ key, state: outcome, detail: message });
      void refreshRef.current();
    };
    const readinessResult = await fetchSessionRetitleV3Readiness(session.machine, session.id).catch(() => ({
      ok: false as const,
      error: "Retitle memory readiness is unavailable.",
    }));
    if (!isTitleMutationCurrent(key, token)) return settled;
    const readiness = "readiness" in readinessResult ? readinessResult.readiness : undefined;
    if (!readinessResult.ok || !readiness) {
      const message = readinessResult.error ?? "Retitle memory readiness is unavailable.";
      setError(message);
      recordTitleLifecycle(trace, "daemon_v3_readiness_unavailable");
      showRetitleFeedback({ key, state: "terminal_failure", detail: message });
      return settled;
    }
    if (readiness.status === "unavailable" && !readiness.usable_memory) {
      const message = sessionRetitleV3StatusMessage(readiness);
      setError(message);
      recordTitleLifecycle(trace, `daemon_v3_${readiness.reason_code}`);
      showRetitleFeedback({ key, state: "terminal_failure", detail: message });
      return settled;
    }
    const request = createManualSessionRetitleV3Request(session, readiness);
    if (!request) {
      const message = "Retitle requires current session, title, and memory revisions. Refresh and try again.";
      setError(message);
      recordTitleLifecycle(trace, "daemon_v3_missing_fence");
      showRetitleFeedback({ key, state: "terminal_failure", detail: message });
      return settled;
    }
    let response = await requestSessionRetitleV3(session.machine, session.id, request).catch(() => ({
      ok: false as const,
      error: "Retitle request failed.",
      errorCode: undefined,
    }));
    if (!isTitleMutationCurrent(key, token)) return settled;
    if (!response.ok || !response.retitle) {
      const errorCode = response.errorCode;
      const finish = () => {
        const message = sessionRetitleErrorMessage(errorCode, response.error);
        setError(message);
        recordTitleLifecycle(trace, `daemon_v3_${errorCode ?? "failed"}`);
        showRetitleFeedback({ key, state: "terminal_failure", detail: message });
        void refreshRef.current();
      };
      if (errorCode === SESSION_RETITLE_V3_HISTORY_CONFLICT) return { kind: "history_conflict", finish };
      finish();
      return settled;
    }
    let result = response.retitle;
    for (let attempt = 0; result.status === "accepted" && attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!isTitleMutationCurrent(key, token)) return settled;
      response = await fetchSessionRetitleV3Operation(
        session.machine,
        session.id,
        result.operation_hash,
      ).catch(() => ({ ok: false as const, error: "Retitle operation status is unavailable." }));
      if (!response.ok || !response.retitle) {
        const message = response.error ?? "Retitle operation status is unavailable.";
        setError(message);
        recordTitleLifecycle(trace, `daemon_v3_${response.errorCode ?? "poll_failed"}`);
        showRetitleFeedback({ key, state: "terminal_failure", detail: message });
        void refreshRef.current();
        return settled;
      }
      result = response.retitle;
    }
    if (result.status !== "terminal") {
      const message = "Retitle is still updating. Refresh the session to reconcile it.";
      setError(message);
      recordTitleLifecycle(trace, "daemon_v3_poll_timeout");
      showRetitleFeedback({ key, state: "terminal_failure", detail: message });
      void refreshRef.current();
      return settled;
    }
    if (!result.result_is_current || result.session_incarnation !== session.session_incarnation) {
      const message = "Retitle completed against stale session state. The current session was refreshed.";
      recordTitleLifecycle(trace, "daemon_v3_stale_response");
      setError(message);
      showRetitleFeedback({ key, state: "terminal_failure", detail: message });
      void refreshRef.current();
      return settled;
    }
    titleRevisionsRef.current.set(key, result.title_revision);
    if (result.session_incarnation) {
      titleRevisionIncarnationsRef.current.set(key, result.session_incarnation);
    }
    if (result.title !== undefined) {
      setSessions((previous) => previous.map((candidate) => (
        sessionKey(candidate) === key
        && candidate.session_incarnation === result.session_incarnation
        && (candidate.title_revision ?? 0) <= result.title_revision
          ? { ...candidate, title: result.title, title_revision: result.title_revision }
          : candidate
      )));
    }
    const feedback = result.outcome ?? "terminal_failure";
    if (feedback === "terminal_failure" || feedback === "degraded_cached") {
      const failureClass = result.failure_class;
      // Only a lost commit race is worth another provider call: a preserved
      // cached title already left the session usable.
      if (feedback === "terminal_failure" && failureClass === SESSION_RETITLE_V3_HISTORY_CONFLICT) {
        return { kind: "history_conflict", finish: () => failTerminally(feedback, failureClass) };
      }
      failTerminally(feedback, failureClass);
      return settled;
    }
    recordTitleLifecycle(trace, `daemon_v3_${feedback}`);
    showRetitleFeedback({ key, state: feedback });
    void refreshRef.current();
    return settled;
  }, [isTitleMutationCurrent, setError, setSessions, showRetitleFeedback]);

  const applyDaemonV3ManualRetitle = useCallback(async (
    session: Session,
    key: string,
    token: symbol,
    trace: TitleSummaryTrace,
  ): Promise<void> => {
    let candidate = session;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await attemptDaemonV3ManualRetitle(candidate, key, token, trace);
      if (outcome.kind !== "history_conflict") return;
      if (attempt >= MAX_MANUAL_V3_HISTORY_CONFLICT_RETRIES) {
        outcome.finish();
        return;
      }
      const refreshed = await fetchLiveSession(key).catch(() => undefined);
      if (!isTitleMutationCurrent(key, token)) return;
      if (!refreshed || refreshed.session_incarnation !== candidate.session_incarnation) {
        outcome.finish();
        return;
      }
      recordTitleLifecycle(trace, "daemon_v3_history_conflict_retry");
      candidate = refreshed;
    }
  }, [attemptDaemonV3ManualRetitle, fetchLiveSession, isTitleMutationCurrent]);

  const retitleSession = useCallback(
    async (session: Session) => {
      const key = sessionKey(session);
      discardInitialPromptSummary(key);
      turnTitleScheduler.take(key);
      completionQueuedActionsRef.current.delete(key);
      const token = beginTitleMutation(key, session.session_incarnation);
      const trace = titleSummaryTrace(session, "manual", 1);
      setRetitleFeedback({ key, state: session.retitle_path === "daemon_v3" ? "updating" : "working" });
      if (session.retitle_path === "daemon_v3") {
        await applyDaemonV3ManualRetitle(session, key, token, trace);
        return;
      }
      if (session.retitle_path === "daemon_v2") {
        await applyDaemonV2ManualRetitle(session, key, token, trace);
        return;
      }
      const result = await applyManualRetitleSummary({
        session: { machine: session.machine, id: session.id },
        baseTitle: baseTitleForSession(key, session.title),
        titleState: structuredTitleStateForSession(session),
        expectedCurrentTitle: session.title ?? null,
        glance,
        ...makeAutoTitleDeps(key, {
          token,
          expectedTitleRevision: titleRevisionsRef.current.get(key),
          expectedSessionIncarnation: session.session_incarnation,
          expectedSessionTitle: session.title ?? null,
          trace,
        }),
        onTitlePending: (title) => {
          if (!isTitleMutationCurrent(key, token)) {
            return;
          }
          committedTitleTransitionsRef.current.set(key, {
            previousTitle: session.title ?? null,
            committedTitle: title,
            rebasePendingTitle: false,
            committed: false,
          });
        },
        onTitleCommitted: (title, titleState) => {
          if (!isTitleMutationCurrent(key, token)) {
            return;
          }
          committedTitleTransitionsRef.current.set(key, {
            previousTitle: session.title ?? null,
            committedTitle: title,
            rebasePendingTitle: false,
            committed: true,
          });
          updateAutoTitleStates((prev) => {
            const current = prev[key];
            return !current || current.disabled
              ? prev
              : {
                  ...prev,
                  [key]: {
                    ...current,
                    baseTitle: titleState?.topic
                      ?? (current.baseTitleConfirmed ? current.baseTitle : title),
                    baseTitleConfirmed: titleState
                      ? titleState.topic_source !== "none"
                      : true,
                    ownedTitle: title,
                  },
                };
          });
        },
      });
      recordTitleLifecycle(trace, result.replaceAll("-", "_"));
      const state = result === "updated" ? "updated" : result === "unchanged" ? "unchanged" : "failed";
      showRetitleFeedback({ key, state });
    },
    [
      baseTitleForSession,
      applyDaemonV2ManualRetitle,
      applyDaemonV3ManualRetitle,
      beginTitleMutation,
      discardInitialPromptSummary,
      isTitleMutationCurrent,
      makeAutoTitleDeps,
      setRetitleFeedback,
      showRetitleFeedback,
      turnTitleScheduler,
      updateAutoTitleStates,
    ],
  );

  const retitleFocusedSession = useCallback(async () => {
    const key = focusedKey ?? activeTerminalSlotKey();
    if (!key) {
      return;
    }
    const session = sessionsByKey.get(key);
    if (!session) {
      return;
    }
    await retitleSession(session);
  }, [activeTerminalSlotKey, focusedKey, retitleSession, sessionsByKey]);

  return {
    updateAutoTitleStates,
    rememberSessionTitle,
    updateManualSessionTitle,
    applyCreatePromptSummary,
    noteTurnPromptSubmitted,
    noteTurnOutput,
    retitleSession,
    retitleFocusedSession,
  };
}
