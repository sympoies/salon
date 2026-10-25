import { IconButton } from "./IconButton.tsx";
import { SessionModelBadge } from "./SessionModelBadge.tsx";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { AgentBadge } from "./AgentBadge.tsx";
import { SessionActivityPopover } from "./SessionActivityPopover.tsx";
import { SessionBadges, type SessionBadgeNavigation } from "./extensions.tsx";
import type { CardPreview } from "./cardPreview.ts";
import { sessionCardPreview } from "./sessionPromptPreview.ts";
import { AutoResumeBadge, RepoBadgeLink } from "./SessionSlot.tsx";
import { SessionAccountBadge } from "./SessionAccountBadge.tsx";
import "./sessionCardRows.css";
import { SessionTitleMenu } from "./SessionTitleMenu.tsx";
import { InlineTitleEditor } from "./InlineTitleEditor.tsx";
import { sessionAccountChoices, type AccountInventoriesByProvider } from "./sessionAccounts.ts";
import { sessionLabel, sessionRepoLabel } from "./format.ts";
import { sessionKey } from "./layout.ts";
import type { MachineColorMap } from "./machineColors.ts";
import { useSharedClock } from "./useSharedClock.ts";
import { compactVoicePromptNote } from "./voicePrompt.ts";
import type { ActivityDeliveryState } from "./activityStream.ts";
import type { DashboardSession, Session } from "./types.ts";

export interface MobileSessionListProps {
  readonly cardPreview?: CardPreview;
  /**
   * Sessions in the shared cross-device order (the same ⌘-nav / picker order the
   * macOS grid uses); rendered as-is so the mobile overview, the session picker,
   * and desktop all agree. No attention re-sort — status is shown per card.
   */
  readonly sessions: readonly DashboardSession[];
  readonly options?: readonly DashboardSession[];
  readonly editingTitleKey: string | null;
  readonly beginTitleEdit: (session: Session) => void;
  readonly saveTitleEdit: (session: Session, title: string | null) => Promise<void>;
  readonly cancelTitleEdit: () => void;
  readonly onRetitle: (session: Session) => void;
  readonly historyMachineNames?: ReadonlySet<string>;
  readonly onConversation?: (session: Session) => void;
  readonly onNewSession: (session: Session) => void;
  /** Swaps a listed session into this card's ranked position; absent while ordering is automatic. */
  readonly onMoveSessionHere?: (session: Session, key: string) => void;
  readonly machineColors: MachineColorMap;
  readonly reachableMachineNames: ReadonlySet<string>;
  readonly activityDeliveryByMachine: ReadonlyMap<string, ActivityDeliveryState>;
  readonly clockActive: boolean;
  readonly resumingKey: string | null;
  readonly autoResumePendingKey: string | null;
  readonly accountPendingKey: string | null;
  readonly accountsByProvider: AccountInventoriesByProvider;
  /** Freeze and hide the list from AT while a modal (e.g. Create) is open. */
  readonly inert?: boolean;
  /** Restore this scroll offset when the overview remounts after a focused session. */
  readonly initialScrollTop: number;
  readonly onScrollTopChange: (scrollTop: number) => void;
  /** Open a session fullscreen (its key is `machine/id`). */
  readonly onOpen: (key: string) => void;
  readonly onResume: (session: Session) => void | Promise<void>;
  readonly onAutoResume: (session: Session, enabled: boolean) => Promise<boolean>;
  readonly onAccount: (session: Session, account: string) => Promise<void>;
  /** Follow this session's lineage marker. */
  readonly onLineageMarker?: (session: Session, navigation?: SessionBadgeNavigation) => void;
}

