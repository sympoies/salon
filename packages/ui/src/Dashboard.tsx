import { useSharedOutboxSync } from "./sharedOutboxClient.ts";
import { IconButton } from "./IconButton.tsx";
import { loadWorkspacePreferences, saveWorkspacePreferences } from "./workspacePreferences.ts";
import { useUiExtensions, type SessionBadgeNavigation } from "./extensions.tsx";
import { createPortal } from "react-dom";
import { CLEAR_SESSION_FILTERS, filterRecords, hasActiveSessionFilters, sessionRoleOptions, sessionWorkspaceOptions, type SessionFilters } from "./sessionFilters.ts";
import { useSessionOrdering } from "./extensions.tsx";
import { useResourceEvents } from "./useResourceEvents.ts";
import { RESOURCE_RECONCILE_MS } from "./resourceEvents.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  archiveSession,
  createSession,
  type CreatedSessionSnapshot,
  cancelSessionAutoResume,
  killSession,
  inspectSessionMaintenance,
  executeSessionMaintenanceAction,
  listSessions,
  refreshSessionInfo,
  resetSessionPollRequests,
  resumeSession,
  setSessionAutoResume,
  switchSessionAccount,
  submitSessionPrompt,
} from "./api.ts";
import { recordDebugEvent } from "./debugLog.ts";
import { loadPerformanceCapture } from "./performanceSummary.ts";
import { orderForCreatedSession } from "./layoutOrder.ts";
import { updateHeaderCompaction } from "./headerResponsive.ts";
import { LayoutPicker } from "./LayoutPicker.tsx";
import { isAndroidTauri, isMacTauri } from "./runtime.ts";
import { isCoarsePointer, isPhoneHeader, isPhoneTier, setAndroidTileGrid, watchPhoneTier } from "./phoneTier.ts";
import { pruneAutoTitleStates } from "./autoTitle.ts";
import {
  createdSessionAutoTitleState,
  prepareCreateSessionAutoTitle,
  resolveCreatedSession,
  resolveCreateTitleSession,
} from "./autoTitleFlow.ts";
import {
  resolveToggleFocusTarget,
  resolveSessionShortcutTarget,
} from "./dashboardShortcuts.ts";
import {
  applySessionListResult,
  reconcileAgentProfilesByMachine,
  unavailableSessionList,
  retainKnownInactiveMachines,
} from "./dashboardSessions.ts";
import {
  defaultAutoResumeForCreate,
  initializeCreatedSession,
  recoverableCreatedPrompt,
  submittedCreatedPrompt,
  type CreatedSessionInitializationResult,
} from "./createdSessionInitialization.ts";
import {
  CreateLifecycleDeadlineError,
  promptRecoveryCapacityError,
  acknowledgeUnknownCreateRecovery,
  reconcileUnknownCreateRecoveries,
  unknownCreateBlocksNewSession,
  requestWithCreateLifecycleDeadline,
  createRequestTimeoutMs,
  validateInitialPrompt,
} from "./createLifecycle.ts";
import { sessionLabel, sessionRepoLabel, sortByDefaultSessionOrder } from "./format.ts";
import {
  assignSlot,
  autoLayoutMode,
  compactSlotsAfterRemoval,
  DEFAULT_LAYOUT_MODE,
  mobileSlotCount,
  parseLayoutMode,
  reconcileSlots,
  sessionKey,
  slotsEqual,
  swapSlots,
  type LayoutMode,
  type SlotKey,
} from "./layout.ts";
import type { CreateBody, DashboardSession, Session, SessionsResponse } from "./types.ts";
import { ACCOUNT_PROVIDER_LABELS, type AgentLaunchProfileSummary } from "@agent-console/shared/api";
import type { MaintenanceAction, MaintenanceOperation } from "@agent-console/shared/maintenance";
import { AsyncButton } from "./AsyncButton.tsx";
import { BrandMark, BrandTitle } from "./BrandTitle.tsx";
import { CreateDialog } from "./CreateDialog.tsx";
import { Modal } from "./Modal.tsx";
import { DashboardUsageProvider, HeaderUsage } from "./HeaderUsage.tsx";
import { mergeRefreshedSession } from "./sessionRefresh.ts";
import { SessionRefreshContext, type SessionRefreshControl } from "./useSessionRefresh.ts";
import { accountRecoveryPolicy, sessionAccountChoices, sessionAccountProvider } from "./sessionAccounts.ts";
import { accountMachineKeys, useAccountInventories } from "./useAccountInventories.ts";
import { SessionSlot } from "./SessionSlot.tsx";
import type { CardPreview } from "./cardPreview.ts";
import type { AndroidLayout } from "./androidLayout.ts";
import type { SessionListDisplay } from "./sessionListDisplay.ts";
import { SessionListNavigator } from "./SessionListNavigator.tsx";
import { countSessionStatuses, sessionStatusEvidence } from "./sessionStatusGroups.ts";
import { SessionStatusCountButtons, sessionStatusCountValues } from "./SessionStatusCountButtons.tsx";
import { updateHeaderCountAvailability, sameHeaderCountAvailability, type HeaderCountAvailability, type HeaderCountObservation } from "./headerCountAvailability.ts";
import {
  adjacentPromptTargetKey,
  filteredGridSessionKeys,
  resolveOverviewPromptTargetFocus,
  resolveSessionNavigatorSelection,
} from "./sessionNavigator.ts";
import {
  deriveSessionListHarnessOptions,
  orderSessionListSessions,
  paginateSessionList,
  reorderProjectedSessionKeys,
  resolveOverviewDesktopMode,
  resolveFocusedPageStep,
  resolveOverviewPromptTargetForPage,
  resolveOverviewSessionListPageSize,
  stepSessionListPage,
} from "./sessionListNavigation.ts";
import { MobileSessionList } from "./MobileSessionList.tsx";
import { SessionMaintenanceDrawer } from "./SessionMaintenanceDrawer.tsx";
import { StatusNotice } from "./StatusNotice.tsx";
import { useStatusNotice } from "./useStatusNotice.ts";
import {
  buildMaintenanceActionRequest,
  createSessionMaintenanceIncident,
  maintenanceOutcomeToast,
  reconcileSessionMaintenanceIncidents,
  sessionMaintenanceDiagnostics,
  sessionMaintenanceNextPrompt,
  shouldRemoveDeletedMaintenanceSessionLocally,
  type SessionMaintenanceIncident,
} from "./sessionMaintenance.ts";
import type { MachineColorMap } from "./machineColors.ts";
import type { TerminalConnectionStatus } from "./TerminalPane.tsx";
import type { TerminalRenderMode } from "./terminalRenderMode.ts";
import { resolveDashboardTerminalDisplay } from "./dashboardTerminalDisplay.ts";
import { localStorageGetItem, localStorageSetItem } from "./storage.ts";
import { copySessionCommandToClipboard } from "./resumeClipboard.ts";
import { copySessionCardActionToClipboard, type SessionCardCopyAction } from "./sessionCardCopy.ts";
import { terminalClipboardActionErrorMessage, writeTerminalClipboardText } from "./terminalClipboard.ts";
import { createStartupFailureDebugBundle } from "./debugBundle.ts";
import { startupFailureDiagnostic } from "./startupFailure.ts";
import {
  attentionRepairToast,
  completedRepairToast,
  repairMessageAfterAutoDismiss,
  repairMessageAutoDismissDelay,
  type RepairToastMessage,
} from "./repairBanner.ts";
import {
  applySessionRepairResult,
  executeSessionRepairPlan,
  incrementReconnectTokens,
  planSessionRepairs,
  sessionRepairSummary,
  type SessionRepairPlan,
} from "./sessionRepair.ts";
import { useAsyncAction } from "./useAsyncAction.ts";
import { useAsyncPoll, type AsyncPollTick } from "./useAsyncPoll.ts";
import { useAutoTitleController } from "./useAutoTitleController.ts";
import { useDashboardKeyboard } from "./useDashboardKeyboard.ts";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import { useExpiringValue } from "./useExpiringValue.ts";
import { useLayoutSync } from "./useLayoutSync.ts";
import { useSlotDrag } from "./useSlotDrag.ts";
import { CloseIcon, MachineIcon, PlusIcon, SelectChevronIcon, StarIcon, TrashIcon } from "./icons.tsx";
import { HeaderMenu } from "./HeaderMenu.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { LiveConversationPanel } from "./LiveConversationPanel.tsx";
import { useConversationOutboxDelivery } from "./conversationOutbox.ts";
import type { ConversationReplyDrafts } from "./ConversationComposer.tsx";
import { projectFocusedGridSlots } from "./focusedGridProjection.ts";
import { useShortcutClose } from "./useShortcutClose.ts";
import { ShortcutHelpModal } from "./ShortcutHelpModal.tsx";
import { SpeechComposer } from "./SpeechComposer.tsx";
import { AppSelect } from "./AppSelect.tsx";
import {
  browserNotificationPermission,
  createAlertChime,
  createAttentionAlertTracker,
  deliverAttentionAlerts,
  showBrowserNotification,
  type AttentionAlertTracker,
} from "./attentionAlerts.ts";
import {
  applyActivityStreamEvent,
  activityDeliveryAfterConnection,
  activityDeliveryAfterFeedEvent,
  createActivityReconcileGeneration,
  createActivityDeliveryState,
  createActivityStreamCursorState,
  runActivityStream,
} from "./activityStream.ts";

const POLL_MS = 4000;
// Covers the edge's 15 s probe-breaker cooldown plus a few polls.
const ALL = "__all__";
// Sentinel option value for "create a new session" in a slot's session picker.
const NEW_SESSION = "__new__";
const MODE_STORAGE = "agent-console.layout.mode";
const AUTO_STORAGE = "agent-console.layout.auto";
const SLOTS_STORAGE = "agent-console.layout.slots";
const SESSION_LIST_NAVIGATION_HINT = "Selected session · Cmd-F to open";

interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
  /** The raw width tier: the workspace header follows it while the Android tile grid is shown (#238). */
  readonly headerMobile: boolean;
  /** Primary pointer is coarse, whatever the width: decides how a session opens, not the layout. */
  readonly touchPrimary: boolean;
}

interface RetitleFeedback {
  readonly key: string;
  readonly state: "working" | "updated" | "failed" | "updating" | "committed" | "unchanged" | "degraded_cached" | "terminal_failure";
  // The actionable reason behind a failed state, shown on hover.
  readonly detail?: string;
}

interface CreatedPromptRecovery {
  readonly key: number;
  readonly prompt: string;
  readonly machine: string;
  readonly sessionId?: string;
  readonly submissionOutcome: "not-submitted" | "unknown";
  readonly creationOutcomeUnknown?: boolean;
  readonly listRequestFloor?: number;
  readonly reconciled?: boolean;
  readonly acknowledged?: boolean;
}

interface ShortcutFeedback {
  readonly key: string;
  readonly text: string;
}

interface RefreshGeneration {
  readonly signal: AbortSignal;
  readonly machines: readonly string[];
}

type MaintenancePendingOperation =
  | {
      readonly kind: "inspect";
      readonly incidentKey: string;
      readonly token: symbol;
    }
  | {
      readonly kind: "action";
      readonly incidentKey: string;
      readonly actionId: string;
      readonly previewDigest: string;
      readonly token: symbol;
    };

function readLayoutMode(): LayoutMode {
  const stored = localStorageGetItem(MODE_STORAGE);
  return stored === null ? DEFAULT_LAYOUT_MODE : parseLayoutMode(stored);
}

// Auto layout is opt-in and off by default, so existing users keep their fixed
// grid until they choose "Auto".
function readAutoLayout(): boolean {
  return localStorageGetItem(AUTO_STORAGE) === "1";
}

function readSlots(): SlotKey[] {
  try {
    const parsed = JSON.parse(localStorageGetItem(SLOTS_STORAGE) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((value) => (typeof value === "string" ? value : null));
  } catch {
    return [];
  }
}

function currentViewport(): Viewport {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768, mobile: false, headerMobile: false, touchPrimary: false };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  // The Android app is always a touch client, even when a stylus reports a fine pointer.
  const touchPrimary = isCoarsePointer() || isAndroidTauri();
  return { width, height, mobile: isPhoneTier(), headerMobile: isPhoneHeader(), touchPrimary };
}

function isTerminalShortcutTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest(".terminal-pane"));
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (isTerminalShortcutTarget(target)) {
    return false;
  }
  const editableContainer = element ? element.closest('[contenteditable=true], [role="dialog"]') : null;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    Boolean(editableContainer)
  );
}

function activeTerminalSlotKey(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const element = document.activeElement instanceof Element ? document.activeElement : null;
  return element?.closest<HTMLElement>(".terminal-slot")?.dataset.slotKey ?? null;
}

function CloseSessionDialog({
  session,
  error,
  onCancel,
  onConfirmDelete,
  onConfirmArchive,
  archiveAvailable,
  starAvailable,
  onReviewRecovery,
}: {
  readonly session: Session;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirmDelete: () => void | Promise<void>;
  readonly onConfirmArchive: (starred: boolean) => void | Promise<void>;
  readonly archiveAvailable: boolean;
  readonly starAvailable: boolean;
  readonly onReviewRecovery: () => void;
}) {
  // The kill is a real network round-trip, so keep the dialog up and show the
  // shared pending state on Delete (and lock Cancel/backdrop) until it settles,
  // rather than dismissing the dialog the instant it is clicked.
  // Immediate timings (no anti-flicker delay): `deleting` also locks Cancel and the
  // backdrop, which must engage the instant Delete is pressed, and the dialog
  // dismisses on completion so its spinner can't flicker in place.
  // Keep the selected close action stable until this dialog is reopened.
  const [canArchive] = useState(() => archiveAvailable
    && Boolean(session.provider_resume?.session_id)
    && Boolean(session.session_incarnation));
  const archiveUnavailable = canArchive && !archiveAvailable;
  const [deleteInstead, setDeleteInstead] = useState(false);
  const [starOnArchive, setStarOnArchive] = useState(false);
  const { pending: deleting, run: runDelete } = useAsyncAction(
    onConfirmDelete,
    { showDelayMs: 0, minVisibleMs: 0 },
  );
  const { pending: archiving, run: runArchive } = useAsyncAction(
    () => onConfirmArchive(starOnArchive && !deleteInstead),
    { showDelayMs: 0, minVisibleMs: 0 },
  );
  const busy = deleting || archiving;
  const runSelectedCloseAction = deleteInstead ? runDelete : runArchive;
  const selectedActionPending = deleteInstead ? deleting : archiving;
  return (
    <Modal
      onClose={onCancel}
      busy={busy}
      className="close-session-modal"
      backdropClassName="close-session-backdrop"
      ariaLabelledby="close-session-title"
    >
        <div className="close-session-head">
          <h2 id="close-session-title">
            <span>Close Session</span>
          </h2>
          <IconButton
            className="btn icon-btn close-session-x"
            type="button"
            aria-label="Cancel close session"
            onClick={onCancel}
            disabled={busy}
          >
            <CloseIcon />
          </IconButton>
        </div>
        <div className="close-session-summary">
          <strong>{sessionLabel(session)}</strong>
          <span>{session.id}</span>
          <span>
            {session.agent} / {sessionRepoLabel(session)}
          </span>
          <span>{session.machine}</span>
        </div>
        {canArchive ? (
          <>
            <p className="close-session-copy">
              Archive stops the session and keeps its Console metadata in History. The provider
              conversation remains available.
            </p>
            {/*
              The star refines the default action, so it reads directly under the
              copy describing that action. The option that replaces the action
              with a delete comes last, next to the button it retitles.
            */}
            {starAvailable ? (
              <label
                className={`close-session-star-option${starOnArchive ? " is-selected" : ""}${
                  busy ? " is-busy" : ""
                }`}
              >
                <span className="close-session-option-head">
                  <input
                    type="checkbox"
                    checked={starOnArchive}
                    disabled={busy || archiveUnavailable || deleteInstead}
                    aria-describedby="close-session-star-description"
                    onChange={(event) => setStarOnArchive(event.currentTarget.checked)}
                  />
                  <strong><StarIcon filled />Star it in History</strong>
                </span>
                <small id="close-session-star-description">
                  Starred sessions lead the History list. You can unstar one there at any time.
                </small>
              </label>
            ) : null}
            <label className={`close-session-delete-option${deleteInstead ? " is-selected" : ""}${busy ? " is-busy" : ""}`}>
              <span className="close-session-option-head">
                <input
                  type="checkbox"
                  checked={deleteInstead}
                  disabled={busy || archiveUnavailable}
                  aria-describedby="close-session-delete-description"
                  onChange={(event) => setDeleteInstead(event.currentTarget.checked)}
                />
                <strong>Remove the Console record instead</strong>
              </span>
              <small id="close-session-delete-description">
                Console metadata will be removed. The provider conversation will not be deleted.
              </small>
            </label>
            {archiveUnavailable ? (
              <div className="close-session-warning" role="status">
                Archive became unavailable. Wait for the machine to recover, or close and reopen
                this dialog to refresh the available actions.
              </div>
            ) : null}
          </>
        ) : (
          <p className="close-session-copy">
            Delete stops the session and removes its Console record. The provider conversation will
            not be deleted.
          </p>
        )}
        {error ? (
          <div className="close-session-error" role="alert">
            <p>{error}</p>
            <button className="btn ghost" type="button" onClick={onReviewRecovery} disabled={busy}>
              Review recovery
            </button>
          </div>
        ) : null}
        <div className="modal-actions close-session-actions">
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {canArchive ? (
            <AsyncButton
              className={deleteInstead ? "btn danger" : "btn primary"}
              type="button"
              pending={selectedActionPending}
              disabled={busy || archiveUnavailable}
              onClick={() => void runSelectedCloseAction()}
            >
              {deleteInstead ? <TrashIcon /> : null}
              <span>{deleteInstead ? "Delete session" : "Archive session"}</span>
            </AsyncButton>
          ) : null}
          {!canArchive ? (
            <AsyncButton
              className="btn danger"
              type="button"
              pending={deleting}
              disabled={archiving}
              onClick={() => void runDelete()}
            >
              {deleting ? null : <TrashIcon />}
              <span>Delete session</span>
            </AsyncButton>
          ) : null}
        </div>
    </Modal>
  );
}

