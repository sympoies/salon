import { IconButton } from "./IconButton.tsx";
import { SessionModelBadge } from "./SessionModelBadge.tsx";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import type { AccountSummary } from "@agent-console/shared/api";
import { AgentBadge } from "./AgentBadge.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import { fetchRepoRemoteUrl } from "./api.ts";
import {
  isSessionResumeAvailable,
  sessionCopyAction,
  sessionLabel,
  sessionRepoLabel,
  sessionStatusLabel,
  compactRepoBadgeLines,
} from "./format.ts";
import { CloseIcon, AutoResumeIcon, OpenSessionIcon, RefreshIcon } from "./icons.tsx";
import { sessionKey, type SlotKey } from "./layout.ts";
import { InlineTitleEditor } from "./InlineTitleEditor.tsx";
import { TerminalPane, type TerminalConnectionStatus } from "./TerminalPane.tsx";
import type { ConversationReplyDrafts } from "./ConversationComposer.tsx";
import { SessionConversationPane } from "./SessionConversationPane.tsx";
import { PhoneConversationPane } from "./PhoneConversationPane.tsx";
import type { SessionListDisplay } from "./sessionListDisplay.ts";
import { machineColorRgb, resolveMachineColor, type MachineColorMap } from "./machineColors.ts";
import { SessionActivityPopover } from "./SessionActivityPopover.tsx";
import { SessionActions, SessionBadges, useUiExtensions, type SessionBadgeNavigation } from "./extensions.tsx";
import { groupNavigableSessionKeys } from "./sessionNavigator.ts";
import type { ActivityDeliveryState } from "./activityStream.ts";
import { isTauri } from "./runtime.ts";
import {
  shouldTerminalPaneAcceptInteraction,
} from "./terminalFocus.ts";
import type { TerminalRenderMode } from "./terminalRenderMode.ts";
import { openExternalTerminalUrl } from "./terminalLinks.ts";
import type { DashboardSession, Session } from "./types.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";
import { useSessionSwipe } from "./useSessionSwipe.ts";
import { useSharedClock } from "./useSharedClock.ts";
import { startupCleanupCaveat, startupFailureAction, startupStageLabel } from "./startupFailure.ts";
import { codexRuntimeFallbackMessage } from "./codexRuntimeFallback.ts";
import { SessionAccountBadge, SessionAccountQuota } from "./SessionAccountBadge.tsx";
import { useHarnessCompact } from "./harnessCompact.ts";
import { SessionMenuOption, SessionTitleMenu, useSessionMenuCompact } from "./SessionTitleMenu.tsx";
import { isSessionCardControl } from "./sessionCardInteraction.ts";
import { SessionCopyMenu } from "./SessionCopyMenu.tsx";
import { sessionCardCopyActions, type SessionCardCopyAction } from "./sessionCardCopy.ts";
import "./sessionCardRows.css";

function machineAccentStyle(machine: string | undefined, machineColors: MachineColorMap, defaults: MachineColorMap): CSSProperties | undefined {
  if (!machine) {
    return undefined;
  }
  const color = resolveMachineColor(machine, machineColors, defaults);
  return {
    "--machine-accent": color,
    "--machine-accent-rgb": machineColorRgb(color),
  } as CSSProperties;
}

export function RepoBadge({
  label,
  machine,
  machineColors,
  singleLine = false,
}: {
  readonly label: string;
  readonly machine?: string;
  readonly machineColors: MachineColorMap;
  readonly singleLine?: boolean;
}) {
  const lines = singleLine ? [label.trim() || "unknown"] : compactRepoBadgeLines(label);
  const { machineColorDefaults } = useUiExtensions();
  return (
    <span
      className={`repo-badge ${lines.length > 1 ? "split" : ""}`}
      style={machineAccentStyle(machine, machineColors, machineColorDefaults)}
      title={label}
      aria-label={label}
    >
      {lines.map((line, index) => (
        <span className="repo-badge-line" key={`${line}-${index}`}>
          {line}
        </span>
      ))}
    </span>
  );
}

function preopenBrowserRepoTab(): Window | null {
  if (typeof window === "undefined" || isTauri()) {
    return null;
  }
  const opened = window.open("about:blank", "_blank");
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      /* ignore cross-browser opener assignment failures */
    }
  }
  return opened;
}

async function openSessionRepo(session: Session, preopened: Window | null): Promise<void> {
  const url = await fetchRepoRemoteUrl(session.machine, session.cwd);
  if (!url) {
    preopened?.close();
    return;
  }
  if (preopened) {
    try {
      preopened.location.replace(url);
      return;
    } catch {
      preopened.close();
    }
  }
  void openExternalTerminalUrl(url);
}

export function RepoBadgeLink({
  label,
  session,
  machineColors,
  singleLine = false,
}: {
  readonly label: string;
  readonly session: Session;
  readonly machineColors: MachineColorMap;
  readonly singleLine?: boolean;
}) {
  if (!session.cwd?.trim()) {
    return <RepoBadge label={label} machine={session.machine} machineColors={machineColors} singleLine={singleLine} />;
  }
  const openLabel = `Open ${label} repository`;
  const open = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openSessionRepo(session, preopenBrowserRepoTab());
  };
  const keyOpen = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void openSessionRepo(session, preopenBrowserRepoTab());
  };
  return (
    <span
      className="repo-badge-link"
      role="link"
      tabIndex={0}
      title={openLabel}
      aria-label={openLabel}
      onClick={open}
      onKeyDown={keyOpen}
    >
      <RepoBadge label={label} machine={session.machine} machineColors={machineColors} singleLine={singleLine} />
    </span>
  );
}

export interface SessionPagerProps {
  readonly currentKey: string | null;
  readonly sessionOrdinal: number | null;
  readonly sessionCount: number;
  readonly sessions: readonly DashboardSession[];
  readonly gridSessionKeys?: readonly string[];
  /** Lists every session in order without grid grouping; a phone has no grid to group by. */
  readonly flat?: boolean;
  readonly shownSessionCount?: number;
  readonly totalSessionCount?: number;
  readonly contextLabel?: string;
  readonly machineColors: MachineColorMap;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onSelect: (key: string) => void;
  /** Swaps a listed session into the current position; absent while ordering is automatic. */
  readonly onMoveHere?: (key: string) => void;
}

