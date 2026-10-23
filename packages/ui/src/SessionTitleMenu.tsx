import { useCallback, useRef, type RefObject } from "react";
import type { AccountSummary } from "@agent-console/shared/api";
import { AgentBadge } from "./AgentBadge.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import { useHarnessCompact } from "./harnessCompact.ts";
import { IconButton } from "./IconButton.tsx";
import { SessionAccountChip } from "./SessionAccountBadge.tsx";
import { SessionModelBadge } from "./SessionModelBadge.tsx";
import { RepoBadge } from "./SessionSlot.tsx";
import { sessionLabel, sessionRepoLabel } from "./format.ts";
import { sessionKey } from "./layout.ts";
import { sessionAccountView } from "./sessionAccounts.ts";
import type { MachineColorMap } from "./machineColors.ts";
import type { DashboardSession, Session } from "./types.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";

/**
 * One session row of a session dropdown: [position] [repo badge] title …
 * [harness segment] [Move here]. Every repo badge has the same fixed width on
 * a single line (the full name is its tooltip), so all titles start in one
 * column. The harness segment is the status line's (harness icon, account
 * badge, model · effort · context) and narrows in the harnessCompact.ts order.
 * Move here is a separate control, offered only while manual ordering is on.
 */
export function SessionMenuOption({ session, ordinal, current, machineColors, onSelect, onMoveHere }: {
  readonly session: DashboardSession;
  readonly ordinal?: number;
  readonly current: boolean;
  readonly machineColors: MachineColorMap;
  readonly onSelect: () => void;
  readonly onMoveHere?: () => void;
}) {
  const label = sessionLabel(session);
  return (
    <div className="slot-menu-row" role="none">
      <button
        className={`control-menu slot-menu-item slot-menu-session ${current ? "current" : ""}`}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-current={current ? "true" : undefined}
        onClick={onSelect}
      >
        <span className={`slot-menu-main${ordinal === undefined ? "" : " is-ordered"}`}>
          {ordinal === undefined ? null : <span className="slot-menu-ordinal" aria-hidden="true">{ordinal}</span>}
          <RepoBadge label={sessionRepoLabel(session)} machine={session.machine} machineColors={machineColors} singleLine />
          <span className="slot-menu-label">{label}</span>
        </span>
        <span className="session-harness">
          <AgentBadge agent={session.agent} decorative />
          <SessionAccountChip session={session} />
          <SessionModelBadge session={session} />
        </span>
      </button>
      {onMoveHere && !current ? (
        <IconButton preset="compact"
          className="slot-menu-move"
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-label={`Move ${label} here`}
          title="Move here: swap into the current position"
          onClick={(event) => {
            event.stopPropagation();
            onMoveHere();
          }}
        >
          <span aria-hidden="true">⇅</span>
        </IconButton>
      ) : null}
    </div>
  );
}

/** Fit each open dropdown row's harness segment to its row. */
export function useSessionMenuCompact(menuRef: RefObject<HTMLElement | null>, open: boolean): void {
  useHarnessCompact(menuRef, open, (menu) => [...menu.querySelectorAll<HTMLElement>(".slot-menu-session")].flatMap((row) => {
    const target = row.querySelector<HTMLElement>(".session-harness");
    return target ? [{ target, row, title: row.querySelector<HTMLElement>(".slot-menu-label"), minTitlePx: SESSION_MENU_MIN_TITLE_PX }] : [];
  }));
}
const SESSION_MENU_MIN_TITLE_PX = 120;