function useViewport(androidTileGrid: boolean): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => currentViewport());

  useEffect(() => {
    setAndroidTileGrid(androidTileGrid);
    setViewport(currentViewport());
  }, [androidTileGrid]);

  useEffect(() => {
    const stopPhoneTier = watchPhoneTier();
    const update = () => {
      setViewport(currentViewport());
    };
    const pointer = window.matchMedia?.("(pointer: coarse)");
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    pointer?.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      pointer?.removeEventListener("change", update);
      stopPhoneTier();
    };
  }, []);

  return viewport;
}

export interface DashboardProps {
  readonly active: boolean;
  readonly machines: readonly string[];
  // Principal-permitted machines, owned by App; the host filter stays local to
  // the dashboard and narrows polling without changing available actions.
  readonly enabledMachines: readonly string[];
  readonly hostMigrationNotice?: boolean;
  readonly onDismissHostMigration?: () => void;
  readonly defaultCreateMachine?: string;
  readonly machineColors: MachineColorMap;
  readonly defaultAutoResume: boolean;
  // Device-local opt-in: chime (and notify when hidden) on new attention events.
  readonly attentionAlerts?: boolean;
  readonly terminalRenderMode: TerminalRenderMode;
  readonly terminalSelectedPaneRealtime: boolean;
  readonly phoneSessionOpen?: SessionListDisplay;
  /** Phones show the single-session count row unless this device hid it (#938). */
  readonly phoneFocusCounts?: boolean;
  readonly sessionListDisplay?: SessionListDisplay;
  /** The Android app's per-device Session layout from Settings (#238); the phone list by default. */
  readonly androidLayout?: AndroidLayout;
  readonly cardPreview?: CardPreview;
  readonly operatorCapabilities?: {
    readonly debug: boolean;
    readonly usage: boolean;
  };
  readonly onDebug: () => void;
  readonly onUsage: (anchor?: HTMLElement) => void;
  readonly onSettings: () => void;
  readonly onShell?: () => void;
}

const DEFAULT_OPERATOR_CAPABILITIES = {
  debug: true,
  usage: true,
} as const;