// Shared by the global overview and focused terminal so both surfaces expose
// the same ordered previous / picker / next navigation contract.
export function SessionPager({
  currentKey,
  sessionOrdinal,
  sessionCount,
  sessions,
  gridSessionKeys = sessions.map(sessionKey),
  flat = false,
  shownSessionCount = sessionCount,
  totalSessionCount = shownSessionCount,
  contextLabel = "Session",
  machineColors,
  open,
  onOpenChange,
  onPrevious,
  onNext,
  onSelect,
  onMoveHere,
}: SessionPagerProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const groupId = useId();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissOnOutside(open, ".slot-session-nav-menu", close);
  const menuFocus = useMenuFocus({
    open,
    menuRef,
    triggerRef,
    onClose: close,
  });
  useSessionMenuCompact(menuRef, open);
  const sessionsByKey = new Map(sessions.map((session) => [sessionKey(session), session] as const));
  const sessionIndexByKey = new Map(sessions.map((session, index) => [sessionKey(session), index] as const));
  const groups = groupNavigableSessionKeys({
    filteredSessionKeys: sessions.map(sessionKey),
    gridSessionKeys,
  });
  const renderOption = (candidateKey: string) => {
    const candidate = sessionsByKey.get(candidateKey);
    if (!candidate) return null;
    return (
      <SessionMenuOption
        key={candidateKey}
        session={candidate}
        ordinal={(sessionIndexByKey.get(candidateKey) ?? 0) + 1}
        current={candidateKey === currentKey}
        machineColors={machineColors}
        onSelect={() => {
          close();
          onSelect(candidateKey);
        }}
        onMoveHere={onMoveHere ? () => {
          close();
          onMoveHere(candidateKey);
        } : undefined}
      />
    );
  };
  const promptTargetLabel = sessionOrdinal === null
    ? `No ${contextLabel.toLowerCase()} selected. ${sessionCount} sessions available.`
    : `${contextLabel} ${sessionOrdinal} of ${sessionCount}`;

  return (
    <span className="slot-session-nav-menu">
      <span className="slot-session-nav" aria-label={promptTargetLabel}>
        <IconButton preset="compact"
          className="slot-session-nav-button"
          type="button"
          aria-label="Previous session"
          title="Previous session"
          onClick={(event) => {
            event.stopPropagation();
            close();
            onPrevious();
          }}
        >
          <span className="slot-session-nav-icon" aria-hidden="true">
            ‹
          </span>
        </IconButton>
        <button
          ref={triggerRef}
          className="control-trigger slot-ordinal slot-ordinal-trigger"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${promptTargetLabel}. Choose a session.`}
          title="Choose a session"
          onClick={(event) => {
            event.stopPropagation();
            onOpenChange(!open);
          }}
        >
          {sessionOrdinal ?? "–"} / {sessionCount}
        </button>
        <IconButton preset="compact"
          className="slot-session-nav-button"
          type="button"
          aria-label="Next session"
          title="Next session"
          onClick={(event) => {
            event.stopPropagation();
            close();
            onNext();
          }}
        >
          <span className="slot-session-nav-icon" aria-hidden="true">
            ›
          </span>
        </IconButton>
        {shownSessionCount < totalSessionCount ? (
          <span
            className="slot-session-nav-summary"
            aria-label={`${shownSessionCount} sessions shown out of ${totalSessionCount} total`}
          >
            {shownSessionCount} shown · {totalSessionCount} total
          </span>
        ) : null}
      </span>
      {open ? (
        <div ref={menuRef} className="slot-session-nav-dropdown" role="menu" onKeyDown={menuFocus.onKeyDown}>
          {flat ? sessions.map(sessionKey).map(renderOption) : groups.map((group) => {
            const labelId = `${groupId}-${group.label === "In grid" ? "grid" : "more"}`;
            return (
              <div className="slot-session-nav-group" role="group" aria-labelledby={labelId} key={group.label}>
                <div className="slot-session-nav-group-label" id={labelId}>{group.label}</div>
                {group.sessionKeys.map(renderOption)}
              </div>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

interface SessionSlotView {
  readonly slot: SlotKey;
  readonly index: number;
  readonly session: DashboardSession | undefined;
  readonly options: readonly Session[];
  readonly machineColors: MachineColorMap;
  readonly focused: boolean;
  readonly sessionListDisplay?: SessionListDisplay;
  readonly conversationActive?: boolean;
  /** A focused phone session shows its Conversation instead of the terminal. */
  readonly phoneConversation?: boolean;
  readonly conversationReplyDrafts?: ConversationReplyDrafts;
  readonly connectionStatusNotice?: ReactNode;
  /** The focused session's status count strip on Web and phones (#938). */
  readonly focusCountStrip?: ReactNode;
  readonly gridFocusTarget?: boolean;
  readonly machineReachable: boolean;
  readonly terminalStatus?: TerminalConnectionStatus;
  readonly cmdFocusTarget: boolean;
  readonly focusedKey: string | null;
  readonly slotMenuKey: string;
  readonly editingTitleKey: string | null;
  readonly openSlotMenuKey: string | null;
  readonly resumingKey: string | null;
  readonly extensionCapabilities?: Readonly<Record<string, unknown>>;
  readonly autoResumePendingKey: string | null;
  readonly accountPendingKey: string | null;
  /** The session's machine accounts for its provider; empty where the machine serves no switch. */
  readonly accounts: readonly AccountSummary[];
  readonly copiedCommandKey: string | null;
  readonly copiedStartupDiagnosticsKey: string | null;
  // Position in the ⌘1..⌘6 / ⌘H-⌘L ordering (1-based), shown in the focused header.
  readonly sessionOrdinal: number | null;
  readonly sessionCount: number;
  // Every focusable session in the ⌘H-⌘L order, so the focused header's ordinal
  // can drop down into a direct picker instead of only stepping prev/next.
  readonly sessionNavList: readonly DashboardSession[];
  readonly sessionNavGridKeys?: readonly string[];
  readonly onFocusPrevious: () => void;
  readonly onFocusNext: () => void;
  readonly shortcutHint: string | null;
  // Transient manual-retitle progress for this slot's session (null = idle).
  readonly retitleState: "working" | "updated" | "failed" | "updating" | "committed" | "unchanged" | "degraded_cached" | "terminal_failure" | null;
  // Why a retitle failed, in the daemon's own bounded vocabulary.
  readonly retitleDetail: string | null;
  readonly onRetitle: (session: Session) => void;
  readonly repairingSessions: boolean;
  readonly viewport: { readonly mobile: boolean };
  /** Slot replacement belongs to the authoritative fixed layout, not a filtered overview page. */
  readonly slotAssignmentEnabled?: boolean;
  /** Authoritative fixed-layout index; the paginated overview may render this session elsewhere. */
  readonly slotAssignmentIndex?: number;
  readonly clockActive: boolean;
  readonly now?: number;
  readonly activityDeliveryState?: ActivityDeliveryState;
  readonly newSessionValue: string;
}

interface SessionSlotDrag {
  readonly slotNativeDragEnabled: boolean;
  readonly slotPointerDragIndex: number | null;
  readonly slotPointerTargetIndex: number | null;
  readonly handleSlotDragOver: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly handleSlotDrop: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly beginSlotPointerDrag: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
  readonly suppressSlotPointerClick: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly handleSlotDragStart: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly handleSlotDragEnd: () => void;
}

interface SessionSlotActions {
  readonly setFocusedKey: Dispatch<SetStateAction<string | null>>;
  readonly setOpenSlotMenuKey: Dispatch<SetStateAction<string | null>>;
  readonly rememberSessionInteraction: (key: string) => void;
  readonly requestPromptTargetFocus: (key: string) => void;
  readonly onSlotSelect: (index: number, currentKey: SlotKey, value: string) => void;
  // Focus (navigate to) an existing session by key, matching the ⌘H/⌘L pager.
  readonly onFocusSession: (key: string) => void;
  /** Swaps `key` into `currentKey`'s ranked position; absent while ordering is automatic. */
  readonly onMoveSessionHere?: (currentKey: string, key: string) => void;
  readonly leaveFocusedSession: () => void;
  readonly onResume: (session: Session) => Promise<void>;
  readonly reportExtensionError?: (message: string | null) => void;
  readonly onAutoResume: (session: Session, enabled: boolean) => Promise<boolean>;
  readonly onAccount: (session: Session, account: string) => Promise<void>;
  readonly onKill: (session: Session) => Promise<void>;
  readonly copySessionCommand: (session: Session, action?: SessionCardCopyAction) => Promise<boolean>;
  readonly copyStartupDiagnostics: (session: Session) => Promise<void>;
  readonly reviewSessionMaintenance: (session: Session, operation: "resume") => void;
  readonly beginTitleEdit: (session: Session) => void;
  readonly saveTitleEdit: (session: Session, nextTitle: string | null) => Promise<void>;
  readonly cancelTitleEdit: () => void;
  /** Open the full conversation panel for this session. */
  readonly onConversation?: (session: Session) => void;
  /** Return a phone Conversation to the session's terminal. */
  readonly onTerminal?: (session: Session) => void;
  readonly onConversationBusyChange?: (busy: boolean) => void;
  /** Follow this session's lineage marker. */
  readonly onLineageMarker?: (session: Session, navigation?: SessionBadgeNavigation) => void;
}

interface SessionSlotTerminal {
  readonly terminalLayoutKey: string;
  readonly terminalReadableFit: boolean;
  readonly terminalRenderMode: TerminalRenderMode;
  readonly terminalSelectedPaneRealtime: boolean;
  readonly reconnectToken: number;
  // Rebuild the focused pane's terminal. Scoped to the session on screen — the
  // brand mark's repair sweep resumes every visible session, which is the wrong
  // blast radius for an in-session control.
  readonly onReconnect: () => void;
  readonly focusRequestToken: number;
  readonly fontSize: number;
  readonly rememberTerminalStatus: (key: string, status: TerminalConnectionStatus) => void;
  readonly onPromptFocus: (key: string) => void;
  readonly noteTurnPromptSubmitted: (
    session: Session,
    prompt: string,
    eventId?: string,
    submittedAt?: string,
  ) => void;
  readonly noteTurnOutput: (session: Session) => void;
}

export interface SessionSlotProps {
  readonly view: SessionSlotView;
  readonly drag: SessionSlotDrag;
  readonly actions: SessionSlotActions;
  readonly terminal: SessionSlotTerminal;
}

export function SessionSlot({
  view,
  drag,
  actions,
  terminal,
}: SessionSlotProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const { copyFormats } = useUiExtensions();
  const {
    slot,
    index,
    session,
    options,
    machineColors,
    focused,
    sessionListDisplay = "terminal",
    conversationActive = true,
    phoneConversation = false,
    conversationReplyDrafts,
    connectionStatusNotice,
    focusCountStrip,
    gridFocusTarget = false,
    machineReachable,
    terminalStatus,
    cmdFocusTarget,
    focusedKey,
    slotMenuKey,
    editingTitleKey,
    openSlotMenuKey,
    resumingKey,
    extensionCapabilities = {},
    autoResumePendingKey,
    accountPendingKey,
    accounts,
    copiedCommandKey,
    copiedStartupDiagnosticsKey,
    sessionOrdinal,
    sessionCount,
    sessionNavList,
    sessionNavGridKeys = sessionNavList.map(sessionKey),
    onFocusPrevious,
    onFocusNext,
    shortcutHint,
    retitleState,
    retitleDetail,
    onRetitle,
    repairingSessions,
    activityDeliveryState,
    viewport,
    slotAssignmentEnabled = true,
    slotAssignmentIndex = index,
    clockActive,
    now,
    newSessionValue,
  } = view;
  const {
    slotNativeDragEnabled,
    slotPointerDragIndex,
    slotPointerTargetIndex,
    handleSlotDragOver,
    handleSlotDrop,
    beginSlotPointerDrag,
    suppressSlotPointerClick,
    handleSlotDragStart,
    handleSlotDragEnd,
  } = drag;
  const {
    setFocusedKey,
    setOpenSlotMenuKey,
    rememberSessionInteraction,
    requestPromptTargetFocus,
    onSlotSelect,
    onFocusSession,
    onMoveSessionHere,
    leaveFocusedSession,
    onResume,
    reportExtensionError,
    onAutoResume,
    onAccount,
    onKill,
    copySessionCommand,
    copyStartupDiagnostics,
    reviewSessionMaintenance,
    beginTitleEdit,
    saveTitleEdit,
    cancelTitleEdit,
    onConversation,
    onTerminal,
    onConversationBusyChange,
    onLineageMarker,
  } = actions;
  const {
    terminalLayoutKey,
    terminalReadableFit,
    terminalRenderMode,
    terminalSelectedPaneRealtime,
    reconnectToken,
    onReconnect,
    focusRequestToken,
    fontSize,
    rememberTerminalStatus,
    onPromptFocus,
    noteTurnPromptSubmitted,
    noteTurnOutput,
  } = terminal;
  const s = session;
  const mobileFocused = Boolean(s && focused && viewport.mobile);
  const showPhoneConversation = mobileFocused && phoneConversation;
  const conversationRefreshRef = useRef<(() => void) | null>(null);
  const conversationTile = !viewport.mobile && !focused && sessionListDisplay === "conversation";
  // A running focused session swipes via the terminal touch bridge (TerminalPane's
  // onSessionSwipe). A non-running session renders slot-session-state with no
  // terminal, so it carries its own swipe handlers to keep the same left/right
  // session navigation working (e.g. on a stopped session's status screen).
  const sessionSwipeHandlers = useSessionSwipe(
    mobileFocused && sessionCount > 1,
    (direction) => (direction === "previous" ? onFocusPrevious() : onFocusNext()),
  );
  const resumeAvailable = s ? isSessionResumeAvailable(s) : false;
  // The conversation view recovers a stopped session through the same resume (#921).
  const conversationRecovery = s ? { onRecover: () => void onResume(s), pending: resumingKey === sessionKey(s) || repairingSessions } : undefined;
  const statusLabel = s ? sessionStatusLabel(s) : "";
  const copyAction = s ? sessionCopyAction(s) : null;
  const copyActions = s ? sessionCardCopyActions(s, copyFormats) : [];
  const copiedCommand = s ? copiedCommandKey === sessionKey(s) : false;
  const copiedStartupDiagnostics = s ? copiedStartupDiagnosticsKey === sessionKey(s) : false;
  const startupFailure = s?.startup?.state === "failed" ? s.startup : null;
  const runtimeFallbackNotice = s?.agent === "codex" && s.startup?.runtime_fallback ? (
    <p className="hint startup-runtime-fallback" role="status" style={{ margin: 0, padding: "0.5rem", flexShrink: 0 }}>
      {codexRuntimeFallbackMessage(s.startup.runtime_fallback)}
    </p>
  ) : null;
  const open = openSlotMenuKey === slotMenuKey;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeSlotMenu = useCallback(() => setOpenSlotMenuKey(null), [setOpenSlotMenuKey]);
  useDismissOnOutside(open && !s, ".slot-title-menu", closeSlotMenu);
  const menuFocus = useMenuFocus({ open: open && !s, menuRef, triggerRef, onClose: closeSlotMenu });
  // The empty-slot menu's rows carry harness segments too.
  useSessionMenuCompact(menuRef, open && !s);
  // The focused-header ordinal opens its own picker menu. Reuse the one-open-at-a-time
  // openSlotMenuKey with a distinct suffix so opening it closes the title menu and
  // vice versa, but keep separate refs/dismiss scope for its own dropdown.
  const navMenuKey = `${slotMenuKey}:nav`;
  const navOpen = openSlotMenuKey === navMenuKey;
  const terminalInteractive = shouldTerminalPaneAcceptInteraction({
    focused,
    mobile: viewport.mobile,
  });
  // The focused header drops its harness items in the harnessCompact.ts order.
  // On a phone, row 2 stays one line (#882): the model
  // name truncates first, then items drop until effort and usage fit the badge.
  const headRef = useRef<HTMLDivElement | null>(null);
  useHarnessCompact(headRef, Boolean(s && focused), (head) => {
    const target = head.querySelector<HTMLElement>(":scope > .slot-session-details");
    const badge = target?.querySelector<HTMLElement>(":scope > .session-model-badge");
    if (viewport.mobile) {
      return target && badge ? [{
        target,
        row: badge,
        title: badge.querySelector<HTMLElement>(":scope > .session-model-name"),
        minTitlePx: PHONE_HEADER_MIN_MODEL_PX,
      }] : [];
    }
    return target ? [{
      target,
      row: head,
      title: head.querySelector<HTMLElement>(":scope > .slot-session-details > .slot-title-row > .slot-title-menu, :scope > .slot-session-details > .slot-title-edit"),
      minTitlePx: FOCUSED_HEADER_MIN_TITLE_PX,
    }] : [];
  });
  const slotHeadClassName = [
    "slot-head",
    slotPointerDragIndex === index ? "is-slot-dragging" : "",
    copyAction ? "has-copy-command" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const agentRetitleButton = s ? (
    <IconButton preset="compact"
      className="agent-retitle-button"
      type="button"
      aria-label={`Retitle ${sessionLabel(s)}`}
      title={`Retitle ${sessionLabel(s)}`}
      onClick={(e) => {
        e.stopPropagation();
        onRetitle(s);
      }}
    >
      <AgentBadge agent={s.agent} decorative />
    </IconButton>
  ) : null;
  const openButton = s && s.status === "running" ? (
    <IconButton preset="compact"
      className="slot-action slot-open"
      type="button"
      aria-label={`Open ${sessionLabel(s)}`}
      title="Open session"
      onClick={(e) => {
        e.stopPropagation();
        if (slot) {
          setFocusedKey(slot);
        }
      }}
    >
      <OpenSessionIcon />
    </IconButton>
  ) : null;
  const titleControlFor = (withAgent: boolean) =>
    s && editingTitleKey === slot ? (
      <div className="slot-title-edit" onClick={(e) => e.stopPropagation()}>
        {withAgent ? agentRetitleButton : null}
        <RepoBadgeLink label={sessionRepoLabel(s)} session={s} machineColors={machineColors} />
        <InlineTitleEditor
          initialValue={s.title ?? ""}
          formClassName="slot-title-form"
          inputClassName="slot-title-input"
          onSave={(nextTitle) => void saveTitleEdit(s, nextTitle)}
          onCancel={cancelTitleEdit}
          stopClickPropagation
        />
      </div>
    ) : s ? (
      <div className="slot-title-row">
        {withAgent ? agentRetitleButton : null}
        <RepoBadgeLink label={sessionRepoLabel(s)} session={s} machineColors={machineColors} />
        <SessionBadges item={s} surface="card" onLineage={onLineageMarker ? navigation => onLineageMarker(s, navigation) : undefined} />
        <SessionTitleMenu
          session={s} machineColors={machineColors} accounts={accounts}
          accountPendingKey={accountPendingKey} currentKey={slot} open={open}
          onOpenChange={(next) => setOpenSlotMenuKey(next ? slotMenuKey : null)}
          beginTitleEdit={beginTitleEdit} onAccount={onAccount}
          onConversation={showPhoneConversation ? undefined : onConversation}
          onTerminal={showPhoneConversation ? onTerminal : undefined}
          // A session's menu navigates in the shared sort order and never
          // reassigns a slot or the ranking; Move here is the explicit swap
          // (#870).
          options={sessionNavList} ordered
          selectionEnabled={focused || slotAssignmentEnabled}
          onSelect={(key) => focused ? onFocusSession(key) : onSlotSelect(slotAssignmentIndex, slot, key)}
          onMoveHere={onMoveSessionHere && slot ? (key) => onMoveSessionHere(slot, key) : undefined}
          onNewSession={() => onSlotSelect(slotAssignmentIndex, slot, newSessionValue)}
        />
      </div>
    ) : (
      <details
        className="slot-title-menu"
        open={open}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
      >
        <summary
          ref={triggerRef}
          className="control-trigger slot-title"
          aria-label={s ? `Session menu for ${sessionLabel(s)}` : `Session menu for slot ${index + 1}`}
          title={s ? "Open session menu" : "Open slot menu"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpenSlotMenuKey((current) => (current === slotMenuKey ? null : slotMenuKey));
          }}
        >
          <span className="slot-title-label">{`Slot ${index + 1}`}</span>
        </summary>
        <div ref={menuRef} className="slot-title-dropdown" role="menu" onKeyDown={menuFocus.onKeyDown}>
          {slotAssignmentEnabled && open ? options.map((candidate) => {
            const key = sessionKey(candidate);
            return (
              <SessionMenuOption
                key={key}
                session={candidate}
                current={key === slot}
                machineColors={machineColors}
                onSelect={() => {
                  closeSlotMenu();
                  onSlotSelect(slotAssignmentIndex, slot, key);
                }}
              />
            );
          }) : null}
          {slotAssignmentEnabled && options.length > 0 ? <div className="slot-menu-divider" role="separator" /> : null}
          <button
            className="control-menu slot-menu-item"
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              closeSlotMenu();
              onSlotSelect(slotAssignmentIndex, slot, newSessionValue);
            }}
          >
            <span className="slot-menu-label">+ New session...</span>
          </button>
        </div>
      </details>
    );

  const autoResumeBadge = s ? (
    <AutoResumeBadge
      session={s}
      clockActive={clockActive}
      now={now}
      pending={autoResumePendingKey === sessionKey(s)}
      onToggle={(enabled) => onAutoResume(s, enabled)}
    />
  ) : null;
  const activityBadge = s ? (
    <SessionActivityPopover
      session={s}
      machineReachable={machineReachable}
      focused={focused}
      terminalStatus={terminalStatus}
      clockActive={clockActive}
      nowMs={now}
      activityDeliveryState={activityDeliveryState}
      onOpenChange={setActivityOpen}
    />
  ) : null;
  const closeButton = s ? (
    <IconButton preset="compact"
      className="slot-action danger"
      type="button"
      aria-label={`Kill ${sessionLabel(s)}`}
      onClick={() => void onKill(s)}
    >
      <CloseIcon />
    </IconButton>
  ) : null;
  const headerFeedback = s ? (
    <>
      {retitleState ? (
        <span className={`retitle-feedback ${retitleState}`} role="status" title={retitleDetail ?? undefined}>
          {retitleState === "working" || retitleState === "updating"
            ? "Retitling…"
            : retitleState === "updated" || retitleState === "committed"
              ? "Title updated"
              : retitleState === "unchanged"
                ? "No change"
                : retitleState === "degraded_cached"
                  ? "Cached title kept"
                  : "Retitle failed"}
        </span>
      ) : null}
      {shortcutHint ? (
        <span className="retitle-feedback unchanged" role="status">
          {shortcutHint}
        </span>
      ) : null}
    </>
  ) : null;
  const resumeButton = s && resumeAvailable ? (
    <AsyncButton
      className="slot-action slot-resume"
      type="button"
      aria-label={`Recover ${sessionLabel(s)}`}
      pending={resumingKey === sessionKey(s)}
      disabled={repairingSessions}
      onClick={(e) => {
        e.stopPropagation();
        void onResume(s);
      }}
    >
      Recover
    </AsyncButton>
  ) : null;
  // Reconnecting was keyboard-only (⌘R via useDashboardKeyboard), so a phone had
  // no way to rebuild a pane whose render had gone stale. Same action, given a
  // touch target.
  const refreshButton = s && focused ? (
    <IconButton preset="compact"
      className="slot-action slot-refresh"
      type="button"
      aria-label={showPhoneConversation ? "Refresh conversation" : `Refresh ${sessionLabel(s)}`}
      title={showPhoneConversation ? "Refresh conversation" : "Refresh terminal"}
      onClick={(e) => {
        e.stopPropagation();
        if (showPhoneConversation) conversationRefreshRef.current?.();
        else onReconnect();
      }}
    >
      <RefreshIcon />
    </IconButton>
  ) : null;
  const copyButton = s && copyActions.length ? (
    <SessionCopyMenu actions={copyActions} mobile={viewport.mobile} copied={copiedCommand}
      open={openSlotMenuKey === `${slotMenuKey}:copy`}
      onOpenChange={(open) => setOpenSlotMenuKey(open ? `${slotMenuKey}:copy` : null)}
      ariaLabel={`${copyAction ? copyAction.kind === "command" ? "Copy session command" : "Copy provider session ID" : copyActions[0]!.label} for ${sessionLabel(s)}`}
      title={copyAction ? copyAction.kind === "command" ? "Copy session command" : "Copy provider session ID" : copyActions[0]!.label}
      onCopy={(action) => copySessionCommand(s, action)} />
  ) : null;

  const sessionPager = slot && sessionOrdinal && sessionCount > 1 ? (
    <SessionPager
      currentKey={slot}
      sessionOrdinal={sessionOrdinal}
      sessionCount={sessionCount}
      sessions={sessionNavList}
      gridSessionKeys={sessionNavGridKeys}
      flat={viewport.mobile}
      machineColors={machineColors}
      onMoveHere={onMoveSessionHere ? (key) => onMoveSessionHere(slot, key) : undefined}
      open={navOpen}
      onOpenChange={(nextOpen) => setOpenSlotMenuKey(nextOpen ? navMenuKey : null)}
      onPrevious={onFocusPrevious}
      onNext={onFocusNext}
      onSelect={onFocusSession}
    />
  ) : null;
  return (
    <li
      className={`terminal-slot ${focused ? "is-focused" : ""} ${gridFocusTarget ? "is-grid-focus" : ""} ${cmdFocusTarget ? "is-cmd-focus-target" : ""} ${
        slotPointerTargetIndex === index ? "is-slot-drop-target" : ""
      }`}
      data-slot-key={slot ?? undefined}
      data-slot-index={String(index)}
      onFocusCapture={() => {
        if (conversationTile && slot && s) onPromptFocus(slot);
      }}
      onPointerDownCapture={(event) => {
        if (event.button === 0 && slot && s) {
          rememberSessionInteraction(slot);
          if (conversationTile) onPromptFocus(slot);
        }
      }}
      onDoubleClick={(event) => {
        if (!slot || !s || isSessionCardControl(event.target)) {
          return;
        }
        event.preventDefault();
        setOpenSlotMenuKey(null);
        rememberSessionInteraction(slot);
        if (conversationTile) onConversation?.(s);
        else setFocusedKey((current) => (current === slot ? null : current === null ? slot : current));
      }}
      onDragOver={(event) => handleSlotDragOver(event, index)}
      onDrop={(event) => handleSlotDrop(event, index)}
    >
      {/* Its own row, so the counts never take width from the title, quota or model. */}
      {focused && focusCountStrip ? <div className="slot-focus-strip">{focusCountStrip}</div> : null}
      <div
        ref={headRef}
        className={slotHeadClassName}
        onDoubleClick={(event) => event.stopPropagation()}
        draggable={slotNativeDragEnabled && !activityOpen}
        onPointerDown={(event) => beginSlotPointerDrag(event, index)}
        onClickCapture={suppressSlotPointerClick}
        onDragStart={(event) => handleSlotDragStart(event, index)}
        onDragEnd={handleSlotDragEnd}
      >
        {s && focused ? (
          <div className={mobileFocused ? "slot-focus-toolbar slot-focus-row-one" : "slot-focus-toolbar"}>
            <button
              className="slot-action slot-back"
              type="button"
              aria-label="Back to session list"
              onClick={(e) => {
                e.stopPropagation();
                leaveFocusedSession();
              }}
            >
              <span className="slot-back-icon" aria-hidden="true">‹</span>
              <span className="slot-back-label">Back</span>
            </button>
            {mobileFocused ? (
              <>
                {/* A phone header uses the card rows: identity here, harness below. */}
                {titleControlFor(false)}
                <span className="slot-focus-actions">
                  {resumeButton}
                  {refreshButton}
                  {copyButton}
                  {closeButton}
                </span>
              </>
            ) : sessionPager}
          </div>
        ) : null}
        <div className={mobileFocused ? "slot-session-details slot-focus-row-two" : "slot-session-details"}>
          {s && mobileFocused ? (
            <>
              {headerFeedback}
              {agentRetitleButton}
              <SessionAccountBadge
                session={s}
                accounts={accounts}
                pending={accountPendingKey === sessionKey(s)}
                onAccount={onAccount}
                clockActive={clockActive}
                now={now}
              />
              <SessionModelBadge session={s} />
              <span className="slot-focus-status">
                {autoResumeBadge}
                {activityBadge}
              </span>
              {sessionPager}
            </>
          ) : !focused && (s || !viewport.mobile) ? (
            <div className="slot-session-card-header">
              <div className="slot-session-card-row-one">
                {titleControlFor(false)}
                {copyButton}
                {openButton}
                {closeButton}
              </div>
              <div className="slot-session-card-row-two">
                {agentRetitleButton}
                {s ? <SessionAccountBadge
                  session={s}
                  accounts={accounts}
                  pending={accountPendingKey === sessionKey(s)}
                  onAccount={onAccount}
                  clockActive={clockActive}
                  now={now}
                /> : null}
                {s ? <SessionModelBadge session={s} /> : null}
                {autoResumeBadge}
                {activityBadge}
                {refreshButton}
                {headerFeedback}
                {resumeButton}
              </div>
            </div>
          ) : (
            <>
              {headerFeedback}
              {resumeButton}
              {titleControlFor(false)}
              {agentRetitleButton}
              {s ? (
                <SessionAccountBadge
                  session={s}
                  accounts={accounts}
                  pending={accountPendingKey === sessionKey(s)}
                  onAccount={onAccount}
                  clockActive={clockActive}
                  now={now}
                />
              ) : null}
              {s && focused ? <SessionAccountQuota session={s} clockActive={clockActive} now={now} /> : null}
              {s ? <SessionModelBadge session={s} /> : null}
              {autoResumeBadge}
              {activityBadge}
              {refreshButton}
              {copyButton}
              {!focused ? openButton : null}
              {closeButton}
            </>
          )}
        </div>
        {focused && connectionStatusNotice ? <div className="slot-connection-row">{connectionStatusNotice}</div> : null}
      </div>


      {s ? (
        showPhoneConversation ? (
          <PhoneConversationPane key={`${sessionKey(s)}:${s.provider_resume?.session_id ?? ""}`}
            session={s} machineReachable={machineReachable} replyDrafts={conversationReplyDrafts} recovery={conversationRecovery}
            onTerminal={onTerminal ? () => onTerminal(s) : undefined} swipeEnabled={sessionCount > 1}
            onSwipe={(direction) => (direction === "previous" ? onFocusPrevious() : onFocusNext())}
            onBusyChange={onConversationBusyChange} refreshRef={conversationRefreshRef} />
        ) : conversationTile ? (
          <SessionConversationPane key={`${sessionKey(s)}:${s.provider_resume?.session_id ?? ""}`}
            session={s} machineReachable={machineReachable} active={conversationActive} replyDrafts={conversationReplyDrafts}
            recovery={conversationRecovery} />
        ) : s.status === "running" ? (
          <>
          {runtimeFallbackNotice}
          <div
            className="slot-terminal-wrap"
            onPointerDownCapture={(event) => {
              if (event.button === 0 && !viewport.mobile && !focused && slot) {
                requestPromptTargetFocus(slot);
              }
            }}
            onClickCapture={() => {
              if (viewport.mobile && slot && !focusedKey) {
                setFocusedKey(slot);
              }
            }}
          >
            <TerminalPane
              key={slot}
              machine={s.machine}
              id={s.id}
              sessionIncarnation={s.session_incarnation}
              agent={s.agent}
              autoFocus={focused || gridFocusTarget || cmdFocusTarget}
              fontSize={fontSize}
              interactive={terminalInteractive}
              readableFit={terminalReadableFit}
              realtimeOutput={focused || (terminalSelectedPaneRealtime && cmdFocusTarget)}
              renderMode={terminalRenderMode}
              showKeyBar={focused}
              layoutSyncKey={terminalLayoutKey}
              reconnectToken={reconnectToken}
              focusRequestToken={focusRequestToken}
              machineReachable={machineReachable}
              onPromptFocus={() => slot && onPromptFocus(slot)}
              onStatusChange={(status) => rememberTerminalStatus(sessionKey(s), status)}
              onTurnPromptSubmit={(prompt, eventId, submittedAt) => (
                noteTurnPromptSubmitted(s, prompt, eventId, submittedAt)
              )}
              onTurnOutput={() => noteTurnOutput(s)}
              onSessionSwipe={focused && viewport.mobile && sessionCount > 1
                ? (direction) => direction === "previous" ? onFocusPrevious() : onFocusNext()
                : undefined}
              onRetitle={() => onRetitle(s)}
            />
          </div>
          </>
        ) : (
          <div className="slot-session-state" {...(sessionSwipeHandlers ?? {})}>
            <span className={`status ${statusLabel}`}>{statusLabel}</span>
            {!startupFailure ? runtimeFallbackNotice : null}
            {startupFailure ? (
              <section className="startup-failure-panel" aria-labelledby={`startup-failure-${s.machine}-${s.id}`}>
                <h3 id={`startup-failure-${s.machine}-${s.id}`}>Session failed to start</h3>
                <p className="startup-failure-message">{startupFailure.message}</p>
                {runtimeFallbackNotice}
                <p className="startup-failure-meta" data-startup-stage={startupFailure.stage}>
                  {startupStageLabel(startupFailure.stage)} · {" "}
                  <time dateTime={startupFailure.occurred_at}>{startupFailure.occurred_at}</time>
                </p>
                <p className="startup-failure-action-copy">
                  {startupFailureAction(startupFailure.failure_code)}
                </p>
                {startupCleanupCaveat(startupFailure.cleanup) ? (
                  <p className="startup-failure-cleanup" data-cleanup-state={startupFailure.cleanup?.state}>
                    {startupCleanupCaveat(startupFailure.cleanup)}
                  </p>
                ) : null}
                <SessionActions session={s} context={{ capabilities: extensionCapabilities, disabled: repairingSessions,
                  resumeAvailable, resume: () => onResume(s), reportError: message => reportExtensionError?.(message) }}>
                {startupFailure.retry_safe && resumeAvailable ? (
                  <AsyncButton
                    className="btn primary startup-failure-action"
                    type="button"
                    pending={resumingKey === sessionKey(s)}
                    disabled={repairingSessions}
                    onClick={() => onResume(s)}
                  >
                    Retry
                  </AsyncButton>
                ) : (
                  <button
                    className="btn startup-failure-action"
                    type="button"
                    onClick={() => void copyStartupDiagnostics(s)}
                  >
                    {copiedStartupDiagnostics ? "Diagnostics copied" : "Copy diagnostics"}
                  </button>
                )}
                </SessionActions>
                <button
                  className="btn ghost startup-failure-action"
                  type="button"
                  onClick={() => reviewSessionMaintenance(s, "resume")}
                >
                  Review recovery
                </button>
              </section>
            ) : resumeAvailable ? (
              <AsyncButton
                className="btn primary"
                type="button"
                pending={resumingKey === sessionKey(s)}
                disabled={repairingSessions}
                onClick={() => onResume(s)}
              >
                Recover
              </AsyncButton>
            ) : s.resume_blocked_reason ? (
              <p className="hint" role="status">
                {resumeBlockedReasonLabel(s.resume_blocked_reason)}
              </p>
            ) : null}
          </div>
        )
      ) : (
        <div className="slot-empty">Select a session</div>
      )}
    </li>
  );
}

function resumeBlockedReasonLabel(reason: string): string {
  if (reason === "agent-profile-unavailable") {
    return "Recovery unavailable: the launch profile is no longer ready.";
  }
  if (reason === "agent-profile-metadata-unavailable") {
    return "Recovery unavailable: this session predates managed profile metadata.";
  }
  return "Recovery unavailable: the launch profile configuration changed.";
}

// Resting auto-resume states render as a glyph-only badge: they linger on the
// title row indefinitely, so the persistent text is dropped and the full label
// stays in title/aria. Colour carries the coarse signal — accent for active
// (enabled/armed/checking), muted for inactive (disabled/unavailable/cancelled),
// green for a completed resume (resumed) — while the precise state lives in
// title/aria. Only states with live, must-read detail keep visible text:
// `scheduled` (countdown) and the failure states (retrying/failed/unknown-active,
// warn-coloured) so a problem stays loud. This set is keyed on `visualState`
// (which includes the synthetic `unknown-active` and remaps unknown/failed
// cases to `unavailable`), NOT on the raw `status.state`; keep it in sync with
// the visualState values below. A state left out here silently falls back to
// text mode.
// The focused title keeps this much width before the header drops a harness item.
const FOCUSED_HEADER_MIN_TITLE_PX = 160;
const PHONE_HEADER_MIN_MODEL_PX = 40;

const AUTO_RESUME_ICON_ONLY_STATES: ReadonlySet<string> = new Set([
  "enabled",
  "armed",
  "disabled",
  "unavailable",
  "cancelled",
  "resumed",
  "checking",
]);

export function AutoResumeBadge({
  session,
  clockActive,
  now,
  pending = false,
  onToggle,
}: {
  readonly session: Session;
  readonly clockActive: boolean;
  readonly now?: number;
  readonly pending?: boolean;
  readonly onToggle?: (enabled: boolean) => Promise<boolean>;
}) {
  const descriptionId = useId();
  const [announcement, setAnnouncement] = useState({ message: "", revision: 0 });
  const status = session.auto_resume;
  const contractUnknown = status?.state === "unknown" || status?.failure_reason === "unknown";
  const controlAvailable = session.auto_resume_control_available === true;
  const stateUnavailableReason = status === undefined
    ? "Unsupported runtime"
    : status === null
      ? "Invalid runtime state"
      : !status.supported
          ? "Unsupported runtime"
          : contractUnknown && !status.enabled
            ? "State unknown"
            : status.state === "terminal_failure" && status.failure_reason === "state_unavailable"
              ? "State unavailable"
              : null;
  const controlUnavailableReason = status?.supported && !controlAvailable
    ? "Controls unavailable"
    : null;
  const canCancel = Boolean(controlAvailable && status?.supported && status.enabled);
  const canEnable = Boolean(
    controlAvailable
      && status?.supported
      && !status.enabled
      && stateUnavailableReason === null,
  );
  const nextEnabled = canCancel ? false : canEnable ? true : null;
  const sharedNow = useSharedClock(Boolean(clockActive && status?.state === "scheduled" && now === undefined));
  const effectiveNow = now ?? sharedNow;
  const unavailable = !status || !status.supported || (contractUnknown && !status.enabled);
  let label = "Auto-resume unavailable";
  let statusDetail: string | null = null;
  let visualState = unavailable ? "unavailable" : status?.state ?? "unavailable";
  if (status?.supported && contractUnknown) {
    label = status.enabled ? "Auto-resume active" : "Auto-resume unavailable";
    statusDetail = status.enabled ? "Unknown state or failure" : "State unknown";
    visualState = status.enabled ? "unknown-active" : "unavailable";
  } else if (!unavailable) {
    switch (status.state) {
      case "disabled": label = "Auto-resume off"; break;
      case "enabled": label = "Auto-resume on"; break;
      case "armed": label = "Auto-resume armed"; break;
      case "scheduled": {
        const scheduled = status.scheduled_at ? Date.parse(status.scheduled_at) : Number.NaN;
        const remaining = Number.isFinite(scheduled) ? Math.max(0, scheduled - effectiveNow) : Number.NaN;
        const suffix = Number.isFinite(remaining) ? ` in ${formatAutoResumeDelay(remaining)}` : "";
        label = `Auto-resume scheduled${suffix}`;
        break;
      }
      case "checking": label = "Auto-resume checking usage"; break;
      case "switching_account": label = "Auto-resume switching account"; break;
      case "resumed": label = "Auto-resume resumed"; break;
      case "cancelled": label = "Auto-resume cancelled"; break;
      case "transient_failure": label = "Auto-resume retrying"; break;
      case "terminal_failure": label = "Auto-resume failed"; break;
    }
    statusDetail = autoResumeFailureLabel(status.failure_reason);
  }
  const detailParts = [statusDetail, stateUnavailableReason, controlUnavailableReason]
    .filter((detail): detail is string => detail !== null)
    .filter((detail, index, details) => details.indexOf(detail) === index);
  const detail = detailParts.length > 0 ? detailParts.join(". ") : null;
  const accessibleLabel = detail ? `${label}: ${detail}` : label;
  const iconOnly = AUTO_RESUME_ICON_ONLY_STATES.has(visualState);
  const content = (
    <>
      <span className="auto-resume-status-glyph" aria-hidden="true">
        <AutoResumeIcon />
      </span>
      {iconOnly ? null : (
        <span className="auto-resume-status-text">
          <span className="auto-resume-status-main">{label}</span>
          {detail ? <span className="auto-resume-status-detail">{detail}</span> : null}
        </span>
      )}
    </>
  );
  const className = `auto-resume-status auto-resume-${visualState}${iconOnly ? " auto-resume-icon-only" : ""}`;
  if (onToggle && nextEnabled !== null) {
    const disablingCompletedResume = !nextEnabled && status?.state === "resumed";
    const actionVerb = nextEnabled ? "Enable" : disablingCompletedResume ? "Disable" : "Cancel";
    const successVerb = nextEnabled ? "enabled" : disablingCompletedResume ? "disabled" : "cancelled";
    const actionLabel = `${actionVerb} auto-resume for ${sessionLabel(session)}`;
    const handleToggle = async () => {
      let succeeded = false;
      try {
        succeeded = await onToggle(nextEnabled);
      } catch {
        succeeded = false;
      }
      const message = succeeded
          ? `Auto-resume ${successVerb} for ${sessionLabel(session)}`
          : `Could not ${actionVerb.toLowerCase()} auto-resume for ${sessionLabel(session)}`;
      setAnnouncement((current) => ({ message, revision: current.revision + 1 }));
    };
    return (
      <>
        <AsyncButton
          type="button"
          className={`${className} auto-resume-status-button`}
          pending={pending}
          iconOnly={iconOnly}
          aria-label={actionLabel}
          aria-describedby={descriptionId}
          title={`${actionLabel}. ${accessibleLabel}`}
          onClick={handleToggle}
        >
          {content}
        </AsyncButton>
        <span className="sr-only" id={descriptionId}>{accessibleLabel}</span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement.message ? <span key={announcement.revision}>{announcement.message}</span> : null}
        </span>
      </>
    );
  }
  return (
    <>
      <span
        className={className}
        role="status"
        aria-label={accessibleLabel}
        title={accessibleLabel}
      >
        {content}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.message ? <span key={announcement.revision}>{announcement.message}</span> : null}
      </span>
    </>
  );
}

function autoResumeFailureLabel(
  reason: NonNullable<Session["auto_resume"]>["failure_reason"],
): string | null {
  switch (reason) {
    case "state_unavailable": return "State unavailable";
    case "manual_input": return "Manual input cancelled it";
    case "account_switch": return "Account switch cancelled it";
    case "usage_unavailable": return "Usage unavailable";
    case "usage_window_not_exhausted": return "Usage limit not exhausted";
    case "exhausted_reset_unavailable": return "Reset time unavailable";
    case "session_state_changed": return "Session changed";
    case "submission_outcome_unknown": return "Submission outcome unknown";
    case "provider_unsupported": return "Provider unsupported";
    case "scheduler_error": return "Scheduler error";
    case "no_account_available": return "No other account has confirmed capacity; waiting for reset";
    case "account_switch_failed": return "Account switch failed";
    case "unknown": return "Unknown failure";
    case undefined: return null;
  }
}

function formatAutoResumeDelay(milliseconds: number): string {
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