// Both overview cards use the same menu actions and focus/dismiss behaviour.
// An ordered menu (the focused header) lists the sessions in the shared sort
// order with their positions, and choosing one navigates to it.
export function SessionTitleMenu({ session, options, machineColors, accounts, accountPendingKey,
  currentKey, open, onOpenChange, beginTitleEdit, onConversation, onTerminal, onAccount, onSelect, onNewSession,
  selectionEnabled = true, ordered = false, onMoveHere, mobile = false, descriptionId,
}: {
  readonly session: Session;
  readonly options: readonly DashboardSession[];
  readonly machineColors: MachineColorMap;
  readonly accounts: readonly AccountSummary[];
  readonly accountPendingKey: string | null;
  readonly currentKey: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly beginTitleEdit: (session: Session) => void;
  readonly onConversation?: (session: Session) => void;
  /** Phone Conversation's way back to session (terminal) mode. */
  readonly onTerminal?: (session: Session) => void;
  readonly onAccount: (session: Session, account: string) => Promise<void>;
  readonly onSelect: (key: string) => void;
  readonly onNewSession: () => void;
  readonly selectionEnabled?: boolean;
  readonly ordered?: boolean;
  /** Swaps a listed session into this session's position; absent while ordering is automatic. */
  readonly onMoveHere?: (key: string) => void;
  readonly mobile?: boolean;
  readonly descriptionId?: string;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissOnOutside(open, ".slot-title-menu", closeMenu);
  const menuFocus = useMenuFocus({ open, menuRef, triggerRef, onClose: closeMenu });
  useSessionMenuCompact(menuRef, open);
  const accountView = sessionAccountView(session, accounts);
  return (
    <details
      className="slot-title-menu"
      open={open}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
    >
      <summary
        ref={triggerRef}
        className={"control-trigger " + (mobile ? "mobile-session-card-open" : "slot-title")}
        aria-label={`Session menu for ${sessionLabel(session)}`}
        title="Open session menu"
        aria-describedby={descriptionId}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenChange(!open);
        }}
      >
        <span className="slot-title-text">
          <span className={mobile ? "mobile-session-card-title" : "slot-title-label"}>{sessionLabel(session)}</span>
        </span>
      </summary>
      <div ref={menuRef} className="slot-title-dropdown" role="menu" onKeyDown={menuFocus.onKeyDown}>
        <button
          className="control-menu slot-menu-item"
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            closeMenu();
            beginTitleEdit(session);
          }}
        >
          <span className="slot-menu-label">Rename title</span>
        </button>
        {onConversation ? (
          <button
            className="control-menu slot-menu-item"
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              closeMenu();
              onConversation(session);
            }}
          >
            <span className="slot-menu-label">Conversation</span>
          </button>
        ) : null}
        {onTerminal ? (
          <button
            className="control-menu slot-menu-item"
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              closeMenu();
              onTerminal(session);
            }}
          >
            <span className="slot-menu-label">Terminal</span>
          </button>
        ) : null}
        {accountView?.pickFirstFromMenu ? (
          <>
            <div className="slot-menu-divider" role="separator" />
            <span className="slot-menu-section-label">Switch {accountView.label} account</span>
            {accounts.map((item) => (
                <AsyncButton
                  key={item.account}
                  className="control-menu slot-menu-item account-menu-item"
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  pending={accountPendingKey === sessionKey(session)}
                  aria-label={`Switch ${sessionLabel(session)} to ${accountView.label} account ${item.account}`}
                  onClick={async () => {
                    closeMenu();
                    await onAccount(session, item.account);
                  }}
                >
                  <span className="slot-menu-label">{item.label ?? item.account}</span>
                  <span className="slot-menu-meta">{item.plan ?? item.account}</span>
                </AsyncButton>
              ))}
          </>
        ) : null}
        {selectionEnabled ? (
          <>
            <div className="slot-menu-divider" role="separator" />
            {/* Rows mount only while open: each carries a full harness segment. */}
            {open ? options.map((candidate, index) => {
              const key = sessionKey(candidate);
              return (
                <SessionMenuOption
                  key={key}
                  session={candidate}
                  ordinal={ordered ? index + 1 : undefined}
                  current={key === currentKey}
                  machineColors={machineColors}
                  onSelect={() => {
                    closeMenu();
                    onSelect(key);
                  }}
                  onMoveHere={onMoveHere ? () => {
                    closeMenu();
                    onMoveHere(key);
                  } : undefined}
                />
              );
            }) : null}
            <div className="slot-menu-divider" role="separator" />
            <button
              className="control-menu slot-menu-item"
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                closeMenu();
                onNewSession();
              }}
            >
              <span className="slot-menu-label">+ New session...</span>
            </button>
          </>
        ) : null}
      </div>
    </details>
  );
}