export function Dashboard({
  active,
  machines,
  enabledMachines: permittedMachines,
  hostMigrationNotice = false,
  onDismissHostMigration,
  defaultCreateMachine,
  machineColors,
  defaultAutoResume,
  attentionAlerts = false,
  terminalRenderMode,
  terminalSelectedPaneRealtime,
  phoneSessionOpen = "conversation",
  phoneFocusCounts = true,
  sessionListDisplay = "terminal",
  androidLayout = "mobile",
  cardPreview = "latest-message",
  operatorCapabilities = DEFAULT_OPERATOR_CAPABILITIES,
  onDebug,
  onUsage,
  onSettings,
  onShell,
}: DashboardProps) {
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const pendingUsableListCaptureRef = useRef<string | null>(null);
  const recordedUsableListCaptureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const captureStart = pendingUsableListCaptureRef.current;
    if (!captureStart || recordedUsableListCaptureRef.current === captureStart) return;
    if (loadPerformanceCapture()?.started_at !== captureStart) return;
    recordedUsableListCaptureRef.current = captureStart;
    pendingUsableListCaptureRef.current = null;
    recordDebugEvent({ source: "client", method: "GET", route: "/performance/session-list",
      phase: "usable", ok: true });
  }, [active, sessions]);
  const [reachableMachineNames, setReachableMachineNames] = useState<ReadonlySet<string>>(() => new Set(machines));
  const [historyMachineNames, setHistoryMachineNames] = useState<ReadonlySet<string>>(() => new Set());
  const [archiveMachineNames, setArchiveMachineNames] = useState<ReadonlySet<string>>(() => new Set());
  const [historyStarMachineNames, setHistoryStarMachineNames] = useState<ReadonlySet<string>>(() => new Set());
  const [machineFilter, setMachineFilter] = useState<string>(ALL);
  const machineFilterRef = useRef(machineFilter);
  machineFilterRef.current = machineFilter;
  const { workspaceLabels, sessionRole: createSessionRole, onSessionList } = useUiExtensions();
  const workspaceLabelsRef = useRef(workspaceLabels);
  workspaceLabelsRef.current = workspaceLabels;
  const workspacePreferencesLoadedRef = useRef(false);
  const [sessionFilters, setSessionFilters] = useState<SessionFilters>(() => ({ ...CLEAR_SESSION_FILTERS, ...loadWorkspacePreferences() }));
  const [sessionExtensions, setSessionExtensions] = useState<Readonly<Record<string, unknown>>>();
  const sessionFiltersRef = useRef(sessionFilters);
  sessionFiltersRef.current = sessionFilters;
  const [headerCounts, setHeaderCounts] = useState<HeaderCountAvailability>({
    observations: new Map(), includedMachines: new Set(), offlineMachines: [], available: false,
  });
  const countsAvailable = headerCounts.available;
  // Machines answered at least once since counts were last invalidated, mapped
  // to when each stopped answering (null while it answers). A failed machine's
  // sessions are retained as unavailable, so counts stay last-known through a
  // probe breaker cooldown, but only for HELD_COUNTS_MAX_UNAVAILABLE_MS.
  const countedMachinesRef = useRef(new Map<string, HeaderCountObservation>());
  const invalidateCounts = useCallback(() => {
    countedMachinesRef.current = new Map();
    setHeaderCounts({ observations: new Map(), includedMachines: new Set(), offlineMachines: [], available: false });
  }, []);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notice: statusNotice, dismiss: dismissStatusNotice } = useStatusNotice(error, undefined, { loaded: sessionsLoaded, machines });
  const [showCreate, setShowCreate] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversationKey, setConversationKey] = useState<string | null>(null);
  // The docked panel follows the user's selection until pinned. Pinning is not
  // persisted: each opening starts unpinned.
  const [conversationPinned, setConversationPinned] = useState(false);
  const [conversationFollowKey, setConversationFollowKey] = useState<string | null>(null);
  const userSelectedKeyRef = useRef<string | null>(null);
  const noteUserSelection = useCallback((key: string) => {
    userSelectedKeyRef.current = key;
    setConversationFollowKey(key);
  }, []);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  const [unsubmittedCreatePrompts, setUnsubmittedCreatePrompts] = useState<readonly CreatedPromptRecovery[]>([]);
  const unknownCreateOutcomePending = unknownCreateBlocksNewSession(unsubmittedCreatePrompts);
  // Orders session-list reads so an unknown create is reconciled only by a read
  // issued after the incident was retained.
  const listRequestSequenceRef = useRef(0);
  const nextCreatePromptRecoveryKeyRef = useRef(0);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => readLayoutMode());
  const [autoLayout, setAutoLayout] = useState<boolean>(() => readAutoLayout());
  const [slots, setSlots] = useState<SlotKey[]>(() => readSlots());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const androidDesktop = isAndroidTauri() && androidLayout === "desktop";
  // Choosing Desktop in Settings may have just set the grid's stored count or Auto.
  useEffect(() => {
    if (!androidDesktop) return;
    setLayoutMode(readLayoutMode());
    setAutoLayout(readAutoLayout());
  }, [androidDesktop]);
  // The list screen uses the desktop grid; an opened session is the phone view.
  useEffect(() => {
    const onList = androidDesktop && focusedKey === null && conversationKey === null;
    setAndroidTileGridState(onList);
    // Lets the phone-width header keep its layout trigger on the Android Desktop list.
    if (onList) document.documentElement.dataset.androidDesktop = "true";
    else delete document.documentElement.dataset.androidDesktop;
    return () => { delete document.documentElement.dataset.androidDesktop; };
  }, [androidDesktop, focusedKey, conversationKey]);
  const pollingMachinesKey = permittedMachines.join("\0");
  const pollingMachines = useMemo(() => pollingMachinesKey ? pollingMachinesKey.split("\0") : [], [pollingMachinesKey]);
  // Keep all permitted hosts available for creation and host-specific pages;
  // filters narrow rendering; all hosts stay fresh for facet counts.
  const enabledMachines = permittedMachines;
  const permittedMachinesRef = useRef(permittedMachines);
  permittedMachinesRef.current = permittedMachines;
  const machineMetadataRef = useRef(new Map<string, SessionsResponse["machines"][number]>());
  const attentionAlertTrackerRef = useRef<AttentionAlertTracker | null>(null);
  const alertChimeRef = useRef<(() => void) | null>(null);
  const attentionAlertsRef = useRef(attentionAlerts);
  attentionAlertsRef.current = attentionAlerts;
  const focusedKeyForAlertsRef = useRef(focusedKey);
  focusedKeyForAlertsRef.current = focusedKey;
  useEffect(() => {
    // Created while enabling, so its autoplay unlock listens for the next gesture.
    if (attentionAlerts) alertChimeRef.current ??= createAlertChime();
  }, [attentionAlerts]);
  useEffect(() => {
    // Observe every snapshot, even while disabled, so enabling never replays a backlog.
    const tracker = (attentionAlertTrackerRef.current ??= createAttentionAlertTracker());
    const alerts = tracker.observe(sessions);
    if (!attentionAlertsRef.current || alerts.length === 0) return;
    deliverAttentionAlerts(alerts, {
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      focusedSessionKey: focusedKeyForAlertsRef.current,
      notificationPermission: browserNotificationPermission(),
      playSound: () => (alertChimeRef.current ??= createAlertChime())(),
      notify: showBrowserNotification,
    });
  }, [sessions]);
  // A freshly created session that stays in the grid but takes the keyboard, so the
  // prompt can continue without entering the full-session view (only set when the
  // layout has a free slot; overflow uses focusedKey instead).
  const [gridFocusKey, setGridFocusKey] = useState<string | null>(null);
  const [promptTargetKey, setPromptTargetKey] = useState<string | null>(null);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    readonly key: string;
    readonly token: number;
  } | null>(null);
  const [voiceOpenRequest, setVoiceOpenRequest] = useState<{
    readonly key: string;
    readonly machine: string;
    readonly id: string;
    readonly sessionIncarnation: string;
    readonly title: string;
    readonly token: number;
  } | null>(null);
  const nextVoiceOpenRequestTokenRef = useRef(0);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [editingTitleKey, setEditingTitleKey] = useState<string | null>(null);
  const [openSlotMenuKey, setOpenSlotMenuKey] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [mobileOverviewNavOpen, setMobileOverviewNavOpen] = useState(false);
  const [sessionListPage, setSessionListPage] = useState(1);
  const [resumingKey, setResumingKey] = useState<string | null>(null);
  const [extensionCapabilities, setExtensionCapabilities] = useState<Readonly<Record<string, unknown>>>({});
  const [autoResumePendingKey, setAutoResumePendingKey] = useState<string | null>(null);
  const [accountPendingKey, setAccountPendingKey] = useState<string | null>(null);
  const [accountMachines, setAccountMachines] = useState<ReturnType<typeof accountMachineKeys>>({
    codex: "",
    claude: "",
  });
  const accountsByProvider = useAccountInventories(accountMachines);
  const [agentProfilesByMachine, setAgentProfilesByMachine] = useState<
    Readonly<Record<string, readonly AgentLaunchProfileSummary[]>>
  >({});
  const { value: copiedCommandKey, show: showCopiedCommandKey, clear: clearCopiedCommandKey } = useExpiringValue<string>(1600);
  const {
    value: copiedStartupDiagnosticsKey,
    show: showCopiedStartupDiagnosticsKey,
  } = useExpiringValue<string>(2000);
  const {
    value: retitleFeedback,
    set: setRetitleFeedback,
    show: showRetitleFeedback,
  } = useExpiringValue<RetitleFeedback>(2600);
  const { value: shortcutFeedback, show: showShortcutFeedback } = useExpiringValue<ShortcutFeedback>(2200);
  const [repairingSessions, setRepairingSessions] = useState(false);
  const repairOpenerRef = useRef<HTMLElement | null>(null);
  const [pendingRepair, setPendingRepair] = useState<{
    readonly plan: SessionRepairPlan;
    readonly machines: string;
    readonly repository: string;
  } | null>(null);
  const [repairMessage, setRepairMessage] = useState<RepairToastMessage | null>(null);
  const [reconnectTokens, setReconnectTokens] = useState<Record<string, number>>({});
  const [terminalStatusByKey, setTerminalStatusByKey] = useState<ReadonlyMap<string, TerminalConnectionStatus>>(
    () => new Map(),
  );
  const [activityDeliveryByMachine, setActivityDeliveryByMachine] = useState(
    () => createActivityDeliveryState(pollingMachines),
  );
  const { policy: orderingPolicy, fixed: fixedSessionOrder, revision: orderingRevision } = useSessionOrdering();
  // Slot index awaiting a session created from its picker, so the new session
  // lands in that slot rather than wherever the reconcile pass puts it.
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const [closeConfirmSession, setCloseConfirmSession] = useState<Session | null>(null);
  const [closeDeleteError, setCloseDeleteError] = useState<string | null>(null);
  const [maintenanceIncidents, setMaintenanceIncidents] = useState<readonly SessionMaintenanceIncident[]>([]);
  const [maintenanceOpenKey, setMaintenanceOpenKey] = useState<string | null>(null);
  const [maintenancePending, setMaintenancePending] = useState<MaintenancePendingOperation | null>(null);
  const maintenancePendingRef = useRef<MaintenancePendingOperation | null>(null);
  const maintenanceInspectionAbortRef = useRef<AbortController | null>(null);
  const pendingCreatedFocusKeyRef = useRef<string | null>(null);
  // Later-page empty cells are projections, not assignable fixed-grid slots.
  // Remember their page only for post-create grid focus.
  const pendingCreatePageRef = useRef<number | null>(null);
  const pendingCreatedGridPageRef = useRef<number | null>(null);
  const retitlePathByMachineRef = useRef<Map<string, NonNullable<Session["retitle_path"]>>>(new Map());
  const pendingCreatedFocusFulfilledRef = useRef(false);
  const nextTerminalFocusRequestTokenRef = useRef(0);
  const overviewRestorePromptTargetKeyRef = useRef<string | null>(null);
  const mobileSessionListScrollTopRef = useRef(0);

  const rememberMobileSessionListScrollTop = useCallback((scrollTop: number) => {
    mobileSessionListScrollTopRef.current = scrollTop;
  }, []);

  const cancelPendingCreatedFocus = useCallback(() => {
    pendingCreatedFocusKeyRef.current = null;
    pendingCreatedFocusFulfilledRef.current = false;
    pendingCreatedGridPageRef.current = null;
    setGridFocusKey(null);
  }, []);

  const requestPromptTargetFocus = useCallback((key: string) => {
    noteUserSelection(key);
    nextTerminalFocusRequestTokenRef.current += 1;
    setTerminalFocusRequest({ key, token: nextTerminalFocusRequestTokenRef.current });
  }, [noteUserSelection]);

  const leaveFocusedSession = useCallback(() => {
    cancelPendingCreatedFocus();
    setFocusedKey(null);
    const restoreKey = overviewRestorePromptTargetKeyRef.current;
    overviewRestorePromptTargetKeyRef.current = null;
    if (restoreKey) {
      requestPromptTargetFocus(restoreKey);
    }
  }, [cancelPendingCreatedFocus, requestPromptTargetFocus]);

  const phoneConversationLockedRef = useRef(false);
  useAndroidBackEntry("focused-session", active && focusedKey !== null, () => {
    // A phone Conversation reply in flight keeps its session on screen.
    if (phoneConversationLockedRef.current) return false;
    leaveFocusedSession();
  });
  useAndroidBackEntry("header-menu", active && headerMenuOpen, () => setHeaderMenuOpen(false));
  useAndroidBackEntry("mobile-overview-nav", active && mobileOverviewNavOpen, () =>
    setMobileOverviewNavOpen(false),
  );
  const closeMaintenanceDrawer = useCallback(() => {
    if (maintenancePendingRef.current?.kind === "action") return false;
    maintenanceInspectionAbortRef.current?.abort();
    setMaintenanceOpenKey(null);
  }, []);

  const liveRef = useRef(true);
  const createInFlightRef = useRef(false);
  const refreshRef = useRef<((tick?: AsyncPollTick, generation?: RefreshGeneration,
    mode?: "fresh" | "poll" | "recovery") => Promise<void>) | null>(null);
  // The most recent focused session, so ⌘F can toggle back into it from the list.
  const lastFocusedKeyRef = useRef<string | null>(null);
  const enabledMachinesRef = useRef<readonly string[]>(pollingMachines);
  const enabledMachinesGenerationRef = useRef(0);
  const immediateRefreshRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const sessionsRef = useRef(sessions);
  const slotsRef = useRef(slots);
  const reachableMachineNamesRef = useRef(reachableMachineNames);
  const knownMachineNamesRef = useRef<ReadonlySet<string>>(new Set(machines));
  const activityStreamCursorsRef = useRef(createActivityStreamCursorState());
  const agentProfileObservationsRef = useRef<ReadonlyMap<string, string>>(new Map());
  // A reply in flight keeps its mounted surface: the phone tier only changes
  // once it is accepted.
  const [conversationBusy, setConversationBusy] = useState(false);
  // The Android app lists sessions as the chosen layout's conversation tiles
  // while a layout is chosen and no session is open; otherwise it keeps the
  // phone layout (#219).
  const [androidTileGrid, setAndroidTileGridState] = useState(false);
  const measuredViewport = useViewport(androidTileGrid);
  const [appliedMobile, setAppliedMobile] = useState(measuredViewport.mobile);
  useEffect(() => {
    if (!conversationBusy) setAppliedMobile(measuredViewport.mobile);
  }, [conversationBusy, measuredViewport.mobile]);
  const viewport = useMemo(() => ({ ...measuredViewport, mobile: appliedMobile }), [measuredViewport, appliedMobile]);
  const closeOpenSlotMenus = useCallback(() => {
    setOpenSlotMenuKey(null);
  }, []);

  const beginCloseSessionConfirm = useCallback((session: Session) => {
    closeOpenSlotMenus();
    setCloseDeleteError(null);
    setCloseConfirmSession(session);
  }, [closeOpenSlotMenus]);

  const rememberSessionInteraction = useCallback((key: string) => {
    noteUserSelection(key);
    const pendingCreatedKey = pendingCreatedFocusKeyRef.current;
    if (pendingCreatedKey && pendingCreatedKey !== key) {
      cancelPendingCreatedFocus();
    }
  }, [cancelPendingCreatedFocus, noteUserSelection]);

  const setFocusedKeyFromUser = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
    cancelPendingCreatedFocus();
    if (typeof next !== "function" && next !== null) {
      rememberSessionInteraction(next);
    }
    setFocusedKey(next);
  }, [cancelPendingCreatedFocus, rememberSessionInteraction]);

  const enterSession = useCallback((key: string, machine?: string) => {
    if (machine) {
      setMachineFilter((current) => current === ALL || current === machine ? current : machine);
    }
    setFocusedKeyFromUser(key);
  }, [setFocusedKeyFromUser]);

  const applyLiveSessionList = useCallback(
    (res: SessionsResponse) => {
      // A rejected request says nothing new about host activation. Retain
      // explicit inactivity until a successful authoritative status replaces it.
      if (!res.ok) res = { ...res, machines: retainKnownInactiveMachines(res.machines, machineMetadataRef.current) };
      const counted = countedMachinesRef.current;
      const nowMs = Date.now();
      const nextCounts = updateHeaderCountAvailability(counted, res.machines, res.ok, nowMs);
      countedMachinesRef.current = new Map(nextCounts.observations);
      setHeaderCounts(current => sameHeaderCountAvailability(current, nextCounts) ? current : nextCounts);
      if (res.ok) setSessionsLoaded(true);
      const permitted = new Set(permittedMachinesRef.current);
      const retained = new Map([...machineMetadataRef.current].filter(([name]) => permitted.has(name)));
      for (const machine of res.machines) if (permitted.has(machine.name)) retained.set(machine.name, machine);
      machineMetadataRef.current = retained;
      const machines = [...retained.values()];
      retitlePathByMachineRef.current = new Map(machines.map((machine) => [
        machine.name,
        res.capabilities?.session_retitle_v3 === true && machine.capabilities?.session_retitle_v3 === true
          ? "daemon_v3"
          : res.capabilities?.session_retitle_v2 === true && machine.capabilities?.session_retitle_v2 === true
            ? "daemon_v2"
            : "legacy_edge",
      ]));
      // A host whose poll failed keeps its last known history capability; a
      // retired host (active: false) loses it. Dropping it on every failure
      // would swap the phone Conversation for the terminal until the next poll,
      // remounting the pane and the file picker's input with it (#942).
      setHistoryMachineNames((current) => new Set(machines
        .filter((machine) => machine.ok ? machine.capabilities?.history === true
          : machine.active !== false && current.has(machine.name))
        .map((machine) => machine.name)));
      setArchiveMachineNames(new Set(machines
        .filter((machine) => machine.ok && machine.capabilities?.archive === true)
        .map((machine) => machine.name)));
      setHistoryStarMachineNames(new Set(machines
        .filter((machine) => machine.ok && machine.capabilities?.history_star === true)
        .map((machine) => machine.name)));
      if (res.ok) {
        if (!workspacePreferencesLoadedRef.current && permitted.size > 0
          && [...permitted].every(name => res.machines.some(machine => machine.name === name && machine.ok))) {
          const choices = sessionWorkspaceOptions(res.sessions, [...(sessionFiltersRef.current.workspaces ?? []), ...(sessionFiltersRef.current.excludedWorkspaces ?? [])], workspaceLabelsRef.current.keys());
          const preference = loadWorkspacePreferences(choices, true);
          workspacePreferencesLoadedRef.current = true;
          setSessionFilters(current => ({ ...current, ...preference }));
        }
        setSessionExtensions(res.ext);
        setExtensionCapabilities(res.capabilities ?? {});
        onSessionList?.(res.ext);
      }
      setAccountMachines((current) => {
        const next = accountMachineKeys(machines);
        return current.codex === next.codex && current.claude === next.claude ? current : next;
      });
      setAgentProfilesByMachine((current) => {
        const reconciled = reconcileAgentProfilesByMachine(
          current,
          agentProfileObservationsRef.current,
          machines,
        );
        agentProfileObservationsRef.current = reconciled.observations;
        return reconciled.profiles;
      });
      return applySessionListResult(res, {
        sessionsRef,
        reachableMachineNamesRef,
        knownMachineNamesRef,
        setSessions,
        setReachableMachineNames,
        setError,
      });
    },
    [],
  );

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      maintenanceInspectionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    setMaintenanceIncidents((current) => reconcileSessionMaintenanceIncidents(current, sessions));
  }, [sessions]);

  useEffect(() => {
    if (maintenanceOpenKey && !maintenanceIncidents.some((incident) => incident.key === maintenanceOpenKey)) {
      setMaintenanceOpenKey(null);
    }
    if (maintenanceIncidents.length === 0) {
      setRepairMessage((current) => current?.actions.includes("view_failures") ? null : current);
    }
  }, [maintenanceIncidents, maintenanceOpenKey]);

  useEffect(() => {
    reachableMachineNamesRef.current = reachableMachineNames;
  }, [reachableMachineNames]);

  useEffect(() => {
    if (focusedKey !== null) {
      lastFocusedKeyRef.current = focusedKey;
      setMobileOverviewNavOpen(false);
    }
  }, [focusedKey]);

  useEffect(() => {
    knownMachineNamesRef.current = new Set(machines);
  }, [machines]);

  useEffect(() => {
    localStorageSetItem(MODE_STORAGE, String(layoutMode));
  }, [layoutMode]);

  useEffect(() => {
    localStorageSetItem(AUTO_STORAGE, autoLayout ? "1" : "0");
  }, [autoLayout]);

  useEffect(() => {
    localStorageSetItem(SLOTS_STORAGE, JSON.stringify(slots));
  }, [slots]);

  useEffect(() => {
    const delay = repairMessageAutoDismissDelay(repairMessage);
    if (delay === null || repairMessage === null) {
      return;
    }
    const scheduledMessage = repairMessage;
    const timer = setTimeout(() => {
      setRepairMessage((current) => repairMessageAfterAutoDismiss(current, scheduledMessage));
    }, delay);
    return () => clearTimeout(timer);
  }, [repairMessage]);

  const visible = useMemo(() => {
    const filtered = focusedKey === null || machineFilter === ALL ? sessions : sessions.filter((s) => s.machine === machineFilter);
    return sortByDefaultSessionOrder(filtered, machines);
  }, [machines, sessions, machineFilter, focusedKey]);

  // Desktop grid size: fixed to the picked mode, or auto-sized to the session
  // count when "Auto" is on (so it grows/shrinks on add/delete). Mobile is always
  // auto (mobileSlotCount). autoLayoutMode is also what the Auto button previews.
  const autoDesktopMode = autoLayoutMode(visible.length);
  const slotCount = viewport.mobile
    ? mobileSlotCount(viewport.width, viewport.height, visible.length)
    : autoLayout
      ? autoDesktopMode
      : layoutMode;

  // The Android app's tiles are conversation tiles, whatever the list preference.
  const tileListDisplay: SessionListDisplay = androidTileGrid ? "conversation" : sessionListDisplay;

  const sessionsByKey = useMemo(() => {
    return new Map(visible.map((s) => [sessionKey(s), s] as const));
  }, [visible]);

  const liveSessionKeys = useMemo(() => new Set(sessions.map(sessionKey)), [sessions]);
  const conversationReplyDrafts = useRef<ConversationReplyDrafts>(new Map());
  useConversationOutboxDelivery(sessions, reachableMachineNames, conversationReplyDrafts.current);
  useSharedOutboxSync(sessions);
  useEffect(() => {
    for (const key of conversationReplyDrafts.current.keys()) {
      if (!liveSessionKeys.has(key)) conversationReplyDrafts.current.delete(key);
    }
  }, [liveSessionKeys]);

  // Looked up in the full list so a view filter never closes an open panel;
  // the panel follows the live record for turn-completion refreshes.
  const conversationSession = conversationKey
    ? sessions.find((candidate) => sessionKey(candidate) === conversationKey)
    : undefined;
  const closeConversation = useCallback(() => {
    if (conversationBusy) return false;
    setConversationKey(null);
  }, [conversationBusy]);
  // An unpinned panel moves to the latest user selection that has a
  // conversation view, waiting out a reply in flight; any other selection
  // leaves it on its session. Only the docked panel follows.
  useEffect(() => {
    if (conversationFollowKey === null) return;
    if (conversationPinned || conversationKey === null || viewport.width < 1100) {
      setConversationFollowKey(null);
      return;
    }
    if (conversationBusy) return;
    setConversationFollowKey(null);
    const target = sessions.find((candidate) => sessionKey(candidate) === conversationFollowKey);
    if (target && conversationFollowKey !== conversationKey && historyMachineNames.has(target.machine)) {
      setConversationKey(conversationFollowKey);
    }
  }, [conversationBusy, conversationFollowKey, conversationKey, conversationPinned, historyMachineNames, sessions, viewport.width]);
  const toggleConversationPin = useCallback(() => {
    setConversationPinned((pinned) => !pinned);
    // Pinning drops any selection still waiting; unpinning applies the current one.
    setConversationFollowKey(conversationPinned ? userSelectedKeyRef.current : null);
  }, [conversationPinned]);
  // A session that leaves the list takes its panel with it, so a later session
  // under the same key never reopens a panel the user did not ask for.
  useEffect(() => {
    if (conversationKey !== null && conversationSession === undefined) setConversationKey(null);
  }, [conversationKey, conversationSession]);
  // A phone shows Conversation as a mode of the focused session screen, so it
  // keeps the session header, and swiping or choosing another session keeps the
  // mode (#892). Leaving the session resets it; the list
  // then opens by the "Open session as" preference.
  const [phoneConversationMode, setPhoneConversationMode] = useState(false);
  useEffect(() => {
    if (focusedKey === null) setPhoneConversationMode(false);
  }, [focusedKey]);
  const openConversation = useCallback((session: Session) => {
    // A reply in flight keeps its session and composer on screen.
    if (conversationBusy) return;
    if (viewport.mobile) {
      setPhoneConversationMode(true);
      enterSession(sessionKey(session), session.machine);
      return;
    }
    setConversationKey(sessionKey(session));
    setConversationPinned(false);
    setConversationFollowKey(null);
  }, [conversationBusy, enterSession, viewport.mobile]);
  // Crossing the phone tier keeps an open conversation: the wide panel becomes
  // the focused session's Conversation mode, and back. The tier itself is held
  // while a reply is in flight (see `viewport`), so the transfer waits for it.
  const wasMobileRef = useRef(viewport.mobile);
  useEffect(() => {
    if (wasMobileRef.current === viewport.mobile) return;
    wasMobileRef.current = viewport.mobile;
    if (viewport.mobile) {
      if (conversationSession === undefined) return;
      setConversationKey(null);
      setPhoneConversationMode(true);
      enterSession(sessionKey(conversationSession), conversationSession.machine);
    } else if (phoneConversationMode && focusedKey !== null) {
      setPhoneConversationMode(false);
      setConversationKey(focusedKey);
      setConversationPinned(false);
      setConversationFollowKey(null);
    }
  }, [conversationSession, enterSession, focusedKey, phoneConversationMode, viewport.mobile]);
  const [phoneConversationNotice, setPhoneConversationNotice] = useState<string>();
  // A wide grid has no session list: a touch-primary device selects a session
  // with its card, and that opens the conversation like the phone list does.
  const setSlotFocusedKey = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
    const key = typeof next === "function" ? next(focusedKey) : next;
    const session = key !== null && key !== focusedKey ? sessionsByKey.get(key) : undefined;
    if (session && !viewport.mobile && viewport.touchPrimary && phoneSessionOpen === "conversation" && historyMachineNames.has(session.machine)) {
      openConversation(session);
      return;
    }
    setFocusedKeyFromUser(next);
  }, [focusedKey, historyMachineNames, openConversation, phoneSessionOpen, sessionsByKey, setFocusedKeyFromUser, viewport.mobile, viewport.touchPrimary]);
  // Hook notices have higher severity than the phone history fallback (info).
  const visibleStatusNotice = statusNotice ?? (viewport.mobile && phoneConversationNotice
    ? { kind: "info" as const, message: phoneConversationNotice } : null);
  const connectionNotice = visibleStatusNotice !== null;
  const statusNoticeElement = visibleStatusNotice ? <StatusNotice notice={visibleStatusNotice}
    onDismiss={statusNotice ? dismissStatusNotice : () => setPhoneConversationNotice(undefined)} surface="dashboard" inline /> : null;
  const openPhoneTerminal = useCallback((session: Session, unavailable = false) => {
    if (conversationBusy) return;
    setConversationKey(null);
    setPhoneConversationMode(false);
    setPhoneConversationNotice(unavailable ? "Conversation history is unavailable for this session. Opened terminal." : undefined);
    enterSession(sessionKey(session), session.machine);
  }, [conversationBusy, enterSession]);
  // Sending or dictating a phone reply keeps its session on screen, as the
  // Conversation modal did while busy.
  const phoneConversationLocked = viewport.mobile && phoneConversationMode && conversationBusy;
  phoneConversationLockedRef.current = phoneConversationLocked;
  useAndroidBackEntry("session-conversation-dock", active && conversationSession !== undefined && viewport.width >= 1100, closeConversation);

  const rememberTerminalStatus = useCallback((key: string, status: TerminalConnectionStatus) => {
    setTerminalStatusByKey((prev) => {
      if (prev.get(key) === status) {
        return prev;
      }
      const next = new Map(prev);
      next.set(key, status);
      return next;
    });
  }, []);

  useEffect(() => {
    setSlots((prev) => {
      const next = reconcileSlots(prev, visible, slotCount);
      return slotsEqual(prev, next) ? prev : next;
    });
  }, [slotCount, visible]);

  const {
    orderedSessionKeys: layoutSessionKeys,
    applyLayoutLocalOrder,
    persistLayoutLocalOrder,
    cancelPendingLayoutDebounce,
  } = useLayoutSync({
    sessions,
    visible,
    slotCount,
    reachableMachineNames,
    // A configured spoke this device has disabled is never asked for its
    // sessions, so it must stay known: its ranked keys are unproven, not gone.
    getKnownMachineNames: () => new Set([...machines, ...knownMachineNamesRef.current]),
    setSlots,
  });
  const layoutSessionKeysRef = useRef<readonly string[]>(layoutSessionKeys);

  useEffect(() => {
    layoutSessionKeysRef.current = layoutSessionKeys;
  }, [layoutSessionKeys]);

  const roleOf = useMemo(() => createSessionRole?.(sessions.map(session => ({ ...session,
    session_id: session.id, created_at: session.created_at ?? "", provider: session.agent })), sessionExtensions), [sessions, sessionExtensions, createSessionRole]);
  const overviewHarnesses = useMemo(() => deriveSessionListHarnessOptions(sessions), [sessions]);
  const overviewRoles = useMemo(() => sessionRoleOptions(sessions.map(session => ({ ...session,
    session_id: session.id, created_at: session.created_at ?? "", provider: session.agent })), roleOf), [sessions, roleOf]);
  const orderedOverviewSessions = useMemo(() => {
    const ordered = orderSessionListSessions({
      sessions: visible,
      preferredSessionKeys: layoutSessionKeys,
    });
    // A distribution may prioritize sessions over the stored layout ranking.
    return orderingPolicy ? orderingPolicy.order(ordered) : ordered;
  }, [layoutSessionKeys, visible, orderingPolicy, orderingRevision]);
  const overviewFilterRecords = useMemo(() => orderedOverviewSessions.map(session => ({ ...session, session_id: session.id,
    created_at: session.created_at ?? "", provider: session.agent })), [orderedOverviewSessions]);
  const filterOverview = useCallback((filters: SessionFilters) => {
    const matched = new Set(filterRecords(overviewFilterRecords, filters, roleOf).map(sessionKey));
    return orderedOverviewSessions.filter(session => matched.has(sessionKey(session)));
  }, [orderedOverviewSessions, overviewFilterRecords, roleOf]);
  const overviewFilteredSessions = useMemo(() => filterOverview(sessionFilters), [filterOverview, sessionFilters]);
  const overviewStatusScopeSessions = useMemo(() => filterOverview({ ...sessionFilters, statusGroup: null }), [filterOverview, sessionFilters]);
  const overviewStatusCounts = useMemo(() => countSessionStatuses(overviewStatusScopeSessions, sessionStatusEvidence),
    [overviewStatusScopeSessions]);
  const overviewCountRecords = useMemo(() => overviewFilterRecords.filter(session => headerCounts.includedMachines.has(session.machine)), [overviewFilterRecords, headerCounts]);
  // The title bar's single-session copy counts the grid's sessions: every counted
  // host, whatever the focused view's host select shows (#938 review F1).
  const statusCountRecords = useMemo(() => sessions.filter(session => headerCounts.includedMachines.has(session.machine))
    .map(session => ({ ...session, session_id: session.id, created_at: session.created_at ?? "", provider: session.agent })), [sessions, headerCounts]);
  const shortcutSessionKeys = useMemo(
    () => overviewFilteredSessions.map(sessionKey),
    [overviewFilteredSessions],
  );

  // The focusable sessions in the ⌘H-⌘L order, resolved to records so the focused
  // header's ordinal can drop down into a direct picker (same order the pager steps).
  // Active filters define the domain; off-page sessions remain reachable.
  const sessionNavList = useMemo(
    () =>
      shortcutSessionKeys
        .map((key) => sessionsByKey.get(key))
        .filter((session): session is DashboardSession => session !== undefined),
    [sessionsByKey, shortcutSessionKeys],
  );
  // Auto follows the filtered list; preserve stored slots for fixed layouts.
  const focusedGridSlots = useMemo(() => projectFocusedGridSlots({
    automatic: autoLayout && !viewport.mobile,
    orderedSessionKeys: overviewFilteredSessions.map(sessionKey),
    localSlots: slots,
    slotCount,
  }), [autoLayout, viewport.mobile, overviewFilteredSessions, slots, slotCount]);
  const sessionNavGridKeys = useMemo(
    () => filteredGridSessionKeys({
      filteredSessionKeys: overviewFilteredSessions.map(sessionKey),
      slotSessionKeys: focusedGridSlots,
    }),
    [overviewFilteredSessions, focusedGridSlots],
  );
  const sessionListPageSize = resolveOverviewSessionListPageSize({
    mobile: viewport.mobile,
    autoLayout,
    fixedSlotCount: layoutMode,
    resultCount: overviewFilteredSessions.length,
  });
  const overviewPage = useMemo(
    () => paginateSessionList({
      sessions: overviewFilteredSessions,
      requestedPage: sessionListPage,
      pageSize: sessionListPageSize,
    }),
    [overviewFilteredSessions, sessionListPage, sessionListPageSize],
  );
  // Both drags — the overview list and the focused grid — are the same intent:
  // move a session in the one shared ranking. They go through the same explicit
  // path so this device's grid shape never authors the cross-device order on its
  // own; the grid is then reseeded from the ranking the user just chose.
  const reorderVisibleSlots = useCallback((fromIndex: number, toIndex: number) => {
    const pageSessionKeys = focusedKey !== null ? slots : overviewPage.sessionKeys;
    const nextOrder = reorderProjectedSessionKeys({
      orderedSessionKeys: layoutSessionKeys,
      pageSessionKeys,
      fromIndex,
      toIndex,
    });
    if (nextOrder.length === layoutSessionKeys.length
      && nextOrder.every((key, index) => key === layoutSessionKeys[index])) {
      // The ranking did not move, so one end of the drag was an empty pane in the
      // focused grid. That is a local arrangement, not a reorder — keep it local.
      if (focusedKey !== null) {
        setSlots((current) => swapSlots(current, fromIndex, toIndex));
      }
      return;
    }
    void applyLayoutLocalOrder(nextOrder, "reorder");
  }, [applyLayoutLocalOrder, focusedKey, layoutSessionKeys, overviewPage.sessionKeys, slots]);
  const slotDrag = useSlotDrag({
    active,
    mobile: viewport.mobile,
    setSlots,
    onReorder: reorderVisibleSlots,
  });
  const overviewDesktopMode = resolveOverviewDesktopMode({
    autoLayout,
    fixedSlotCount: layoutMode,
    pageSessionCount: overviewPage.sessionKeys.length,
  });
  const displayedDesktopMode = focusedKey === null ? overviewDesktopMode : autoDesktopMode;
  const overviewPageSessions = useMemo(() => {
    const byKey = new Map(overviewFilteredSessions.map((session) => [sessionKey(session), session] as const));
    return overviewPage.sessionKeys
      .map((key) => byKey.get(key))
      .filter((session): session is DashboardSession => session !== undefined);
  }, [overviewFilteredSessions, overviewPage.sessionKeys]);
  const promptTargetSessionKeys = focusedKey === null
    ? overviewPage.sessionKeys
    : sessionNavGridKeys;
  const notePromptTargetFocus = useCallback((key: string) => {
    rememberSessionInteraction(key);
    setPromptTargetKey((currentPromptTargetKey) => resolveOverviewPromptTargetFocus({
      currentPromptTargetKey,
      focusedSessionKey: focusedKey,
      focusedTerminalKey: key,
      gridSessionKeys: promptTargetSessionKeys,
    }));
  }, [focusedKey, promptTargetSessionKeys, rememberSessionInteraction]);

  useEffect(() => {
    setSessionListPage(1);
  }, [sessionListPageSize]);

  useEffect(() => {
    if (overviewPage.pageCount === 0) {
      setSessionListPage(1);
      return;
    }
    setSessionListPage((current) => Math.min(current, overviewPage.pageCount));
  }, [overviewPage.pageCount]);

  useEffect(() => {
    if (focusedKey !== null) {
      return;
    }
    setPromptTargetKey((current) => resolveOverviewPromptTargetForPage({
      promptTargetKey: current,
      pageSessionKeys: overviewPage.sessionKeys,
    }));
  }, [focusedKey, overviewPage.sessionKeys]);

  const changeSessionFilters = useCallback((filters: SessionFilters) => {
    cancelPendingCreatedFocus();
    // Unrelated facet edits must leave complete-discovery normalization pending.
    const previous = sessionFiltersRef.current;
    if ((["workspaces", "excludedWorkspaces"] as const).some(key => {
      const before = previous[key] ?? [], after = filters[key] ?? [];
      return before.length !== after.length || before.some(workspace => !after.includes(workspace));
    })) workspacePreferencesLoadedRef.current = true;
    saveWorkspacePreferences(filters);
    setSessionFilters(filters);
    setSessionListPage(1);
  }, [cancelPendingCreatedFocus]);

  const resetSessionListFilters = useCallback(() => changeSessionFilters(CLEAR_SESSION_FILTERS), [changeSessionFilters]);
  const goToPreviousSessionListPage = useCallback(() => {
    cancelPendingCreatedFocus();
    setSessionListPage((current) => stepSessionListPage({
      page: current,
      pageCount: overviewPage.pageCount,
      direction: -1,
    }));
  }, [cancelPendingCreatedFocus, overviewPage.pageCount]);

  const goToNextSessionListPage = useCallback(() => {
    cancelPendingCreatedFocus();
    setSessionListPage((current) => stepSessionListPage({
      page: current,
      pageCount: overviewPage.pageCount,
      direction: 1,
    }));
  }, [cancelPendingCreatedFocus, overviewPage.pageCount]);

  useEffect(() => {
    if (focusedKey && !sessionsByKey.has(focusedKey)) {
      setFocusedKey(null);
    }
  }, [focusedKey, sessionsByKey]);

  useEffect(() => {
    if (promptTargetKey && !sessionsByKey.has(promptTargetKey)) {
      setPromptTargetKey(null);
    }
  }, [promptTargetKey, sessionsByKey]);

  // Route focus for a freshly created session: keep it in the grid list (focusing
  // only its pane so the prompt can continue) when the layout still has a free slot,
  // and fall back to the full-session view only when there is no room (overflow,
  // manual-layout overflow, or mobile). Resets the fulfilled flag while the session
  // is absent to preserve the stale-reconciliation refocus of the previous effect.
  useEffect(() => {
    const pendingKey = pendingCreatedFocusKeyRef.current;
    if (!pendingKey) {
      pendingCreatedFocusFulfilledRef.current = false;
      return;
    }
    const pendingSession = sessions.find((session) => sessionKey(session) === pendingKey);
    if (!pendingSession) {
      pendingCreatedFocusFulfilledRef.current = false;
      return;
    }
    if (pendingCreatedFocusFulfilledRef.current) {
      return;
    }
    if (!visible.some((session) => sessionKey(session) === pendingKey)) {
      setMachineFilter(pendingSession.machine);
      return;
    }
    const projected = reconcileSlots(slotsRef.current, visible, slotCount);
    const overviewIncludesCreatedSession = overviewFilteredSessions.some(
      (session) => sessionKey(session) === pendingKey,
    );
    const hasSlotCapacity = (projected.includes(pendingKey)
      || (pendingCreatedGridPageRef.current !== null
        && pendingCreatedGridPageRef.current === overviewPage.page))
      && overviewIncludesCreatedSession
      && overviewPage.sessionKeys.includes(pendingKey);
    pendingCreatedFocusFulfilledRef.current = true;
    rememberSessionInteraction(pendingKey);
    if (hasSlotCapacity && !viewport.mobile) {
      setGridFocusKey(pendingKey);
      setFocusedKey(null);
    } else {
      setFocusedKey(pendingKey);
    }
  }, [
    sessions,
    visible,
    slotCount,
    viewport.mobile,
    overviewFilteredSessions,
    overviewPage.sessionKeys,
    rememberSessionInteraction,
  ]);

  useEffect(() => {
    const liveKeys = new Set(visible.map(sessionKey));
    setTerminalStatusByKey((prev) => {
      if ([...prev.keys()].every((key) => liveKeys.has(key))) {
        return prev;
      }
      const next = new Map<string, TerminalConnectionStatus>();
      for (const [key, status] of prev) {
        if (liveKeys.has(key)) {
          next.set(key, status);
        }
      }
      return next;
    });
  }, [visible]);

  useEffect(() => {
    closeOpenSlotMenus();
  }, [focusedKey, closeOpenSlotMenus]);

  // Overview actions follow the visible selection, even after DOM focus moves
  // to a dashboard control. Restrict fallbacks to the page the user can see.
  const sessionShortcutTarget = useCallback(() => {
    // The narrow card list has no selected-pane marker or inline title editor.
    if (focusedKey === null && viewport.mobile) return null;
    return resolveSessionShortcutTarget({
      focusedKey,
      promptTargetKey,
      activeTerminalKey: activeTerminalSlotKey(),
      availableKeys: focusedKey === null ? overviewPage.sessionKeys : sessionsByKey.keys(),
    });
  }, [focusedKey, overviewPage.sessionKeys, promptTargetKey, sessionsByKey, viewport.mobile]);

  const {
    updateAutoTitleStates,
    updateManualSessionTitle,
    applyCreatePromptSummary,
    noteTurnPromptSubmitted,
    noteTurnOutput,
    retitleSession,
    retitleFocusedSession,
  } = useAutoTitleController({
    applyLiveSessionList,
    enabledMachinesRef,
    focusedKey,
    liveRef,
    liveSessionKeys,
    refresh: () => refreshRef.current?.() ?? Promise.resolve(),
    sessionsByKey,
    setError,
    setRetitleFeedback,
    setSessions,
    showRetitleFeedback,
    activeTerminalSlotKey: sessionShortcutTarget,
  });

  const refresh = useCallback(async (
    tick?: AsyncPollTick,
    generation?: RefreshGeneration,
    mode: "fresh" | "poll" | "recovery" = tick ? "poll" : "fresh",
  ) => {
    const generationToken = enabledMachinesGenerationRef.current;
    const isCurrent = () =>
      (tick?.isCurrent() ?? liveRef.current) &&
      enabledMachinesGenerationRef.current === generationToken &&
      !generation?.signal.aborted;
    const targetMachines = generation?.machines ?? enabledMachinesRef.current;
    const requestSequence = ++listRequestSequenceRef.current;
    try {
      const res = await listSessions(targetMachines, generation?.signal ?? tick?.signal, mode);
      if (!isCurrent()) return;
      setUnsubmittedCreatePrompts((current) => reconcileUnknownCreateRecoveries(current, requestSequence, res.machines));
      if (res.ok) {
        const captureStart = loadPerformanceCapture()?.started_at;
        if (captureStart && recordedUsableListCaptureRef.current !== captureStart) {
          pendingUsableListCaptureRef.current = captureStart;
        }
      }
      const applied = applyLiveSessionList(res);
      updateAutoTitleStates((prev) => pruneAutoTitleStates(prev, applied.sessions.map(sessionKey)));
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const applied = applyLiveSessionList(
        unavailableSessionList(targetMachines, err instanceof Error ? err.message : undefined, machineMetadataRef.current),
      );
      updateAutoTitleStates((prev) => pruneAutoTitleStates(prev, applied.sessions.map(sessionKey)));
    }
  }, [applyLiveSessionList, updateAutoTitleStates]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Resuming from History is a request to work in that session, so route focus
  // to it the same way a fresh create does: arm the pending-focus key and let
  // the list reconcile it, which also handles the machine filter and the
  // grid-slot versus full-session choice once the session actually appears.
  const focusResumedSession = useCallback(async (resumed: { readonly machine: string; readonly id: string }) => {
    pendingCreatedFocusKeyRef.current = sessionKey(resumed);
    pendingCreatedGridPageRef.current = null;
    pendingCreatedFocusFulfilledRef.current = false;
    await refresh();
  }, [refresh]);

  // Keep the poll's machine allowlist current and refresh immediately when a
  // machine is toggled: enabling a spoke connects at once, disabling drops it
  // from the very next poll. Also drop a stale machine filter that just became
  // disabled.
  useEffect(() => {
    const controller = new AbortController();
    enabledMachinesGenerationRef.current += 1;
    enabledMachinesRef.current = pollingMachines;
    invalidateCounts();
    setMachineFilter((f) => (f === ALL || enabledMachines.includes(f) ? f : ALL));
    const pending = {
      key: pollingMachines.join("\0"),
      promise: refresh(undefined, { signal: controller.signal, machines: pollingMachines }, "poll"),
    };
    immediateRefreshRef.current = pending;
    void pending.promise.finally(() => {
      if (immediateRefreshRef.current === pending) immediateRefreshRef.current = null;
    });
    return () => controller.abort();
  }, [pollingMachines, refresh, invalidateCounts]);

  const pollRefresh = useCallback(async (tick: AsyncPollTick) => {
    const pending = immediateRefreshRef.current;
    if (pending && pending.key === enabledMachinesRef.current.join("\0")) {
      await pending.promise;
      return;
    }
    await refresh(tick);
  }, [refresh]);
  const sessionsResourceHealthy = useResourceEvents({ resource: "sessions", machines: pollingMachines }, () => {
    void refreshRef.current?.(undefined, undefined, "poll");
  });
  useAsyncPoll(pollRefresh, sessionsResourceHealthy ? RESOURCE_RECONCILE_MS : POLL_MS);

  useEffect(() => {
    let offlineObserved = navigator.onLine === false;
    let onlineRecoveryPending = false;
    const wake = (mode: "poll" | "recovery") => {
      if (document.visibilityState === "hidden") return;
      enabledMachinesGenerationRef.current += 1;
      if (mode === "recovery") { invalidateCounts(); resetSessionPollRequests(); }
      void refresh(undefined, undefined, mode);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        const mode = onlineRecoveryPending ? "recovery" : "poll";
        onlineRecoveryPending = false;
        wake(mode);
      }
    };
    const onOffline = () => { offlineObserved = true; invalidateCounts(); };
    const onOnline = () => {
      if (!offlineObserved) return;
      offlineObserved = false;
      if (document.visibilityState === "hidden") {
        onlineRecoveryPending = true;
        return;
      }
      wake("recovery");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, invalidateCounts]);

  useEffect(() => {
    const controller = new AbortController();
    activityStreamCursorsRef.current = createActivityStreamCursorState();
    setActivityDeliveryByMachine(createActivityDeliveryState(pollingMachines));
    const reconcileGeneration = createActivityReconcileGeneration(controller.signal, async (signal) => {
      await (refreshRef.current?.(undefined, { signal, machines: pollingMachines }, "poll") ?? Promise.resolve());
    });
    void runActivityStream({
      machines: pollingMachines,
      signal: controller.signal,
      onState: (state) => {
        if (!controller.signal.aborted && liveRef.current) {
          setActivityDeliveryByMachine((current) => activityDeliveryAfterConnection(current, state));
        }
      },
      onEvent: (event) => {
        if (controller.signal.aborted || !liveRef.current) return;
        setActivityDeliveryByMachine((current) => activityDeliveryAfterFeedEvent(current, event));
        if (event.type === "delivery") return;
        setSessions((current) => {
          const result = applyActivityStreamEvent({
            cursors: activityStreamCursorsRef.current,
            enabledMachines: enabledMachinesRef.current,
            sessions: current,
            event,
            receivedMonotonicMs: performance.now(),
          });
          activityStreamCursorsRef.current = result.cursors;
          if (result.decision !== "applied") return current;
          sessionsRef.current = result.sessions;
          if (result.needsReconcile) queueMicrotask(reconcileGeneration.reconcile);
          return result.sessions;
        });
      },
    });
    return () => {
      controller.abort();
    };
  }, [pollingMachines]);

  // Consumers refresh one session on demand through useSessionRefresh.
  const sessionRefreshControl = useMemo<SessionRefreshControl>(() => ({
    async refresh(target) {
      const listed = sessionsRef.current.find((session) => sessionKey(session) === sessionKey(target));
      const result = await refreshSessionInfo(target);
      if (!result.ok) return { ok: false, message: result.error };
      if (!liveRef.current) return { ok: false, message: "Session info was not applied." };
      // Merge inside the state queue, after any queued activity or poll update, and report from it.
      const applied = await new Promise<boolean>((resolve) => {
        setSessions((current) => {
          const merged = mergeRefreshedSession(current, target.machine, result.session, listed?.session_incarnation);
          resolve(merged.applied);
          if (!merged.applied) return current;
          sessionsRef.current = merged.sessions as DashboardSession[];
          return merged.sessions as DashboardSession[];
        });
      });
      if (!applied) return { ok: false, message: "The session changed while refreshing. Try again." };
      return { ok: true, changed: result.changed };
    },
  }), []);

  const reportCreatedSessionInitialization = (result: CreatedSessionInitializationResult | null) => {
    const errors = [
      result?.autoResume.status === "failed" || result?.autoResume.status === "unknown"
        ? result.autoResume.error
        : undefined,
      result?.autoResume.status === "skipped" && result.autoResume.reason === "no-session"
        ? "Created session identity was not confirmed; default auto-resume was not enabled."
        : undefined,
      result?.autoResume.status === "skipped" && result.autoResume.reason === "startup-failed"
        ? "The session failed to start; default auto-resume and the initial prompt were not submitted."
        : undefined,
      result?.autoResume.status === "skipped" && result.autoResume.reason === "startup-unknown"
        ? "The machine returned invalid startup metadata; post-create actions were skipped for safety."
        : undefined,
      result?.prompt.status === "failed" ? result.prompt.error : undefined,
      result?.prompt.status === "unknown" ? result.prompt.error : undefined,
      result?.prompt.status === "skipped" && result.prompt.reason === "no-session"
        ? "Created session identity was not confirmed; the initial prompt was not submitted. Open the created session and submit it manually."
        : undefined,
    ].filter((message): message is string => Boolean(message));
    if (errors.length > 0) {
      setError(errors.join(" · "));
      return true;
    }
    return false;
  };

  // Put a just-created or just-resumed session into the slot its dialog was
  // opened from, if any, and persist its position in the layout order.
  const placeCreatedSession = (
    targetSlot: number | null,
    createdKey: string,
    applied: ReturnType<typeof applyLiveSessionList>,
  ) => {
    let nextSlots = slotsRef.current;
    const placedInSlot = targetSlot !== null;
    if (targetSlot !== null) {
      nextSlots = assignSlot(slotsRef.current, targetSlot, createdKey);
      slotsRef.current = nextSlots;
      setSlots(nextSlots);
    }
    cancelPendingLayoutDebounce();
    const localOrder = orderForCreatedSession(
      placedInSlot ? nextSlots : layoutSessionKeysRef.current,
      createdKey,
      placedInSlot,
    );
    void persistLayoutLocalOrder(localOrder, new Set(applied.sessions.map(sessionKey)), applied.reachableMachineNames, "create", {
      localOrderPlacement: placedInSlot,
      keepalive: true,
      urgent: true,
    });
  };

  const onCreate = async (machine: string, body: CreateBody) => {
    if (createInFlightRef.current) {
      return;
    }
    const promptValidationError = validateInitialPrompt(body.prompt ?? "");
    if (promptValidationError) {
      setCreateError(promptValidationError);
      return;
    }
    if (unknownCreateOutcomePending) {
      setCreateError("Check the session list for the unknown creation outcome, then allow a new session or dismiss it.");
      return;
    }
    const recoveryCapacityError = promptRecoveryCapacityError(unsubmittedCreatePrompts, body.prompt ?? "");
    if (recoveryCapacityError) {
      setCreateError(recoveryCapacityError);
      return;
    }
    createInFlightRef.current = true;
    cancelPendingCreatedFocus();
    setCreating(true);
    setCreateError(undefined);
    let created = false;
    const retainUnknownCreation = (message: string) => {
      // Abort shared poll reads that may have started before the failure, so a
      // later poll cannot join one and reconcile from a pre-incident answer.
      resetSessionPollRequests();
      nextCreatePromptRecoveryKeyRef.current += 1;
      setUnsubmittedCreatePrompts((current) => [...current, {
        key: nextCreatePromptRecoveryKeyRef.current,
        prompt: body.prompt ?? "",
        machine,
        submissionOutcome: "not-submitted",
        creationOutcomeUnknown: true,
        listRequestFloor: listRequestSequenceRef.current,
      }]);
      setShowCreate(false);
      setPendingSlot(null);
      pendingCreatePageRef.current = null;
      setError(message);
    };
    try {
      const before = new Set(sessions.map(sessionKey));
      const {
        createBody,
        prompt,
        titlePrompt,
        baseTitle,
        fallbackTitle,
      } = prepareCreateSessionAutoTitle(body);
      const defaultAutoResumeInitialization = defaultAutoResumeForCreate(
        defaultAutoResume,
        createBody,
        setSessionAutoResume,
      );
      const r = await requestWithCreateLifecycleDeadline(
        "Session creation",
        (signal) => createSession(machine, createBody, signal),
        createRequestTimeoutMs(createBody),
      );
      if (!r.ok) {
        if (r.outcomeUnknown) {
          retainUnknownCreation(
            "Session creation outcome is unknown; inspect the session list and retained prompt before retrying.",
          );
        } else {
          setCreateError(r.error);
        }
        return;
      }
      created = true;
      pendingCreatedFocusKeyRef.current = r.id ? sessionKey({ machine, id: r.id }) : null;
      pendingCreatedGridPageRef.current = r.id ? pendingCreatePageRef.current : null;
      pendingCreatePageRef.current = null;
      pendingCreatedFocusFulfilledRef.current = false;
      const targetSlot = pendingSlot;
      setPendingSlot(null);
      const initializationResult = await initializeCreatedSession({
        machine,
        createdId: r.id,
        createdSessionIncarnation: r.session?.session_incarnation,
        createdStartup: r.startup,
        prompt,
        defaultAutoResume: defaultAutoResumeInitialization.enabled
          ? {
              enabled: true,
              setSessionAutoResume: (targetMachine, id, enabled) => requestWithCreateLifecycleDeadline(
                "Default auto-resume enablement",
                (signal) => setSessionAutoResume(
                  targetMachine,
                  id,
                  enabled,
                  signal,
                  accountRecoveryPolicy(r.session),
                ),
              ),
            }
          : defaultAutoResumeInitialization,
        submitSessionPrompt: (targetMachine, id, promptBody) => requestWithCreateLifecycleDeadline(
          "Structured initial prompt submission",
          (signal) => submitSessionPrompt(targetMachine, id, promptBody, signal),
        ),
      });
      // Keep the modal above every terminal until auto-resume and the staged
      // prompt have reached a terminal outcome, so user input cannot overtake
      // the initial prompt while the new session appears through polling.
      setShowCreate(false);
      const recoverablePrompt = recoverableCreatedPrompt(prompt, initializationResult);
      if (recoverablePrompt) {
        const recoveryTarget = initializationResult.prompt.status === "failed"
          || initializationResult.prompt.status === "unknown"
          ? initializationResult.prompt.session
          : "session" in initializationResult.autoResume
            ? initializationResult.autoResume.session
            : r.id ? { machine, id: r.id } : null;
        nextCreatePromptRecoveryKeyRef.current += 1;
        setUnsubmittedCreatePrompts((current) => [...current, {
          key: nextCreatePromptRecoveryKeyRef.current,
          prompt: recoverablePrompt,
          machine: recoveryTarget?.machine ?? machine,
          ...(recoveryTarget ? { sessionId: recoveryTarget.id } : {}),
          submissionOutcome: initializationResult.prompt.status === "unknown" ? "unknown" : "not-submitted",
        }]);
      }
      const confirmedPrompt = submittedCreatedPrompt(prompt, initializationResult);
      const initializeCreatedTitle = (createdSession: CreatedSessionSnapshot | null | undefined): boolean => {
        const titleSession = createdSession
          ? {
              ...createdSession,
              retitle_path: createdSession.retitle_path
                ?? retitlePathByMachineRef.current.get(createdSession.machine)
                ?? "legacy_edge",
            }
          : null;
        const createdTitleState = createdSession
          ? createdSessionAutoTitleState({
              createBody,
              createdSession: titleSession!,
              prompt: confirmedPrompt,
              baseTitle,
              fallbackTitle,
            })
          : null;
        if (!createdSession || !createdTitleState) {
          return false;
        }
        updateAutoTitleStates((prev) => ({
          ...prev,
          [sessionKey(createdSession)]: createdTitleState,
        }));
        if (confirmedPrompt && titlePrompt && fallbackTitle) {
          void applyCreatePromptSummary(titleSession!, titlePrompt, baseTitle, fallbackTitle);
        }
        return true;
      };
      const titleInitializedFromCreateResponse = initializeCreatedTitle(r.session);
      // If the create was launched from a slot's picker, drop the new session into
      // that slot instead of leaving placement to the reconcile pass.
      const res = await requestWithCreateLifecycleDeadline(
        "Created session reconciliation",
        (signal) => listSessions(enabledMachinesRef.current, signal),
      ).catch(() => null);
      if (!res) {
        if (!reportCreatedSessionInitialization(initializationResult)) {
          void refresh();
        }
        return;
      }
      const applied = applyLiveSessionList(res);
      // Only the create response can authoritatively identify the session that
      // owns post-create mutations. A newly listed no-id candidate may belong to
      // another concurrent create, so keep it display-only.
      const reconciledCreatedSession = r.id
        ? resolveCreatedSession(res.sessions, before, { machine, id: r.id })
        : null;
      const titleCreatedSession = resolveCreateTitleSession(r.session, reconciledCreatedSession);
      const createdKey = reconciledCreatedSession ? sessionKey(reconciledCreatedSession) : undefined;
      if (createdKey) {
        placeCreatedSession(targetSlot, createdKey, applied);
      } else if (r.id) {
        void refresh();
      }
      reportCreatedSessionInitialization(initializationResult);
      if (!titleInitializedFromCreateResponse) {
        initializeCreatedTitle(titleCreatedSession);
      }
    } catch (err) {
      const message = err instanceof CreateLifecycleDeadlineError
        ? `${err.message}. Inspect the session list and retained prompt before retrying.`
        : (err as Error).message;
      if (created) {
        setError(message);
      } else if (err instanceof CreateLifecycleDeadlineError) {
        retainUnknownCreation(message);
      } else {
        setCreateError(message);
      }
    } finally {
      createInFlightRef.current = false;
      setCreating(false);
    }
  };

  const storeMaintenanceIncident = useCallback((incident: SessionMaintenanceIncident, open: boolean) => {
    setMaintenanceIncidents((current) => [
      ...current.filter((candidate) => candidate.key !== incident.key),
      incident,
    ]);
    if (open) {
      setMaintenanceOpenKey(incident.key);
    }
  }, []);

  const inspectFailedSession = useCallback(async (
    session: Session,
    operation: MaintenanceOperation,
    error: string,
    open = true,
    signal?: AbortSignal,
  ): Promise<SessionMaintenanceIncident> => {
    try {
      const inspected = await inspectSessionMaintenance(session.machine, session.id, operation, signal);
      const incident = createSessionMaintenanceIncident(
        session,
        operation,
        inspected.error ?? error,
        inspected.maintenance ?? null,
        inspected.unsupported === true,
      );
      storeMaintenanceIncident(incident, open);
      return incident;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const incident = createSessionMaintenanceIncident(
        session,
        operation,
        (cause as Error)?.message ?? error,
      );
      storeMaintenanceIncident(incident, open);
      return incident;
    }
  }, [storeMaintenanceIncident]);

  const onResume = async (s: Session) => {
    const key = sessionKey(s);
    setResumingKey(key);
    try {
      const result = await resumeSession(s.machine, s.id);
      if (!result.ok) {
        const message = result.error ?? "resume failed";
        setError(message);
        await inspectFailedSession(s, "resume", message);
        return;
      }
      await refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      await inspectFailedSession(s, "resume", message);
    } finally {
      setResumingKey((current) => (current === key ? null : current));
    }
  };

  const onAutoResume = async (s: Session, enabled: boolean) => {
    const key = sessionKey(s);
    const disableCompletedResume = !enabled && s.auto_resume?.state === "resumed";
    setAutoResumePendingKey(key);
    try {
      const operation = enabled ? "enable" : disableCompletedResume ? "disable" : "cancel";
      const result = enabled
        ? await setSessionAutoResume(
          s.machine,
          s.id,
          true,
          undefined,
          accountRecoveryPolicy(s),
        )
        : disableCompletedResume
            ? await setSessionAutoResume(s.machine, s.id, false)
            : await cancelSessionAutoResume(s.machine, s.id);
      if (!result.ok) {
        setError(result.error ?? `auto-resume ${operation} failed`);
        return false;
      }
      await refresh();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setAutoResumePendingKey((current) => (current === key ? null : current));
    }
  };

  const onAccount = async (s: Session, account: string) => {
    const provider = sessionAccountProvider(s.agent);
    if (!provider) return;
    const label = ACCOUNT_PROVIDER_LABELS[provider];
    const key = sessionKey(s);
    setAccountPendingKey(key);
    try {
      if (!s.session_incarnation) {
        setError(`${label} account switch requires a current session incarnation`);
        return;
      }
      const result = await switchSessionAccount(provider, s.machine, s.id, account, s.session_incarnation);
      if (!result.ok) {
        if (result.outcomeUnknown) {
          await refresh();
        }
        setError(result.error ?? `${label} account switch failed`);
        return;
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAccountPendingKey((current) => (current === key ? null : current));
    }
  };

  const copySessionCommand = async (s: Session, action?: SessionCardCopyAction) => {
    clearCopiedCommandKey();
    const result = action ? await copySessionCardActionToClipboard(action) : await copySessionCommandToClipboard(s);
    if (!result.ok) {
      if (!("reason" in result) || result.reason !== "no-command") {
        setError(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: "" }));
      }
      return false;
    }
    const key = sessionKey(s);
    showCopiedCommandKey(key);
    return true;
  };

  const copyStartupDiagnostics = async (s: Session) => {
    const diagnostic = startupFailureDiagnostic(s);
    if (!diagnostic) return;
    const bundle = createStartupFailureDebugBundle(diagnostic);
    try {
      await writeTerminalClipboardText(JSON.stringify(bundle, null, 2));
      showCopiedStartupDiagnosticsKey(sessionKey(s));
    } catch {
      setError(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: "" }));
    }
  };

  const repairSessions = useCallback(async () => {
    if (repairingSessions || pendingRepair) {
      return;
    }
    repairOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRepairingSessions(true);
    setRepairMessage(null);
    closeOpenSlotMenus();

    try {
      const res = await listSessions(enabledMachinesRef.current);
      if (!liveRef.current) return;
      applyLiveSessionList(res);

      const filters = sessionFiltersRef.current;
      const selectedMachine = machineFilterRef.current;
      const repairRecords = filterRecords(
        res.sessions.map(session => ({ ...session, session_id: session.id,
          created_at: session.created_at ?? "", provider: session.agent })),
        filters,
        createSessionRole?.(res.sessions.map(session => ({ ...session, session_id: session.id, created_at: session.created_at ?? "", provider: session.agent })), res.ext) ?? roleOf,
      );
      const repairVisible = sortByDefaultSessionOrder(
        selectedMachine === ALL ? repairRecords : repairRecords.filter(s => s.machine === selectedMachine), machines,
      );
      setPendingRepair({
        plan: planSessionRepairs({ sessions: repairVisible }),
        machines: selectedMachine !== ALL ? selectedMachine : filters.hosts?.join(", ") ?? "All enabled machines",
        repository: filters.repo || "All repositories",
      });
    } catch (err) {
      if (liveRef.current) setError((err as Error).message);
    } finally {
      if (liveRef.current) setRepairingSessions(false);
    }
  }, [
    closeOpenSlotMenus,
    machines,
    roleOf,
    repairingSessions,
    pendingRepair,
    applyLiveSessionList,
  ]);

  const confirmRepairSessions = async () => {
    if (!pendingRepair || repairingSessions) return;
    setRepairingSessions(true);
    const { plan } = pendingRepair;
    try {
      const result = await executeSessionRepairPlan({
        plan,
        resumeSession: (session) => resumeSession(session.machine, session.id),
      });

      setReconnectTokens((prev) => incrementReconnectTokens(prev, result.reconnectKeys));
      setSessions((current) => applySessionRepairResult(current, result));
      if (liveRef.current) {
        const summary = sessionRepairSummary({
          checked: result.checked,
          resumed: result.resumed,
          reconnected: result.reconnected,
          failed: result.failed,
        });
        setRepairMessage(result.failed > 0 ? attentionRepairToast(summary) : completedRepairToast(summary));
        if (result.failures.length > 0) {
          const sessionsByFailureKey = new Map(plan.resume.map(session => [sessionKey(session), session]));
          await Promise.all(result.failures.map(async (failure) => {
            const failedSession = sessionsByFailureKey.get(failure.sessionKey);
            if (failedSession) {
              await inspectFailedSession(failedSession, failure.operation, failure.message, false);
            }
          }));
        }
      }
    } catch (err) {
      if (liveRef.current) setError((err as Error).message);
    } finally {
      if (liveRef.current) {
        setPendingRepair(null);
        setRepairingSessions(false);
      }
    }
  };

  const removeSessionsLocally = useCallback((removedSessions: readonly Session[], refreshAfter = true) => {
    const removedKeys = new Set(removedSessions.map(sessionKey));
    if (removedKeys.size === 0) return;
    const nextSessions = sessionsRef.current.filter((item) => !removedKeys.has(sessionKey(item)));
    const nextLayoutOrder = layoutSessionKeysRef.current.filter((key) => !removedKeys.has(key));
    const filteredSessions = machineFilter === ALL
      ? nextSessions
      : nextSessions.filter((session) => session.machine === machineFilter);
    const nextVisible = sortByDefaultSessionOrder(filteredSessions, machines);
    const nextSlots = compactSlotsAfterRemoval(slotsRef.current, removedKeys, nextVisible, nextLayoutOrder);
    sessionsRef.current = nextSessions;
    slotsRef.current = nextSlots;
    setSessions(nextSessions);
    setSlots(nextSlots);
    if (pendingCreatedFocusKeyRef.current && removedKeys.has(pendingCreatedFocusKeyRef.current)) {
      cancelPendingCreatedFocus();
    }
    cancelPendingLayoutDebounce();
    void persistLayoutLocalOrder(
      nextLayoutOrder,
      new Set(nextSessions.map(sessionKey)),
      reachableMachineNamesRef.current,
      "close",
      { keepalive: true, urgent: true, removedKeys },
    );
    setFocusedKey((current) => (current !== null && removedKeys.has(current) ? null : current));
    setTerminalStatusByKey((prev) => {
      const next = new Map(prev);
      for (const key of removedKeys) next.delete(key);
      return next.size === prev.size ? prev : next;
    });
    updateAutoTitleStates((prev) => pruneAutoTitleStates(prev, nextSessions.map(sessionKey)));
    if (refreshAfter) void refresh();
  }, [
    cancelPendingCreatedFocus,
    cancelPendingLayoutDebounce,
    machineFilter,
    machines,
    persistLayoutLocalOrder,
    refresh,
    updateAutoTitleStates,
  ]);

  const removeSessionLocally = useCallback((session: Session) => {
    removeSessionsLocally([session]);
  }, [removeSessionsLocally]);

  const closeSession = useCallback(async (session: Session): Promise<boolean> => {
    // Keep the confirmation dialog present when the mutation fails. The user
    // can inspect producer-owned recovery facts from that same decision point.
    let result: Awaited<ReturnType<typeof killSession>>;
    try {
      result = await killSession(session.machine, session.id);
    } catch (err) {
      const message = (err as Error)?.message ?? "session delete failed";
      setError(message);
      setCloseDeleteError(message);
      await inspectFailedSession(session, "delete", message, false);
      return false;
    }
    if (!result.ok) {
      const message = result.error ?? "session delete failed";
      setError(message);
      setCloseDeleteError(message);
      await inspectFailedSession(session, "delete", message, false);
      return false;
    }
    setCloseDeleteError(null);
    if (result.cleanupPending) {
      storeMaintenanceIncident(createSessionMaintenanceIncident(
        session,
        "delete",
        "Logical deletion completed; physical cleanup is pending.",
        null,
        false,
        true,
      ), false);
      setRepairMessage({
        text: "Session deleted; physical cleanup is pending in Maintenance.",
        intent: "attention",
        actions: ["view_failures", "dismiss"],
      });
    }
    removeSessionLocally(session);
    return true;
  }, [inspectFailedSession, removeSessionLocally, storeMaintenanceIncident]);

  const confirmCloseSessionDelete = useCallback(async () => {
    const session = closeConfirmSession;
    if (!session) {
      return;
    }
    const deleted = await closeSession(session);
    if (deleted) {
      setCloseConfirmSession(null);
    }
  }, [closeConfirmSession, closeSession]);

  const confirmCloseSessionArchive = useCallback(async (starred: boolean) => {
    const session = closeConfirmSession;
    if (!session) return;
    if (!session.session_incarnation) return;
    if (!session.provider_resume?.session_id || !archiveMachineNames.has(session.machine)) return;
    setCloseDeleteError(null);
    let result: Awaited<ReturnType<typeof archiveSession>>;
    try {
      result = await archiveSession(
        session.machine,
        session.id,
        session.session_incarnation,
        starred ? { starred: true } : {},
      );
    } catch (error) {
      result = { ok: false, error: (error as Error)?.message ?? "session archive failed" };
    }
    if (!result.ok) {
      const message = result.error ?? "session archive failed";
      setError(message);
      setCloseDeleteError(message);
      return;
    }
    removeSessionLocally(session);
    setCloseConfirmSession(null);
    setRepairMessage({
      text: result.starredAt
        ? "Session archived and starred. It leads the History list until you unstar it."
        : "Session archived. Its provider conversation remains available in History.",
      intent: "complete",
      actions: ["dismiss"],
    });
  }, [
    archiveMachineNames,
    closeConfirmSession,
    refresh,
    removeSessionLocally,
    removeSessionsLocally,
  ]);

  const refreshMaintenanceIncident = useCallback(async (incident: SessionMaintenanceIncident) => {
    if (maintenancePendingRef.current) return;
    const controller = new AbortController();
    maintenanceInspectionAbortRef.current?.abort();
    maintenanceInspectionAbortRef.current = controller;
    const pending: MaintenancePendingOperation = {
      kind: "inspect",
      incidentKey: incident.key,
      token: Symbol("maintenance-inspect"),
    };
    maintenancePendingRef.current = pending;
    setMaintenancePending(pending);
    try {
      await inspectFailedSession(incident.session, incident.operation, incident.error, true, controller.signal);
    } catch {
      // Closing the drawer aborts inspection without replacing the retained incident.
    } finally {
      if (maintenancePendingRef.current === pending) {
        maintenancePendingRef.current = null;
        setMaintenancePending(null);
      }
      if (maintenanceInspectionAbortRef.current === controller) {
        maintenanceInspectionAbortRef.current = null;
      }
    }
  }, [inspectFailedSession]);

  const runMaintenanceAction = useCallback(async (
    incident: SessionMaintenanceIncident,
    action: MaintenanceAction,
    confirmed: boolean,
  ) => {
    if (!incident.preview || maintenancePendingRef.current) return;
    const request = buildMaintenanceActionRequest(incident.preview, action, confirmed);
    if (!request) {
      setError("Confirm the maintenance action before continuing.");
      return;
    }
    const pending: MaintenancePendingOperation = {
      kind: "action",
      incidentKey: incident.key,
      actionId: action.id,
      previewDigest: incident.preview.preview_digest,
      token: Symbol("maintenance-action"),
    };
    maintenancePendingRef.current = pending;
    setMaintenancePending(pending);
    try {
      const response = await executeSessionMaintenanceAction(
        incident.session.machine,
        incident.session.id,
        request,
      );
      if (maintenancePendingRef.current !== pending) return;
      if (!response.ok || !response.result) {
        const message = response.error ?? "session maintenance failed";
        setError(message);
        if (response.maintenance) {
          storeMaintenanceIncident(createSessionMaintenanceIncident(
            incident.session,
            incident.operation,
            message,
            response.maintenance,
          ), true);
        } else {
          await inspectFailedSession(incident.session, incident.operation, message);
        }
        return;
      }

      // Record-only removal quarantines the same metadata ordinary deletion
      // does, so the card and every layout reference converge the same way. Only
      // the copy differs, because nothing was stopped.
      if (response.result.outcome === "deleted" || response.result.outcome === "record_removed") {
        const current = sessionsRef.current.find((session) => sessionKey(session) === sessionKey(incident.session));
        if (shouldRemoveDeletedMaintenanceSessionLocally(current, incident.session)) {
          removeSessionLocally(incident.session);
        }
        setCloseConfirmSession(null);
        await refresh();
      } else if (response.result.outcome === "resumed") {
        await refresh();
      } else {
        await inspectFailedSession(incident.session, incident.operation, "Session inspected.");
        return;
      }
      setMaintenanceOpenKey(null);
      if (response.result.cleanup_pending) {
        storeMaintenanceIncident(createSessionMaintenanceIncident(
          incident.session,
          "delete",
          "Logical deletion completed; physical cleanup is pending.",
          null,
          false,
          true,
        ), false);
        setRepairMessage({
          // Record-only removal stopped nothing, so its pending-cleanup notice
          // must not claim the session was deleted.
          text: `${maintenanceOutcomeToast(response.result.outcome)}`
            + " Secure metadata cleanup is pending and will retry in the background.",
          intent: "attention",
          actions: ["view_failures", "dismiss"],
        });
      } else {
        setMaintenanceIncidents((current) => current.filter((candidate) => candidate.key !== incident.key));
        setRepairMessage(completedRepairToast(maintenanceOutcomeToast(response.result.outcome)));
      }
    } catch (error) {
      if (maintenancePendingRef.current !== pending) return;
      const message = (error as Error)?.message ?? "session maintenance failed";
      setError(message);
      await inspectFailedSession(incident.session, incident.operation, message);
    } finally {
      if (maintenancePendingRef.current === pending) {
        maintenancePendingRef.current = null;
        setMaintenancePending(null);
      }
    }
  }, [inspectFailedSession, removeSessionLocally, refresh, storeMaintenanceIncident]);

  const copyMaintenanceDiagnostics = useCallback(async (incident: SessionMaintenanceIncident) => {
    try {
      await writeTerminalClipboardText(JSON.stringify(sessionMaintenanceDiagnostics(incident), null, 2));
      setRepairMessage(completedRepairToast("Maintenance diagnostics copied."));
    } catch {
      setError(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: "" }));
    }
  }, []);

  const copyMaintenanceNextPrompt = useCallback(async (incident: SessionMaintenanceIncident) => {
    try {
      await writeTerminalClipboardText(sessionMaintenanceNextPrompt(incident));
      setRepairMessage(completedRepairToast("Recovery prompt copied."));
    } catch {
      setError(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: "" }));
    }
  }, []);

  const reviewSessionMaintenance = useCallback((session: Session, operation: MaintenanceOperation) => {
    void inspectFailedSession(session, operation, `Inspect ${operation} recovery options.`);
  }, [inspectFailedSession]);

  const dismissMaintenanceIncident = useCallback((incident: SessionMaintenanceIncident) => {
    if (maintenancePendingRef.current) return;
    setMaintenanceIncidents((current) => current.filter((candidate) => candidate.key !== incident.key));
    setMaintenanceOpenKey((current) => current === incident.key ? null : current);
  }, []);

  const onKill = async (s: Session) => {
    beginCloseSessionConfirm(s);
  };

  const beginTitleEdit = useCallback((s: Session) => {
    setEditingTitleKey(sessionKey(s));
  }, []);

  const renameFocusedSession = useCallback(() => {
    const key = sessionShortcutTarget();
    if (!key) {
      return;
    }
    const session = sessionsByKey.get(key);
    if (!session) {
      return;
    }
    closeOpenSlotMenus();
    beginTitleEdit(session);
  }, [beginTitleEdit, closeOpenSlotMenus, sessionShortcutTarget, sessionsByKey]);

  const reconnectFocusedSession = useCallback(() => {
    const key = sessionShortcutTarget();
    if (!key) {
      return;
    }
    setReconnectTokens((prev) => incrementReconnectTokens(prev, [key]));
  }, [sessionShortcutTarget]);

  const closeFocusedSession = useCallback(async () => {
    const key = sessionShortcutTarget();
    if (!key) {
      return;
    }
    const session = sessionsByKey.get(key);
    if (!session) {
      return;
    }
    beginCloseSessionConfirm(session);
  }, [beginCloseSessionConfirm, sessionShortcutTarget, sessionsByKey]);

  const openSessionByShortcutIndex = useCallback((index: number) => {
    const key = shortcutSessionKeys[index];
    if (!key) {
      return;
    }
    enterSession(key, sessionsByKey.get(key)?.machine);
  }, [enterSession, sessionsByKey, shortcutSessionKeys]);

  // The focused-header ordinal picker jumps straight to a chosen session, matching
  // the ⌘H/⌘L pager's focus behavior rather than reassigning the slot.
  const onFocusSession = useCallback((key: string) => {
    enterSession(key, sessionsByKey.get(key)?.machine);
  }, [enterSession, sessionsByKey]);

  // Badge extensions select their target; core owns focus and applied filter state.
  const followLineageMarker = useCallback((_session: Session, navigation?: SessionBadgeNavigation) => {
    const targetKey = navigation?.session ? sessionKey(navigation.session) : null;
    if (targetKey && sessionsByKey.has(targetKey)) {
      onFocusSession(targetKey);
    }
  }, [onFocusSession, sessionsByKey]);

  const onOverviewSession = useCallback((key: string) => {
    const session = sessionsByKey.get(key);
    if ((viewport.mobile || viewport.touchPrimary) && phoneSessionOpen === "conversation" && session) {
      setPhoneConversationNotice(undefined);
      if (historyMachineNames.has(session.machine)) openConversation(session);
      else openPhoneTerminal(session, viewport.mobile);
      return;
    }
    const action = resolveSessionNavigatorSelection({
      selectedSessionKey: key,
      gridSessionKeys: overviewPage.sessionKeys,
      promptTargetKey: !viewport.mobile && promptTargetKey && overviewPage.sessionKeys.includes(promptTargetKey)
        ? promptTargetKey
        : null,
      mobileOverview: viewport.mobile,
    });
    if (action.kind === "focus-grid") {
      requestPromptTargetFocus(action.sessionKey);
      return;
    }
    overviewRestorePromptTargetKeyRef.current = action.restorePromptTargetKey;
    enterSession(action.sessionKey, sessionsByKey.get(action.sessionKey)?.machine);
  }, [enterSession, overviewPage.sessionKeys, promptTargetKey, requestPromptTargetFocus, sessionsByKey, viewport.mobile, viewport.touchPrimary, phoneSessionOpen, historyMachineNames, openConversation, openPhoneTerminal]);
  // ⌘F: toggle between the grid list and a single focused session. From a
  // session it drops back to the list; from the list it enters the last
  // selected pane, falling back to the active terminal, remembered focus,
  // then the first session on the current overview page.
  const toggleFocusList = useCallback(() => {
    if (focusedKey !== null) {
      leaveFocusedSession();
      return;
    }
    const target = resolveToggleFocusTarget({
      selectedKey: sessionShortcutTarget(),
      activeTerminalKey: activeTerminalSlotKey(),
      rememberedKey: lastFocusedKeyRef.current,
      shortcutSessionKeys: overviewPage.sessionKeys,
    });
    if (!target) {
      return;
    }
    openSessionByShortcutIndex(shortcutSessionKeys.indexOf(target));
  }, [focusedKey, leaveFocusedSession, openSessionByShortcutIndex, overviewPage.sessionKeys, sessionShortcutTarget, shortcutSessionKeys]);

  const openFocusedVoicePrompt = useCallback(() => {
    const key = sessionShortcutTarget();
    const session = key ? sessionsByKey.get(key) : undefined;
    if (!key || !session?.session_incarnation) return;
    nextVoiceOpenRequestTokenRef.current += 1;
    setVoiceOpenRequest({
      key,
      machine: session.machine,
      id: session.id,
      sessionIncarnation: session.session_incarnation,
      title: session.title?.trim() || `${session.agent} session`,
      token: nextVoiceOpenRequestTokenRef.current,
    });
  }, [sessionShortcutTarget, sessionsByKey]);

  // Same target rule as the voice prompt: the pane the user is looking at.
  const toggleFocusedConversation = useCallback(() => {
    if (viewport.mobile && phoneConversationMode && focusedKey !== null) {
      const session = sessionsByKey.get(focusedKey);
      if (session) openPhoneTerminal(session);
      return;
    }
    if (conversationSession !== undefined) {
      closeConversation();
      return;
    }
    const key = sessionShortcutTarget();
    const session = key ? sessionsByKey.get(key) : undefined;
    if (session && historyMachineNames.has(session.machine)) openConversation(session);
  }, [closeConversation, conversationSession, focusedKey, historyMachineNames, openConversation, openPhoneTerminal, phoneConversationMode, sessionShortcutTarget, sessionsByKey, viewport.mobile]);

  // In the overview, walk only the rendered page and keep the grid open.
  // Fullscreen navigation keeps the complete shortcut ordering.
  const focusAdjacentSession = useCallback(
    (direction: -1 | 1) => {
      if (shortcutSessionKeys.length === 0) {
        return;
      }
      if (focusedKey === null) {
        if (viewport.mobile) return;
        const key = adjacentPromptTargetKey({
          orderedSessionKeys: overviewPage.sessionKeys,
          promptTargetKeys: overviewPage.sessionKeys,
          currentSessionKey: sessionShortcutTarget(),
          direction,
        });
        if (key) {
          rememberSessionInteraction(key);
          setPromptTargetKey(key);
          requestPromptTargetFocus(key);
          showShortcutFeedback({ key, text: SESSION_LIST_NAVIGATION_HINT });
        }
        return;
      }
      const current = shortcutSessionKeys.indexOf(focusedKey);
      const base = current < 0 ? (direction > 0 ? -1 : 0) : current;
      const nextIndex = (base + direction + shortcutSessionKeys.length) % shortcutSessionKeys.length;
      openSessionByShortcutIndex(nextIndex);
    },
    [focusedKey, openSessionByShortcutIndex, overviewPage.sessionKeys, rememberSessionInteraction, requestPromptTargetFocus, sessionShortcutTarget, shortcutSessionKeys, showShortcutFeedback, viewport.mobile],
  );

  // The header arrows ask for 0 / pageCount + 1 to wrap; menu choices are
  // absolute destinations, including jumps across several pages.
  const changeOverviewPage = (nextPage: number) => {
    if (nextPage < 1) {
      goToPreviousSessionListPage();
    } else if (nextPage > overviewPage.pageCount) {
      goToNextSessionListPage();
    } else if (nextPage !== overviewPage.page) {
      cancelPendingCreatedFocus();
      setSessionListPage(nextPage);
    }
  };

  // The page keys act like the header arrows. A focused session has no pager,
  // so there they land on the first session of the adjacent page.
  const stepPage = (direction: -1 | 1) => {
    if (focusedKey === null) {
      if (overviewPage.pageCount > 1) changeOverviewPage((overviewPage.page ?? 1) + direction);
      return;
    }
    if (phoneConversationLockedRef.current) return;
    const step = resolveFocusedPageStep({
      orderedSessionKeys: shortcutSessionKeys,
      focusedKey,
      fallbackPage: overviewPage.page ?? 1,
      pageSize: sessionListPageSize,
      direction,
    });
    if (!step) return;
    setSessionListPage(step.page);
    enterSession(step.sessionKey, sessionsByKey.get(step.sessionKey)?.machine);
  };

  const cancelTitleEdit = () => {
    setEditingTitleKey(null);
  };

  const saveTitleEdit = async (s: Session, nextTitle: string | null) => {
    const result = await updateManualSessionTitle(s, nextTitle);
    if (!result.ok) {
      setError(result.error ?? "title update failed");
      return;
    }
    cancelTitleEdit();
  };

  const selectSlot = (index: number, value: string) => {
    rememberSessionInteraction(value);
    setSlots((prev) => assignSlot(prev, index, value));
  };

  const replaceOrderedSession = (currentKey: string, replacementKey: string): boolean => {
    if (currentKey === replacementKey) {
      return true;
    }
    const currentOrderIndex = layoutSessionKeys.indexOf(currentKey);
    const replacementOrderIndex = layoutSessionKeys.indexOf(replacementKey);
    if (currentOrderIndex < 0 || replacementOrderIndex < 0) {
      return false;
    }
    const nextOrder = [...layoutSessionKeys];
    nextOrder[currentOrderIndex] = replacementKey;
    nextOrder[replacementOrderIndex] = currentKey;
    void applyLayoutLocalOrder(nextOrder, "replace");
    return true;
  };

  // With manual ordering (Fixed role order off), each session dropdown row
  // offers an explicit Move here: the chosen session swaps into the menu
  // session's ranked position, from any page. In the focused view it also
  // takes focus there. Selecting the row itself only navigates
  // (#870).
  const moveSessionHere = (currentKey: string, key: string) => {
    if (!replaceOrderedSession(currentKey, key)) return;
    rememberSessionInteraction(key);
    if (focusedKey === currentKey) enterSession(key, sessionsByKey.get(key)?.machine);
  };

  const isOverviewSession = (key: SlotKey): key is string =>
    focusedKey === null && key !== null && overviewPage.sessionKeys.includes(key);

  const onSlotSelect = (index: number, currentKey: SlotKey, value: string) => {
    // A card's menu navigates like the overview picker; only Move here swaps.
    if (value && value !== NEW_SESSION && isOverviewSession(currentKey)) {
      onOverviewSession(value);
      return;
    }
    if (index < 0 || index >= slotsRef.current.length) {
      if (currentKey !== null && focusedKey !== currentKey && !isOverviewSession(currentKey)) {
        return;
      }
      if (value === NEW_SESSION) {
        setPendingSlot(null);
        pendingCreatePageRef.current = currentKey === null ? overviewPage.page : null;
        setShowCreate(true);
        return;
      }
      const selectedSession = sessionsRef.current.find((session) => sessionKey(session) === value);
      enterSession(value, selectedSession?.machine);
      return;
    }
    if (slotsRef.current[index] !== currentKey) {
      return;
    }
    if (value === NEW_SESSION) {
      setPendingSlot(index);
      pendingCreatePageRef.current = null;
      setShowCreate(true);
      return;
    }
    selectSlot(index, value);
  };

  useShortcutClose("repair-sessions", () => setPendingRepair(null), pendingRepair !== null && !repairingSessions);

  useDashboardKeyboard({
    active: active && !showCreate,
    autoLayout,
    autoDesktopMode: displayedDesktopMode,
    closeFocusedSession,
    closeOpenSlotMenus,
    // Navigation shortcuts wait for a phone Conversation reply in flight, like
    // the header, swipe and Back controls.
    focusAdjacentSession: (direction) => { if (!phoneConversationLockedRef.current) focusAdjacentSession(direction); },
    isEditableShortcutTarget,
    isTerminalShortcutTarget,
    onUsage,
    onPagePrevious: () => stepPage(-1),
    onPageNext: () => stepPage(1),
    onVoice: openFocusedVoicePrompt,
    onConversation: toggleFocusedConversation,
    onShortcutHelp: () => setShowShortcutHelp(true),
    openSessionByShortcutIndex: (index) => { if (!phoneConversationLockedRef.current) openSessionByShortcutIndex(index); },
    reconnectFocusedSession,
    repairSessions,
    renameFocusedSession,
    retitleFocusedSession,
    setAutoLayout,
    setFocusedKey: (next) => { if (!phoneConversationLockedRef.current) setFocusedKeyFromUser(next); },
    setLayoutMode,
    setPendingSlot,
    setShowCreate,
    toggleFocusList: () => { if (!phoneConversationLockedRef.current) toggleFocusList(); },
  });

  const cmdFocusTargetKey = useMemo(() => {
    if (focusedKey !== null) {
      return null;
    }
    return promptTargetKey && overviewPage.sessionKeys.includes(promptTargetKey)
      ? promptTargetKey
      : null;
  }, [focusedKey, overviewPage.sessionKeys, promptTargetKey]);
  const terminalDisplay = resolveDashboardTerminalDisplay({ focusedKey });
  const hiddenFocusedSlot = focusedKey && !focusedGridSlots.includes(focusedKey) ? focusedKey : null;
  const overviewDesktopSlots: SlotKey[] = [
    ...overviewPage.sessionKeys,
    ...Array.from<null>({
      length: Math.max(0, overviewDesktopMode - overviewPage.sessionKeys.length),
    }).fill(null),
  ];
  // Mobile shows a status-card list for the overview (MobileSessionList) and
  // mounts a terminal only for the focused session, so at most one live terminal
  // runs on a phone. Desktop keeps the full multi-slot grid.
  const renderSlots = viewport.mobile
    ? focusedKey
      ? [focusedKey]
      : []
    : hiddenFocusedSlot
      ? [...focusedGridSlots, hiddenFocusedSlot]
      : focusedKey
        ? focusedGridSlots
        : overviewDesktopSlots;
  const workspaceSlotCount = viewport.mobile
    ? 1
    : focusedKey
      ? slotCount
      : overviewDesktopMode;
  const terminalLayoutSlotCount = viewport.mobile ? 1 : overviewDesktopMode;
  const repairToastMessage = repairMessage;

  // The counts stay in the title bar while an overlay such as Usage backgrounds
  // the Dashboard; in the header row they would compact it (#962). There they
  // are inert like the rest of the backgrounded Dashboard.
  const nativeCountsTarget = typeof document !== "undefined" && isMacTauri()
    ? document.getElementById("mac-titlebar-counts") : null;
  useEffect(() => {
    if (!nativeCountsTarget) return;
    nativeCountsTarget.toggleAttribute("inert", !active);
    return () => nativeCountsTarget.removeAttribute("inert");
  }, [nativeCountsTarget, active]);
  // The single-session view keeps the list header's counts (#938): in the macOS
  // title bar, else in a strip above the session, logo first on desktop.
  const focusedStatusCounts = focusedKey === null ? null : <SessionStatusCountButtons
    counts={sessionStatusCountValues(statusCountRecords, sessionFilters, countsAvailable, roleOf)}
    activeGroup={sessionFilters.statusGroup} offlineCountMachines={headerCounts.offlineMachines}
    onToggle={group => changeSessionFilters({ ...sessionFilters, statusGroup: sessionFilters.statusGroup === group ? null : group })} />;
  const nativeNoticeTarget = typeof document !== "undefined" && isMacTauri()
    ? document.getElementById("mac-titlebar-notice") : null;
  useEffect(() => {
    if (!nativeNoticeTarget) return;
    nativeNoticeTarget.toggleAttribute("inert", !active);
    nativeNoticeTarget.setAttribute("aria-hidden", String(!active));
    return () => {
      nativeNoticeTarget.removeAttribute("inert");
      nativeNoticeTarget.removeAttribute("aria-hidden");
    };
  }, [nativeNoticeTarget, active]);
  const phoneConnectionNotice = viewport.mobile && connectionNotice ? statusNoticeElement : null;
  const focusedCountStrip = focusedStatusCounts && !nativeCountsTarget
    && (!viewport.mobile || phoneFocusCounts || phoneConnectionNotice)
    ? <>{viewport.mobile ? null : <BrandMark />}
      {!viewport.mobile || phoneFocusCounts ? focusedStatusCounts : null}
      {phoneConnectionNotice}</> : null;
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".workspace-head");
    if (!header) return;
    const update = () => updateHeaderCompaction(header);

    update();
    const ResizeObserverConstructor = window.ResizeObserver;
    const observer = typeof ResizeObserverConstructor === "function" ? new ResizeObserverConstructor(update) : null;
    for (const element of [header, header.querySelector(".brand-title"), header.querySelector(".session-status-counts"), header.querySelector(".dash-actions")]) {
      if (element) observer?.observe(element);
    }
    const MutationObserverConstructor = window.MutationObserver;
    const mutations = typeof MutationObserverConstructor === "function" ? new MutationObserverConstructor(update) : null;
    mutations?.observe(header, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <SessionRefreshContext.Provider value={sessionRefreshControl}>
    <DashboardUsageProvider enabled={operatorCapabilities.usage}>
      <div
        className={`dash workspace-shell ${active ? "" : "is-backgrounded"} ${conversationSession && viewport.width >= 1100 ? "has-conversation-dock" : ""}`}
        aria-hidden={!active ? "true" : undefined}
        inert={!active ? true : undefined}
      >
      <header className={`dash-head workspace-head ${nativeCountsTarget ? "has-native-counts" : ""}`}>
        <div className="workspace-head-start">
          <BrandTitle
            onMarkClick={() => void repairSessions()}
            markDisabled={repairingSessions || pendingRepair !== null}
            markBusy={repairingSessions}
          />
          {focusedKey === null ? (
            <SessionListNavigator
              statusCountsTarget={nativeCountsTarget}
              page={overviewPage.page ?? 1}
              pageCount={overviewPage.pageCount}
              records={overviewFilterRecords}
              countRecords={overviewCountRecords}
              offlineCountMachines={headerCounts.offlineMachines}
              countsAvailable={countsAvailable}
              workspaceChoicesComplete={permittedMachines.length > 0 && headerCounts.offlineMachines.length === 0
                && permittedMachines.every(name => headerCounts.includedMachines.has(name))}
              filters={sessionFilters}
              onChange={changeSessionFilters}
              machines={machines}
              roles={overviewRoles}
              harnesses={overviewHarnesses}
              roleOf={roleOf}
              statusNotice={connectionNotice && !nativeNoticeTarget ? statusNoticeElement : null}
              migrationNotice={hostMigrationNotice}
              onDismissMigration={onDismissHostMigration}
              resultCount={overviewFilteredSessions.length}
              statusCounts={overviewStatusCounts}
              open={mobileOverviewNavOpen}
              mobile={viewport.headerMobile}
              onOpenChange={setMobileOverviewNavOpen}
              onPageChange={changeOverviewPage}
            />
          ) : null}
          {focusedStatusCounts && nativeCountsTarget ? createPortal(focusedStatusCounts, nativeCountsTarget) : null}
          {connectionNotice && nativeNoticeTarget ? createPortal(statusNoticeElement, nativeNoticeTarget) : null}
        </div>
        {operatorCapabilities.usage ? <HeaderUsage onOpen={onUsage} /> : null}
        <div className="dash-actions">
          <div className="dash-group">
            {/* Focused terminals keep their host control; overview filters live
                together in SessionListNavigator. */}
            {focusedKey !== null && enabledMachines.length > 1 ? (
              <label className="machine-filter">
                <MachineIcon />
                <AppSelect
                  className="machine-filter-select"
                  aria-label="Filter sessions by machine"
                  value={machineFilter}
                  onChange={(e) => {
                    cancelPendingCreatedFocus();
                    setMachineFilter(e.target.value);
                    setSessionListPage(1);
                  }}
                >
                  <option value={ALL}>All machines</option>
                  {enabledMachines.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </AppSelect>
                <SelectChevronIcon />
              </label>
            ) : null}
            {/* The Android app shows the grid layout control only in Desktop (#252). */}
            {isAndroidTauri() ? null : <LayoutPicker auto={autoLayout} mode={layoutMode} displayedMode={displayedDesktopMode}
              onToggleAuto={() => setAutoLayout(current => !current)}
              onSelect={mode => { setAutoLayout(false); setLayoutMode(mode); }} />}
          </div>
          <div className="dash-group dash-create-actions">
            <HeaderMenu
              open={headerMenuOpen}
              onOpenChange={setHeaderMenuOpen}
              historyAvailable={historyMachineNames.size > 0}
              onHistory={() => setShowHistory(true)}
              usageAvailable={operatorCapabilities.usage}
              debugAvailable={operatorCapabilities.debug}
              onUsage={onUsage}
              onDebug={onDebug}
              onSettings={onSettings}
              onShell={onShell}
              onRepair={() => void repairSessions()}
              repairDisabled={repairingSessions || pendingRepair !== null}
              autoLayoutEnabled={autoLayout}
              onAutoLayout={() => setAutoLayout((current) => !current)}
              onNewSession={() => setShowCreate(true)}
              newSessionDisabled={creating
                || unknownCreateOutcomePending
                || promptRecoveryCapacityError(unsubmittedCreatePrompts, "") !== null}
            />
            <IconButton preset="standard" type="button" className="btn dashboard-new-session"
              aria-label="New session"
              title="New session"
              onClick={() => setShowCreate(true)}
              disabled={creating
                || unknownCreateOutcomePending
                || promptRecoveryCapacityError(unsubmittedCreatePrompts, "") !== null}
            >
              <PlusIcon />
            </IconButton>
            {/* The Android Desktop list keeps its layout control beside New and More (#252). */}
            {androidDesktop ? <LayoutPicker auto={autoLayout} mode={layoutMode} displayedMode={displayedDesktopMode}
              onToggleAuto={() => setAutoLayout(current => !current)}
              onSelect={mode => { setAutoLayout(false); setLayoutMode(mode); }} /> : null}
          </div>
        </div>
        {repairToastMessage ? (
          <div className="repair-toast-layer" aria-live="polite" aria-atomic="true">
            <div className={`repair-toast is-${repairToastMessage.intent}`}>
              <span>{repairToastMessage.text}</span>
              <div className="repair-toast-actions">
                {repairToastMessage.actions.includes("view_failures") ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={maintenanceIncidents.length === 0}
                    onClick={() => setMaintenanceOpenKey(maintenanceIncidents[0]?.key ?? null)}
                  >
                    View failures
                  </button>
                ) : null}
                {repairToastMessage.actions.includes("dismiss") ? (
                  <button className="btn ghost" type="button" onClick={() => setRepairMessage(null)}>
                    Dismiss
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {viewport.mobile && focusedKey && sessionsByKey.has(focusedKey) && historyMachineNames.has(sessionsByKey.get(focusedKey)!.machine) ? (
          phoneConversationMode ? (
            <button type="button" className="btn" aria-label="Switch to terminal"
              onClick={() => openPhoneTerminal(sessionsByKey.get(focusedKey)!)}>Terminal</button>
          ) : (
            <button type="button" className="btn" aria-label="Switch to conversation"
              onClick={() => openConversation(sessionsByKey.get(focusedKey)!)}>Conversation</button>
          )
        ) : null}
      </header>

      {unknownCreateOutcomePending ? (
        <p className="banner warn">Check the session list for the unknown creation outcome, then allow a new session or dismiss it.</p>
      ) : promptRecoveryCapacityError(unsubmittedCreatePrompts, "") ? (
        <p className="banner warn">Dismiss a retained prompt before creating another session.</p>
      ) : null}

      {unsubmittedCreatePrompts.map((recovery) => (
        <section
          key={recovery.key}
          className="banner warn create-prompt-recovery"
          aria-live="polite"
        >
          <p>
            {recovery.creationOutcomeUnknown && recovery.submissionOutcome === "unknown"
              ? "Session creation may have completed and may already have received this prompt. Inspect the session list before creating another session or pasting it."
              : recovery.creationOutcomeUnknown
              ? "Session creation may have completed without this prompt. Inspect the session list before creating another session."
              : recovery.submissionOutcome === "unknown"
              ? "The initial prompt may have been submitted. Inspect the exact session before retrying this retained prompt."
              : "The initial prompt was not submitted. Copy it and paste it into the created session after checking its state."}
          </p>
          <p>
            Target: {recovery.machine} / {recovery.sessionId ?? "unconfirmed session"}
          </p>
          {recovery.creationOutcomeUnknown && !recovery.acknowledged ? (
            <p>
              {recovery.reconciled
                ? "The session list has been refreshed, but a session created late may not be listed yet. If you still want another session, you can allow one; this prompt stays here until you dismiss it."
                : "Refreshing the session list before a new session can be allowed…"}
            </p>
          ) : null}
          {recovery.prompt ? (
            <textarea
              aria-label="Unsubmitted initial prompt"
              readOnly
              rows={3}
              value={recovery.prompt}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
          <div className="create-prompt-recovery-actions">
            <button
              type="button"
              className="btn"
              disabled={!recovery.prompt}
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setError("Clipboard access is unavailable; select the retained prompt and copy it manually.");
                  return;
                }
                void navigator.clipboard.writeText(recovery.prompt).catch((err: unknown) => {
                  setError(`Prompt copy failed: ${(err as Error).message}`);
                });
              }}
            >
              Copy prompt
            </button>
            {recovery.creationOutcomeUnknown && !recovery.acknowledged ? (
              <button
                type="button"
                className="btn"
                disabled={!recovery.reconciled}
                onClick={() => setUnsubmittedCreatePrompts((current) => acknowledgeUnknownCreateRecovery(current, recovery.key))}
              >
                Allow new session
              </button>
            ) : null}
            <button
              type="button"
              className="btn ghost"
              onClick={() => setUnsubmittedCreatePrompts((current) => current.filter((entry) => entry.key !== recovery.key))}
            >
              Dismiss
            </button>
          </div>
        </section>
      ))}

      {focusedKey === null && overviewFilteredSessions.length === 0 && hasActiveSessionFilters(sessionFilters) ? (
        <div className="empty session-list-empty">
          <p>No matching sessions</p>
          <button className="btn" type="button" onClick={resetSessionListFilters}>Clear all</button>
        </div>
      ) : visible.length === 0 ? (
        <p className="empty">No sessions. Tap “+ New” to start one.</p>
      ) : viewport.mobile && !focusedKey ? (
        <MobileSessionList
          sessions={overviewPageSessions}
          cardPreview={cardPreview}
          options={overviewFilteredSessions}
          editingTitleKey={editingTitleKey}
          beginTitleEdit={beginTitleEdit}
          saveTitleEdit={saveTitleEdit}
          cancelTitleEdit={cancelTitleEdit}
          onRetitle={retitleSession}
          onConversation={openConversation}
          historyMachineNames={historyMachineNames}
          onMoveSessionHere={fixedSessionOrder ? undefined : (session, selectedKey) => moveSessionHere(sessionKey(session), selectedKey)}
          onNewSession={(session) => {
            const key = sessionKey(session);
            const index = slots.indexOf(key);
            onSlotSelect(index >= 0 ? index : slots.length, key, NEW_SESSION);
          }}
          machineColors={machineColors}
          reachableMachineNames={reachableMachineNames}
          activityDeliveryByMachine={activityDeliveryByMachine}
          clockActive={active}
          resumingKey={resumingKey}
          autoResumePendingKey={autoResumePendingKey}
          accountPendingKey={accountPendingKey}
          accountsByProvider={accountsByProvider}
          inert={showCreate}
          initialScrollTop={mobileSessionListScrollTopRef.current}
          onScrollTopChange={rememberMobileSessionListScrollTop}
          onOpen={onOverviewSession}
          onResume={onResume}
          onAutoResume={onAutoResume}
          onAccount={onAccount}
          onLineageMarker={followLineageMarker}
        />
      ) : (
        <ol
          className={`session-workspace mode-${workspaceSlotCount} slots-${workspaceSlotCount} ${
            viewport.mobile ? "mobile" : "desktop"
          } ${focusedKey ? "is-focused" : ""} ${
            slotDrag.slotPointerDragIndex !== null ? "is-slot-pointer-dragging" : ""
          }`}
          inert={showCreate ? true : undefined}
          aria-hidden={showCreate ? "true" : undefined}
        >
          {renderSlots.map((slot, index) => {
            const s = slot ? sessionsByKey.get(slot) : undefined;
            const focused = Boolean(slot && focusedKey === slot);
            const gridFocusTarget = Boolean(slot && !focusedKey && !viewport.mobile && gridFocusKey === slot);
            const terminalLayoutKey = `${terminalLayoutSlotCount}:${viewport.width}x${viewport.height}`;
            const slotMenuKey = `${index}:${slot ?? "empty"}`;
            // An overview session swaps by ranking, so it needs no local slot: the
            // grid holds overview-hidden Workers, which can push a page's later
            // sessions past its end. Those use the out-of-range index.
            const overviewSlotIndex = slot !== null ? slots.indexOf(slot) : -1;
            const overviewAuthoritativeSlotIndex = focusedKey !== null
              ? -1
              : slot !== null
                ? overviewSlotIndex >= 0 ? overviewSlotIndex : slots.length
                : overviewPage.page === 1 && slots[index] === null ? index : -1;
            const focusedAuthoritativeSlotIndex = focusedKey !== null && slot !== null
              ? slots.indexOf(slot)
              : -1;
            const slotAssignmentIndex = focusedKey !== null
              ? focusedAuthoritativeSlotIndex >= 0 ? focusedAuthoritativeSlotIndex : slots.length
              : overviewAuthoritativeSlotIndex;
            // On mobile only the focused session's terminal is mounted, so every
            // other visible session is a valid swap target for its title menu.
            // The overview offers the sessions it lists that are not already on
            // this page; the focused grid offers what its own slots do not hold.
            const usedElsewhere = viewport.mobile
              ? new Set<string>()
              : focusedKey === null
                ? new Set(overviewPage.sessionKeys)
                : new Set(slots.filter((key, i): key is string => i !== slotAssignmentIndex && key !== null));
            const options = (focusedKey === null ? overviewFilteredSessions : visible).filter((candidate) => {
              const key = sessionKey(candidate);
              return key === slot || !usedElsewhere.has(key);
            });
            // The session's position in the ⌘1..⌘6 / ⌘H-⌘L ordering, shown in
            // the focused header.
            const ordinalIndex = slot ? shortcutSessionKeys.indexOf(slot) : -1;
            const sessionOrdinal = ordinalIndex >= 0 ? ordinalIndex + 1 : null;
            const retitleState = slot && retitleFeedback?.key === slot ? retitleFeedback.state : null;
            const retitleDetail = slot && retitleFeedback?.key === slot ? retitleFeedback.detail ?? null : null;
            const shortcutHint = slot && shortcutFeedback?.key === slot ? shortcutFeedback.text : null;
            return (
              <SessionSlot
                key={slot ?? `empty-${index}`}
                view={{
                  slot,
                  index,
                  session: s,
                  options,
                  machineColors,
                  focused,
                  sessionListDisplay: tileListDisplay,
                  conversationActive: active && conversationKey === null,
                  phoneConversation: Boolean(focused && viewport.mobile && phoneConversationMode && s
                    && historyMachineNames.has(s.machine)),
                  conversationReplyDrafts: conversationReplyDrafts.current,
                  connectionStatusNotice: focused && connectionNotice && !viewport.mobile && !nativeNoticeTarget ? statusNoticeElement : null,
                  focusCountStrip: focused ? focusedCountStrip : null,
                  gridFocusTarget,
                  machineReachable: s ? reachableMachineNames.has(s.machine) : true,
                  terminalStatus: slot ? terminalStatusByKey.get(slot) : undefined,
                  cmdFocusTarget: Boolean(!viewport.mobile && slot && cmdFocusTargetKey === slot),
                  focusedKey,
                  slotMenuKey,
                  editingTitleKey,
                  openSlotMenuKey,
                  resumingKey,
                  extensionCapabilities,
                  autoResumePendingKey,
                  accountPendingKey,
                  accounts: sessionAccountChoices(s, accountsByProvider),
                  copiedCommandKey,
                  copiedStartupDiagnosticsKey,
                  sessionOrdinal,
                  sessionCount: shortcutSessionKeys.length,
                  sessionNavList,
                  sessionNavGridKeys,
                  onFocusPrevious: () => { if (!phoneConversationLocked) focusAdjacentSession(-1); },
                  onFocusNext: () => { if (!phoneConversationLocked) focusAdjacentSession(1); },
                  shortcutHint,
                  retitleState,
                  retitleDetail,
                  onRetitle: retitleSession,
                  repairingSessions,
                  viewport,
                  slotAssignmentEnabled: slotAssignmentIndex >= 0,
                  slotAssignmentIndex,
                  clockActive: active,
                  activityDeliveryState: s ? activityDeliveryByMachine.get(s.machine) ?? "polling" : undefined,
                  newSessionValue: NEW_SESSION,
                }}
                drag={slotDrag}
                actions={{
                  setFocusedKey: setSlotFocusedKey,
                  setOpenSlotMenuKey,
                  rememberSessionInteraction,
                  requestPromptTargetFocus,
                  onSlotSelect,
                  onFocusSession: (key) => { if (!phoneConversationLocked) onFocusSession(key); },
                  onMoveSessionHere: fixedSessionOrder ? undefined : moveSessionHere,
                  leaveFocusedSession: () => { if (!phoneConversationLocked) leaveFocusedSession(); },
                  onResume,
                  reportExtensionError: setError,
                  onAutoResume,
                  onAccount,
                  onKill,
                  copySessionCommand,
                  copyStartupDiagnostics,
                  reviewSessionMaintenance,
                  beginTitleEdit,
                  saveTitleEdit,
                  cancelTitleEdit,
                  onConversation: s && (historyMachineNames.has(s.machine) || (!viewport.mobile && tileListDisplay === "conversation"))
                    ? openConversation : undefined,
                  onTerminal: openPhoneTerminal,
                  onConversationBusyChange: setConversationBusy,
                  onLineageMarker: (session, navigation) => { if (!phoneConversationLocked) followLineageMarker(session, navigation); },
                }}
                terminal={{
                  terminalLayoutKey,
                  terminalReadableFit: terminalDisplay.readableFit,
                  terminalRenderMode,
                  terminalSelectedPaneRealtime,
                  reconnectToken: s ? reconnectTokens[sessionKey(s)] ?? 0 : 0,
                  onReconnect: reconnectFocusedSession,
                  focusRequestToken: slot && terminalFocusRequest?.key === slot
                    ? terminalFocusRequest.token
                    : 0,
                  fontSize: terminalDisplay.fontSize,
                  rememberTerminalStatus,
                  onPromptFocus: notePromptTargetFocus,
                  noteTurnPromptSubmitted,
                  noteTurnOutput,
                }}
              />
            );
          })}
        </ol>
      )}

      {voiceOpenRequest ? (
        <SpeechComposer
          key={`${voiceOpenRequest.key}:${voiceOpenRequest.token}`}
          machine={voiceOpenRequest.machine}
          id={voiceOpenRequest.id}
          sessionIncarnation={voiceOpenRequest.sessionIncarnation}
          targetLabel={voiceOpenRequest.title}
          onBeforeOpen={() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          }}
          openRequestToken={voiceOpenRequest.token}
          showTrigger={false}
        />
      ) : null}

      {pendingRepair ? (
        <Modal
          ariaLabelledby="repair-session-title"
          androidBackEntry="repair-sessions"
          restoreFocusRef={repairOpenerRef}
          busy={repairingSessions}
          onClose={() => setPendingRepair(null)}
        >
          <h2 id="repair-session-title">Repair sessions</h2>
          <p>Check {pendingRepair.plan.checked} {pendingRepair.plan.checked === 1 ? "session" : "sessions"} matching the current filters, across all pages.</p>
          <p>Machines: {pendingRepair.machines}</p>
          <p>Repository: {pendingRepair.repository}</p>
          <p>Resume {pendingRepair.plan.resume.length} stopped {pendingRepair.plan.resume.length === 1 ? "session" : "sessions"} and reconnect {pendingRepair.plan.reconnectKeys.length} running {pendingRepair.plan.reconnectKeys.length === 1 ? "terminal" : "terminals"}.</p>
          <div className="modal-actions">
            <button className="btn ghost" type="button" disabled={repairingSessions} onClick={() => setPendingRepair(null)}>Cancel</button>
            <button className="btn" type="button" disabled={repairingSessions} onClick={() => void confirmRepairSessions()}>{repairingSessions ? "Repairing…" : "Repair sessions"}</button>
          </div>
        </Modal>
      ) : null}

      {showShortcutHelp ? <ShortcutHelpModal onClose={() => setShowShortcutHelp(false)} /> : null}

      {showCreate ? (
        <CreateDialog
          machines={enabledMachines}
          defaultMachine={defaultCreateMachine}
          machineColors={machineColors}
          agentProfilesByMachine={agentProfilesByMachine}
          accountsByProvider={accountsByProvider}
          busy={creating}
          error={createError}
          onCreate={onCreate}
          onClose={() => {
            if (creating) return;
            setShowCreate(false);
            setPendingSlot(null);
            pendingCreatePageRef.current = null;
          }}
        />
      ) : null}

      {showHistory ? (
        <HistoryPanel
          machines={enabledMachines.filter((machine) => historyMachineNames.has(machine))}
          liveSessions={sessions}
          onClose={() => setShowHistory(false)}
          onResumed={focusResumedSession}
        />
      ) : null}

      {conversationSession ? (
        <LiveConversationPanel
          key={conversationKey}
          session={conversationSession}
          docked={viewport.width >= 1100}
          showComposer={viewport.mobile}
          onTerminal={viewport.mobile ? () => openPhoneTerminal(conversationSession) : undefined}
          replyDrafts={conversationReplyDrafts.current}
          recovery={{ onRecover: () => void onResume(conversationSession),
            pending: resumingKey === sessionKey(conversationSession) || repairingSessions }}
          machineReachable={reachableMachineNames.has(conversationSession.machine)}
          onBusyChange={setConversationBusy}
          onClose={closeConversation}
          pinned={conversationPinned}
          onTogglePin={viewport.width >= 1100 ? toggleConversationPin : undefined}
        />
      ) : null}

      {closeConfirmSession ? (
        <CloseSessionDialog
          key={`${sessionKey(closeConfirmSession)}:${closeConfirmSession.session_incarnation ?? ""}`}
          session={closeConfirmSession}
          error={closeDeleteError}
          onCancel={() => {
            setCloseDeleteError(null);
            setCloseConfirmSession(null);
          }}
          onConfirmDelete={confirmCloseSessionDelete}
          onConfirmArchive={confirmCloseSessionArchive}
          archiveAvailable={archiveMachineNames.has(closeConfirmSession.machine)}
          starAvailable={historyStarMachineNames.has(closeConfirmSession.machine)}
          onReviewRecovery={() => {
            const key = `${closeConfirmSession.machine}/${closeConfirmSession.id}:delete`;
            const incident = maintenanceIncidents.find((candidate) => candidate.key === key);
            if (incident) {
              setMaintenanceOpenKey(incident.key);
            } else {
              reviewSessionMaintenance(closeConfirmSession, "delete");
            }
          }}
        />
      ) : null}

      {maintenanceOpenKey && maintenanceIncidents.length > 0 ? (
        <SessionMaintenanceDrawer
          incidents={maintenanceIncidents}
          selectedKey={maintenanceOpenKey}
          busy={maintenancePending !== null}
          pendingActionId={maintenancePending?.kind === "action"
              && maintenancePending.incidentKey === maintenanceOpenKey
            ? maintenancePending.actionId
            : null}
          onSelectedKeyChange={setMaintenanceOpenKey}
          onClose={closeMaintenanceDrawer}
          onRefresh={refreshMaintenanceIncident}
          onAction={runMaintenanceAction}
          onCopyDiagnostics={copyMaintenanceDiagnostics}
          onCopyNextPrompt={copyMaintenanceNextPrompt}
          onDismissIncident={dismissMaintenanceIncident}
        />
      ) : null}
      </div>
    </DashboardUsageProvider>
    </SessionRefreshContext.Provider>
  );
}