// Mobile overview: one scannable status card per session instead of a grid of
// cramped live terminals. No terminal is mounted here — tapping a preview opens the
// single fullscreen terminal (see Dashboard's mobile focus branch), so at most
// one live terminal runs on a phone.
export function MobileSessionList({
  sessions,
  cardPreview = "latest-message",
  options = sessions,
  editingTitleKey,
  beginTitleEdit,
  saveTitleEdit,
  cancelTitleEdit,
  onRetitle,
  onConversation,
  historyMachineNames,
  onNewSession,
  onMoveSessionHere,
  machineColors,
  reachableMachineNames,
  activityDeliveryByMachine,
  clockActive,
  resumingKey,
  autoResumePendingKey,
  accountPendingKey,
  accountsByProvider,
  inert,
  initialScrollTop,
  onScrollTopChange,
  onOpen,
  onResume,
  onAutoResume,
  onAccount,
  onLineageMarker,
}: MobileSessionListProps) {
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const nowMs = useSharedClock(clockActive);
  const listRef = useRef<HTMLOListElement>(null);
  const listId = useId();

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = initialScrollTop;
    onScrollTopChange(list.scrollTop);
  }, [initialScrollTop, onScrollTopChange]);

  return (
    <ol
      ref={listRef}
      className="mobile-session-list"
      inert={inert ? true : undefined}
      aria-hidden={inert ? "true" : undefined}
      onScroll={(event) => onScrollTopChange(event.currentTarget.scrollTop)}
    >
      {sessions.map((session) => {
        const key = sessionKey(session);
        const machineReachable = reachableMachineNames.has(session.machine);
        const activityDeliveryState = activityDeliveryByMachine.get(session.machine) ?? "polling";
        const canResume =
          session.status === "stopped" && session.resumable === true;
        const resuming = resumingKey === key;
        const promptPreview = sessionCardPreview(session, cardPreview);
        const promptId = `${listId}-prompt-${key}`;
        return (
          <li key={key} className="mobile-session-card">
            <div className="mobile-session-card-head">
              {/* The desktop card rows: identity (repo, role, title), then harness
                  (provider, account, model and effort, auto-resume, status). */}
              <div className="mobile-session-card-toolbar">
                <div className="mobile-session-card-row-one">
                  <span className="mobile-session-card-meta">
                    <RepoBadgeLink
                      label={sessionRepoLabel(session)}
                      session={session}
                      machineColors={machineColors}
                      singleLine
                    />
                    <SessionBadges
                      item={session}
                      surface="mobile-card"
                      onLineage={onLineageMarker ? navigation => onLineageMarker(session, navigation) : undefined}
                    />
                  </span>
                  {editingTitleKey === key ? (
                    <InlineTitleEditor
                      initialValue={session.title ?? ""} formClassName="slot-title-form" inputClassName="slot-title-input"
                      onSave={(title) => saveTitleEdit(session, title)} onCancel={cancelTitleEdit} stopClickPropagation
                    />
                  ) : (
                    <SessionTitleMenu
                      session={session} options={options} ordered machineColors={machineColors}
                      accounts={sessionAccountChoices(session, accountsByProvider)} accountPendingKey={accountPendingKey}
                      currentKey={key} open={openMenuKey === key} onOpenChange={(open) => setOpenMenuKey(open ? key : null)}
                      beginTitleEdit={beginTitleEdit} onConversation={(!historyMachineNames || historyMachineNames.has(session.machine)) ? onConversation : undefined} onAccount={onAccount}
                      onSelect={onOpen} onMoveHere={onMoveSessionHere ? (selectedKey) => onMoveSessionHere(session, selectedKey) : undefined}
                      onNewSession={() => onNewSession(session)} mobile descriptionId={promptPreview ? promptId : undefined}
                    />
                  )}
                </div>
                <div className="mobile-session-card-row-two">
                  <IconButton preset="compact" type="button" className="agent-retitle-button" aria-label={`Retitle ${sessionLabel(session)}`} title={`Retitle ${sessionLabel(session)}`} onClick={() => onRetitle(session)}>
                    <AgentBadge agent={session.agent} decorative />
                  </IconButton>
                  <SessionAccountBadge
                    session={session}
                    accounts={sessionAccountChoices(session, accountsByProvider)}
                    pending={accountPendingKey === key}
                    onAccount={onAccount}
                    clockActive={clockActive}
                    now={nowMs}
                  />
                  <SessionModelBadge session={session} />
                  <AutoResumeBadge
                    session={session}
                    clockActive={clockActive}
                    now={nowMs}
                    pending={autoResumePendingKey === key}
                    onToggle={(enabled) => onAutoResume(session, enabled)}
                  />
                  <span className="mobile-session-card-status">
                    <SessionActivityPopover
                      session={session}
                      machineReachable={machineReachable}
                      focused={false}
                      clockActive={clockActive}
                      nowMs={nowMs}
                      activityDeliveryState={activityDeliveryState}
                    />
                  </span>
                </div>
              </div>
              {/* Reserve the same preview space even when no prompt is available. */}
              <button type="button" className="control-row mobile-session-card-prompt-open mobile-session-card-open-action"
                aria-label={`Open ${sessionLabel(session)}`} aria-describedby={promptPreview ? promptId : undefined}
                onClick={() => onOpen(key)}>
                <span id={promptId} className="mobile-session-card-prompt" aria-hidden={!promptPreview || undefined}>
                  {promptPreview ? compactVoicePromptNote(promptPreview) : "No prompt yet — Open session"}
                </span>
              </button>
            </div>
            {canResume ? (
              <div className="mobile-session-card-foot">
                <button
                  type="button"
                  className="btn ghost mobile-session-card-resume"
                  disabled={resuming}
                  aria-label={`Recover ${sessionLabel(session)}`}
                  onClick={() => {
                    void onResume(session);
                  }}
                >
                  {resuming ? "Recovering…" : "Recover"}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
