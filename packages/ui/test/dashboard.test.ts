import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  makeCssRuleLookup,
  sourceBlock as sourceBlockFrom,
  uiSource,
  uiStyles,
} from "./support/source.ts";

const dashboardSource = uiSource("Dashboard.tsx");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const titleMenuSource = uiSource("SessionTitleMenu.tsx");
const sessionActivityPopoverSource = uiSource("SessionActivityPopover.tsx");
const layoutSyncSource = uiSource("useLayoutSync.ts");
const slotDragSource = uiSource("useSlotDrag.ts");
const keyboardSource = uiSource("useDashboardKeyboard.ts");
const autoTitleControllerSource = uiSource("useAutoTitleController.ts");
const androidBackSource = uiSource("useAndroidBackEntry.ts");
const source = [
  dashboardSource,
  sessionSlotSource,
  titleMenuSource,
  layoutSyncSource,
  slotDragSource,
  keyboardSource,
  autoTitleControllerSource,
  androidBackSource,
].join("\n");
const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);


function zIndexFor(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped} \\{[\\s\\S]*?z-index: (\\d+);`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return Number(match[1]);
}

function sourceBlock(start: string, end: string): string {
  return sourceBlockFrom(source, start, end);
}

function callBlock(callee: string): string {
  return sourceBlock(`${callee}({`, "\n      });");
}

test("Dashboard uses the slot title as the only session picker trigger", () => {
  assert.match(source, /className="slot-title-menu"/);
  assert.doesNotMatch(source, /aria-label=\{`Session for slot \$\{index \+ 1\}`\}/);
  assert.doesNotMatch(source, /<select\s+value=\{slot \?\? ""\}/);
});

test("Dashboard exposes title editing from the session picker menu", () => {
  assert.match(source, /Rename title/);
  assert.match(source, /beginTitleEdit\(session\)/);
  assert.match(source, /title=\{s \? "Open session menu" : "Open slot menu"\}/);
});

test("Dashboard auto-updates titles from create prompts", () => {
  assert.match(source, /prepareCreateSessionAutoTitle/);
  assert.match(source, /applyCreatePromptAutoTitleSummary/);
  assert.match(source, /applyTurnPromptAutoTitleSummary/);
  assert.match(source, /readAutoTitleStates\(resolveLocalStorage\(\)\)/);
  assert.match(source, /writeAutoTitleStates\(resolveLocalStorage\(\), autoTitleStates\)/);
  assert.doesNotMatch(source, /onUserPrompt/);
  assert.doesNotMatch(source, /terminalPromptCapture/);
  assert.match(dashboardSource, /const result = await updateManualSessionTitle\(s, nextTitle\);/);
  assert.match(
    autoTitleControllerSource,
    /baseTitle: canonicalTitle,[\s\S]*ownedTitle: canonicalTitle/,
  );

  const createBlock = callBlock("applyCreatePromptAutoTitleSummary");
  assert.match(createBlock, /isDisabled: \(\) => isAutoTitleDisabled\(key\),/);
  assert.match(
    createBlock,
    /expectedSessionIncarnation,\s+expectedSessionTitle: expectedCurrentTitle,\s+titleStateSupported: titleSnapshot\.title_state_supported === true,\s+titleCasSupported,/,
  );
});

test("Dashboard records ownership for locally created blank placeholders", () => {
  assert.match(dashboardSource, /const confirmedPrompt = submittedCreatedPrompt\(prompt, initializationResult\);/);
  assert.match(
    dashboardSource,
    /createdSessionAutoTitleState\(\{[\s\S]*?prompt: confirmedPrompt,[\s\S]*?fallbackTitle,[\s\S]*?\}\)/,
  );
});

test("Dashboard composes the Task 7.2 hook lifts and grouped slot props", () => {
  assert.match(layoutSyncSource, /export function useLayoutSync/);
  assert.match(slotDragSource, /export function useSlotDrag/);
  assert.match(keyboardSource, /export function useDashboardKeyboard/);
  assert.match(autoTitleControllerSource, /export function useAutoTitleController/);

  assert.match(dashboardSource, /useLayoutSync\(\{/);
  assert.match(dashboardSource, /useSlotDrag\(\{/);
  assert.match(dashboardSource, /useDashboardKeyboard\(\{/);
  assert.match(dashboardSource, /useAutoTitleController\(\{/);
  assert.doesNotMatch(dashboardSource, /layoutPutTimerRef/);
  assert.doesNotMatch(dashboardSource, /dragIndexRef/);
  assert.doesNotMatch(dashboardSource, /pointerDragRef/);
  assert.doesNotMatch(dashboardSource, /createTurnTitleIdleScheduler/);
  assert.doesNotMatch(dashboardSource, /window\.addEventListener\("keydown", onKeyDown\)/);

  assert.match(sessionSlotSource, /export interface SessionSlotProps \{/);
  assert.match(sessionSlotSource, /readonly view: /);
  assert.match(sessionSlotSource, /readonly drag: /);
  assert.match(sessionSlotSource, /readonly actions: /);
  assert.match(sessionSlotSource, /readonly terminal: /);
  assert.match(dashboardSource, /view=\{/);
  assert.match(dashboardSource, /drag=\{/);
  assert.match(dashboardSource, /actions=\{/);
  assert.match(dashboardSource, /terminal=\{/);
  assert.doesNotMatch(dashboardSource, /slotPointerDragIndex=\{/);
  assert.doesNotMatch(dashboardSource, /handleSlotDragOver=\{/);
  assert.doesNotMatch(dashboardSource, /rememberTerminalStatus=\{/);
});

test("Dashboard wires terminal turns into an idle title refresh", () => {
  assert.match(source, /const TURN_TITLE_IDLE_MS = 12_000;/);
  assert.match(source, /createTurnTitleIdleScheduler<PendingTurnTitleRefresh>/);
  assert.match(
    source,
    /onTurnPromptSubmit=\{\(prompt, eventId, submittedAt\) => \([\s\S]*?noteTurnPromptSubmitted\(s, prompt, eventId, submittedAt\)/,
  );
  assert.match(source, /onTurnOutput=\{\(\) => noteTurnOutput\(s\)\}/);
  assert.match(source, /turnTitleScheduler\.set\(key,/);
  assert.match(source, /turnTitleScheduler\.bump\(sessionKey\(session\)\)/);
  assert.match(source, /glance,/);

  const turnBlock = callBlock("applyTurnPromptAutoTitleSummary");
  assert.match(turnBlock, /isDisabled: \(\) => isAutoTitleDisabled\(key\),/);
  assert.match(turnBlock, /pending\.session\.session_incarnation,[\s\S]*?expectedCurrentTitle \?\? null,/);
});

test("Dashboard passes the device terminal rendering mode to every live pane", () => {
  assert.match(dashboardSource, /readonly terminalRenderMode:/);
  assert.match(dashboardSource, /terminalRenderMode,/);
  assert.match(sessionSlotSource, /readonly terminalRenderMode:/);
  assert.match(sessionSlotSource, /renderMode=\{terminalRenderMode\}/);
});

test("Dashboard renders repo context before session titles", () => {
  assert.match(source, /sessionRepoLabel/);
  assert.match(source, /function RepoBadge/);
  assert.match(source, /function RepoBadgeLink/);
  assert.match(source, /className=\{`repo-badge \$\{lines\.length > 1 \? "split" : ""\}`\}/);
  assert.match(
    source,
    /<RepoBadgeLink label=\{sessionRepoLabel\(s\)\} session=\{s\} machineColors=\{machineColors\} \/>[\s\S]*?<span className="slot-title-label">/,
  );
  assert.match(
    source,
    /<RepoBadge label=\{sessionRepoLabel\(session\)\} machine=\{session\.machine\} machineColors=\{machineColors\} singleLine \/>[\s\S]*?<span className="slot-menu-label">/,
  );
  assert.match(css, /\.repo-badge-link \{/);
  assert.match(css, /\.repo-badge-line \{/);
  assert.match(css, /color: var\(--machine-accent, var\(--accent\)\);/);
});

test("Dashboard keeps the repo badge visually closer to the session title than the row icon spacing", () => {
  // Assert the relationship this test is named for, not the literals: the title's
  // left inset must be a smaller step than the gap between row items, so the
  // badge reads as belonging to the title rather than as another row icon.
  const SPACE_ORDER = ["--space-3xs", "--space-2xs", "--space-xs", "--space-sm", "--space-md", "--space-lg"];
  const rowGap = cssRuleFor(".slot-title-row").match(/gap: var\((--space-[\w-]+)\)/)?.[1];
  const titleInset = cssRuleFor(".slot-title-menu > summary.slot-title")
    .match(/padding:(?:\s+var\(--space-[\w-]+\)){3}\s+var\((--space-[\w-]+)\)/)?.[1];
  assert.ok(rowGap && titleInset, "row gap and title inset should both come from the spacing scale");
  assert.ok(
    SPACE_ORDER.indexOf(titleInset) < SPACE_ORDER.indexOf(rowGap),
    `title inset ${titleInset} should be a smaller step than the row gap ${rowGap}`,
  );
});

test("Dashboard keeps the full-width slot menu hit target stable while pressed", () => {
  const pressedTitleRule = cssRuleFor(".slot-title-menu > summary.slot-title:active");
  assert.match(pressedTitleRule, /transform: none;/);
  assert.match(pressedTitleRule, /background: rgba\(var\(--accent-rgb\), 0\.1\);/);
});

test("Dashboard lets the slot dropdown span the full header width", () => {
  const dropdownRule = cssRuleFor(".slot-title-dropdown");
  assert.match(dropdownRule, /max-width: none;/);
  assert.doesNotMatch(dropdownRule, /max-width: 360px;/);
});

test("Dashboard gives split repo names room before truncating the session title", () => {
  assert.match(cssRuleFor(".repo-badge"), /max-width: min\(6\.5rem, 42%\);/);
  assert.match(cssRuleFor(".repo-badge-link"), /max-width: min\(6\.5rem, 42%\);/);
});

test("Dashboard keeps one-line and split repo badges at the same centered height", () => {
  const repoBadgeRule = cssRuleFor(".repo-badge");
  assert.match(repoBadgeRule, /box-sizing: border-box;/);
  assert.match(repoBadgeRule, /height: var\(--icon-compact-size\);/);
  assert.match(repoBadgeRule, /justify-content: center;/);
});

test("Dashboard exposes explicit recovery action for resumable sessions", () => {
  assert.match(source, /resumeSession/);
  assert.match(source, /isSessionResumeAvailable,/);
  assert.match(source, /sessionStatusLabel,/);
  assert.match(source, /const resumeAvailable = s \? isSessionResumeAvailable\(s\) : false;/);
  assert.match(source, /const onResume = async \(s: Session\) => \{/);
  assert.match(source, /const resumeButton = s && resumeAvailable \? \(/);
  assert.match(source, /\{headerFeedback\}\s*\{resumeButton\}\s*\{titleControlFor\(false\)\}/);
  assert.match(source, /className="slot-focus-actions"[\s\S]*\{resumeButton\}/);
  assert.match(source, />\s*Recover\s*<\/AsyncButton>/);
  assert.match(source, /s\.status === "running" \? \(/);
});


test("Dashboard renders agent providers as icon badges", () => {
  const badgeButtonBlock = sourceBlock('className="agent-retitle-button"', "</button>");

  assert.match(source, /import \{ AgentBadge \} from "\.\/AgentBadge\.tsx";/);
  assert.match(source, /className="agent-retitle-button"/);
  assert.doesNotMatch(badgeButtonBlock, /onPointerDown=/);
  assert.match(badgeButtonBlock, /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*onRetitle\(s\);\s*\}\}/);
  assert.match(badgeButtonBlock, /<AgentBadge[\s\S]*?agent=\{s\.agent\}[\s\S]*?decorative/);
  assert.match(source, /target\?\.closest\("button,input,textarea,select,a,\[role=dialog\],\[role=tooltip\]"\)/);
  assert.doesNotMatch(source, /<span className=\{`agent \$\{s\.agent\}`\}>\{s\.agent\}<\/span>/);
  assert.match(css, /\.agent-badge \{/);
  assert.match(cssRuleFor(".agent-retitle-button"), /cursor: pointer;/);
  assert.match(css, /\.agent-badge\.codex \{/);
  assert.match(css, /\.agent-badge\.claude \{/);
  // claude-gpt is retired: no badge tint, and no orphan mark rule behind it.
  assert.doesNotMatch(css, /\.agent-badge\.agent-console \{/);
  assert.doesNotMatch(css, /\.agent-badge-icon\.agent-console-mark \{/);
});

test("Dashboard controls slot menus and closes them from outside interactions", () => {
  assert.match(source, /const \[openSlotMenuKey, setOpenSlotMenuKey\] = useState<string \| null>\(null\);/);
  assert.match(source, /const closeOpenSlotMenus = useCallback\(\(\) => \{\s*setOpenSlotMenuKey\(null\);\s*\}, \[\]\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*closeOpenSlotMenus\(\);\s*\}, \[focusedKey, closeOpenSlotMenus\]\);/);
  assert.match(sessionSlotSource, /const open = openSlotMenuKey === slotMenuKey;/);
  assert.match(titleMenuSource, /useDismissOnOutside\(open, "\.slot-title-menu", closeMenu\);/);
  assert.match(titleMenuSource, /useMenuFocus\(\{ open, menuRef, triggerRef, onClose: closeMenu \}\)/);
  assert.match(sessionSlotSource, /open=\{open\}/);
  assert.doesNotMatch(dashboardSource, /document\.addEventListener\("pointerdown", closeOpenSlotMenu\)/);
  assert.doesNotMatch(dashboardSource, /shouldCloseSlotMenu/);
});

test("Dashboard fills visible slots from deterministic session order", () => {
  assert.match(source, /sortByDefaultSessionOrder/);
  assert.match(
    source,
    /const visible = useMemo\(\(\) => \{[\s\S]{0,300}?return sortByDefaultSessionOrder\(filtered, machines\);[\s\S]{0,80}?\}, \[machines, sessions, machineFilter, focusedKey\]\);/,
  );
  assert.match(source, /const next = reconcileSlots\(prev, visible, slotCount\);/);
});

test("an extension ordering policy applies after layout ranking", () => {
  // The pin is the last step of the overview order, after the layout ranking.
  assert.match(
    source,
    /const orderedOverviewSessions = useMemo\(\(\) => \{[\s\S]{0,400}?const ordered = orderSessionListSessions\(\{[\s\S]{0,400}?return orderingPolicy \? orderingPolicy\.order\(ordered\) : ordered;[\s\S]{0,120}?\}, \[layoutSessionKeys, visible, orderingPolicy, orderingRevision\]\);/,
  );
  // And it is not applied anywhere else (visible list, slot repair, …).
  assert.doesNotMatch(
    source,
    /const visible = useMemo\(\(\) => \{[\s\S]{0,400}?coordinatorSessionsFirst/,
  );
  assert.equal(source.match(/orderingPolicy\.order\(/g)?.length, 1);
});

test("Dashboard persists the session-pane order across devices via the layout store", () => {
  assert.match(source, /fetchLayoutOrder,/);
  assert.match(source, /putLayoutOrder,/);
  assert.match(source, /mergeLayoutOrderWithReachability,/);
  // Seeds this device's grid from the complete cross-device order — the fetched
  // ranking (or a newer optimistic one) plus the sessions it does not yet rank.
  assert.match(source, /const seedOrder = completeOrder;/);
  assert.match(source, /seedSlotsFromOrder\(seedOrder, visible, slotCount\)/);
  // The published ranking is derived from that complete order, never from this
  // device's slot geometry: an empty pane must not decide a session's rank.
  assert.match(source, /persistLayoutLocalOrder\(\s*completeOrder,/);
  assert.doesNotMatch(source, /deriveLayoutOrder\(slots\)/);
  // Only persists once the store is reachable AND the initial seed is armed, so a
  // stale localStorage order cannot clobber the store on load.
  assert.match(source, /layoutReachableRef/);
  assert.match(source, /layoutSyncArmed/);
  // Debounced PUT only fires when the complete ranking gains a session. A
  // temporarily missing session cannot turn into a remote deletion.
  assert.match(source, /const LAYOUT_PUT_DEBOUNCE_MS = \d+;/);
  assert.match(source, /mergeLayoutOrderWithReachability\(/);
  assert.match(source, /new Set\(sessions\.map\(sessionKey\)\)/);
  assert.match(source, /layoutOrderChanged\(completeOrder, previous\.order\)/);
  assert.match(source, /createLayoutPersistQueue\(/);
  assert.match(source, /layoutPersistQueueRef\.current\?\.persist\(\{\s*localOrder,\s*liveKeys,\s*reachableMachines,\s*reason,/);
  assert.match(source, /keepalive: options\.keepalive,/);
  assert.match(source, /urgent: options\.urgent,/);
  assert.match(source, /window\.addEventListener\("pagehide", flushPendingLayout\)/);
  assert.match(
    source,
    /persistLayoutPlacement\(sessionsRef\.current, "flush", \{\s*keepalive: true,\s*urgent: true,\s*\}\)/,
  );
  assert.match(source, /localOrderPlacement: placedInSlot,\s*keepalive: true,\s*urgent: true,/);
  assert.match(source, /"close",\s*\{ keepalive: true, urgent: true, removedKeys \},/);
});

test("Dashboard keeps localStorage as the offline cache and unreachable-store fallback", () => {
  // An unreachable refresh does not seed or PUT, while later focus/visibility
  // refreshes can reconnect without remounting. The local cache remains active.
  assert.match(source, /const result = await fetchLayoutOrder\(\)\.catch\(\(\) => null\);/);
  assert.match(layoutSyncSource, /if \(!result\.reachable\) \{\s*passiveConflictRef\.current = null;\s*layoutReachableRef\.current = false;\s*setLayoutReachable\(false\);/);
  assert.match(source, /window\.addEventListener\("focus", refreshWhenVisible\)/);
  // localStorage still mirrors every slots change.
  assert.match(source, /localStorageSetItem\(SLOTS_STORAGE, JSON\.stringify\(slots\)\)/);
});

test("Dashboard shows an explicit Open icon button for running slots on desktop and mobile", () => {
  assert.match(source, /const openButton = s && s\.status === "running" \? \(/);
  assert.match(source, /\{!focused \? openButton : null\}/);
  assert.match(source, /className="slot-action slot-open"/);
  assert.match(source, /title="Open session"/);
  assert.match(source, /<OpenSessionIcon \/>/);
  assert.doesNotMatch(source, />\s*Open\s*<\/button>/);
});

test("Dashboard lets desktop terminals receive clicks while mobile taps open the session", () => {
  assert.match(source, /if \(viewport\.mobile && slot && !focusedKey\) \{/);
  assert.doesNotMatch(source, /if \(slot && !focusedKey\) \{/);
});

test("Dashboard makes mobile terminal previews inert until focused", () => {
  assert.match(sessionSlotSource, /shouldTerminalPaneAcceptInteraction/);
  assert.match(
    sessionSlotSource,
    /const terminalInteractive = shouldTerminalPaneAcceptInteraction\(\{\s*focused,\s*mobile: viewport\.mobile,\s*\}\);/,
  );
  assert.match(sessionSlotSource, /interactive=\{terminalInteractive\}/);
});

test("Dashboard marks only its existing session-list focus target for optional realtime output", () => {
  assert.match(source, /terminalSelectedPaneRealtime/);
  assert.match(sessionSlotSource, /cmdFocusTarget/);
  assert.match(
    sessionSlotSource,
    /realtimeOutput=\{focused \|\| \(terminalSelectedPaneRealtime && cmdFocusTarget\)\}/,
  );
});

test("Dashboard lets every desktop running terminal drive its live terminal", () => {
  assert.match(
    sessionSlotSource,
    /const terminalInteractive = shouldTerminalPaneAcceptInteraction\(\{\s*focused,\s*mobile: viewport\.mobile,\s*\}\);/,
  );
  assert.match(sessionSlotSource, /interactive=\{terminalInteractive\}/);
  // Every pane drives its remote size; no agent kind is held to a preview size.
  assert.doesNotMatch(sessionSlotSource, /resizeRemote/);
});

test("Dashboard seeds drag data so WebKit app shells can reorder slots", () => {
  assert.match(source, /writeSlotDragData\(event\.dataTransfer, index\);/);
});

test("Dashboard accepts slot drops on the whole pane", () => {
  assert.match(source, /<li[\s\S]*?onDragOver=\{\(event\) => handleSlotDragOver\(event, index\)\}/);
  assert.match(source, /<li[\s\S]*?onDrop=\{\(event\) => handleSlotDrop\(event, index\)\}/);
  assert.match(source, /const from = dragIndexRef\.current;\s*if \(from === null\) \{\s*return;/);
});

test("Dashboard falls back to pointer reordering inside the macOS app shell", () => {
  assert.match(source, /slotIndexFromPoint/);
  assert.match(source, /const slotNativeDragEnabled = active && !mobile && !isMacTauri\(\);/);
  assert.match(source, /data-slot-index=\{String\(index\)\}/);
  assert.match(source, /draggable=\{slotNativeDragEnabled && !activityOpen\}/);
  assert.match(source, /onPointerDown=\{\(event\) => beginSlotPointerDrag\(event, index\)\}/);
  assert.match(source, /onClickCapture=\{suppressSlotPointerClick\}/);
  assert.match(source, /window\.addEventListener\("pointermove", updateSlotPointerDrag, \{ capture: true \}\);/);
  assert.match(source, /window\.addEventListener\("pointerup", finishSlotPointerDrag, \{ capture: true \}\);/);
  assert.match(source, /slotIndexFromPoint\(document, event\.clientX, event\.clientY\)/);
});

test("macOS pointer reordering arms after movement so title menu clicks remain clickable", () => {
  const beginBlock = sourceBlock("const beginSlotPointerDrag", "const suppressSlotPointerClick");
  const moveBlock = sourceBlock("const updateSlotPointerDrag", "const finishSlotPointerDrag");

  assert.doesNotMatch(beginBlock, /setSlotPointerDragIndex\(index\)/);
  assert.doesNotMatch(beginBlock, /setPointerCapture\(event\.pointerId\)/);
  assert.match(moveBlock, /drag\.dragging = true;[\s\S]*setSlotPointerDragIndex\(drag\.from\);/);
});

test("Dashboard shows pointer drag source and target feedback in the macOS app shell", () => {
  assert.match(source, /const \[slotPointerDragIndex, setSlotPointerDragIndex\] = useState<number \| null>\(null\);/);
  assert.match(source, /const \[slotPointerTargetIndex, setSlotPointerTargetIndex\] = useState<number \| null>\(null\);/);
  assert.match(source, /setSlotPointerDragIndex\(drag\.from\);/);
  // The hovered slot is tracked on the drag record so the drop can land on the
  // highlighted target, and the highlight never points back at the source.
  assert.match(source, /drag\.target = target === drag\.from \? null : target;/);
  assert.match(source, /setSlotPointerTargetIndex\(drag\.target\);/);
  assert.match(source, /setSlotPointerDragIndex\(null\);/);
  assert.match(source, /setSlotPointerTargetIndex\(null\);/);
  assert.match(source, /slotPointerDragIndex !== null \? "is-slot-pointer-dragging" : ""/);
  assert.match(
    source,
    /className=\{`terminal-slot \$\{focused \? "is-focused" : ""\} \$\{gridFocusTarget \? "is-grid-focus" : ""\} \$\{cmdFocusTarget \? "is-cmd-focus-target" : ""\} \$\{\s*slotPointerTargetIndex === index \? "is-slot-drop-target" : ""\s*\}`\}/,
  );
  assert.match(source, /const slotHeadClassName = \[[\s\S]*"slot-head"[\s\S]*slotPointerDragIndex === index \? "is-slot-dragging" : ""/);
  assert.match(source, /className=\{slotHeadClassName\}/);
  assert.match(css, /\.session-workspace\.is-slot-pointer-dragging,/);
  assert.match(css, /\.session-workspace\.is-slot-pointer-dragging \* \{/);
  assert.match(css, /\.slot-head\.is-slot-dragging \{/);
  assert.match(css, /\.terminal-slot\.is-slot-drop-target \{/);
  assert.match(css, /\.terminal-slot\.is-slot-drop-target \.slot-head \{/);
  assert.match(css, /cursor: grabbing !important;/);
  const draggingHeadRule = cssRuleFor(".slot-head.is-slot-dragging");
  const dropTargetRule = cssRuleFor(".terminal-slot.is-slot-drop-target");
  const dropTargetHeadRule = cssRuleFor(".terminal-slot.is-slot-drop-target .slot-head");
  for (const rule of [draggingHeadRule, dropTargetRule]) {
    assert.match(rule, /outline: 2px solid var\(--accent\);/);
    assert.match(rule, /outline-offset: -2px;/);
    assert.match(rule, /background: rgba\(var\(--accent-rgb\), 0\.12\);/);
    assert.match(rule, /box-shadow: inset 0 -1px 0 rgba\(var\(--accent-rgb\), 0\.38\);/);
  }
  assert.match(dropTargetHeadRule, /background: rgba\(var\(--accent-rgb\), 0\.12\);/);
  assert.doesNotMatch(cssRuleFor(".slot-head.is-slot-dragging"), /border:/);
  assert.doesNotMatch(cssRuleFor(".terminal-slot.is-slot-drop-target"), /border:/);
});

test("Dashboard does not trigger terminal layout sync only because focus changed", () => {
  assert.match(source, /const terminalLayoutSlotCount = viewport\.mobile \? 1 : overviewDesktopMode;/);
  assert.match(source, /const terminalLayoutKey = `\$\{terminalLayoutSlotCount\}:\$\{viewport\.width\}x\$\{viewport\.height\}`;/);
  assert.doesNotMatch(source, /const terminalLayoutKey = `\$\{workspaceSlotCount\}:/);
  assert.match(source, /layoutSyncKey=\{terminalLayoutKey\}/);
  assert.doesNotMatch(source, /fontSizeFor\(focused\)/);
  assert.match(source, /const terminalDisplay = resolveDashboardTerminalDisplay\(\{ focusedKey \}\);/);
  assert.match(sessionSlotSource, /readonly terminalReadableFit: boolean;/);
  assert.match(dashboardSource, /terminalReadableFit: terminalDisplay\.readableFit/);
  assert.match(dashboardSource, /fontSize: terminalDisplay\.fontSize/);
  assert.match(sessionSlotSource, /readableFit=\{terminalReadableFit\}/);
  assert.doesNotMatch(sessionSlotSource, /readableFit=\{focused\}/);
  const hiddenFocusedRule = cssRuleFor(".session-workspace.is-focused .terminal-slot:not(.is-focused)");
  const visibleFocusedRule = cssRuleFor(".session-workspace.is-focused .terminal-slot.is-focused");
  assert.match(hiddenFocusedRule, /position: fixed;/);
  assert.match(hiddenFocusedRule, /inset: 0;/);
  // Edge-to-edge, so the resting card's elevation is switched off rather than
  // left to paint a shadow against nothing.
  assert.match(visibleFocusedRule, /box-shadow: none;/);
});

test("Dashboard defines app-shell shortcuts without overriding browser defaults", () => {
  assert.match(keyboardSource, /import \{ isMacTauri \} from "\.\/runtime\.ts";/);
  assert.match(androidBackSource, /import \{ isTauri \} from "\.\/runtime\.ts";/);
  assert.match(androidBackSource, /if \(!isTauri\(\)\) \{\s*return;\s*\}/);
  assert.match(source, /resolveDashboardShortcutAction\(\{/);
  assert.match(source, /isMacTauri: macTauri,/);
});

test("Dashboard ignores app shortcuts while editing text or using a dialog", () => {
  assert.match(source, /function isEditableShortcutTarget\(target: EventTarget \| null\): boolean/);
  assert.match(source, /target instanceof HTMLInputElement/);
  assert.match(source, /target instanceof HTMLTextAreaElement/);
  assert.match(source, /target instanceof HTMLSelectElement/);
  assert.match(source, /element\.closest\('\[contenteditable=true\], \[role="dialog"\]'\)/);
});

test("Dashboard lets terminal textarea focus use app shortcuts", () => {
  assert.match(source, /if \(isTerminalShortcutTarget\(target\)\) \{\s*return false;\s*\}/);
});

test("Dashboard leaves Ctrl shortcuts and browser defaults untouched", () => {
  assert.match(source, /function isTerminalShortcutTarget\(target: EventTarget \| null\): boolean/);
  assert.match(source, /const targetIsTerminal = isTerminalShortcutTarget\(event\.target\);/);
  assert.match(source, /metaKey: event\.metaKey,/);
  assert.match(source, /ctrlKey: event\.ctrlKey,/);
});

test("Dashboard handles shortcut actions", () => {
  assert.match(source, /case "create":\s*setShowCreate\(true\);/);
  assert.match(source, /case "reconnect":\s*reconnectFocusedSession\(\);/);
  assert.match(source, /case "repair-sessions":\s*void repairSessions\(\);/);
  assert.match(source, /case "rename":\s*renameFocusedSession\(\);/);
  // Stepping the grid leaves Auto and steps from whatever count is showing.
  assert.match(source, /case "layout-decrease":[\s\S]*?stepLayoutMode\(autoLayout \? autoDesktopMode : current, -1\)\);\s*setAutoLayout\(false\);/);
  assert.match(source, /case "layout-increase":[\s\S]*?stepLayoutMode\(autoLayout \? autoDesktopMode : current, 1\)\);\s*setAutoLayout\(false\);/);
  assert.match(source, /case "usage":\s*onUsage\(\);/);
  assert.match(source, /case "close":\s*void closeFocusedSession\(\);/);
  assert.match(source, /case "toggle-focus":\s*toggleFocusList\(\);/);
  assert.match(source, /case "retitle":\s*void retitleFocusedSession\(\);/);
  assert.match(source, /case "session-prev":\s*focusAdjacentSession\(-1\);/);
  assert.match(source, /case "session-next":\s*focusAdjacentSession\(1\);/);
  assert.match(dashboardSource, /autoDesktopMode: displayedDesktopMode,/);
});

test("Dashboard shows the focused session ordinal next to Back", () => {
  // Dashboard computes each slot's position in the shortcut ordering and passes it down.
  assert.match(dashboardSource, /sessionOrdinal,/);
  assert.match(dashboardSource, /sessionCount: shortcutSessionKeys\.length/);
  // SessionSlot renders it only in the focused header, now as a picker trigger.
  assert.match(sessionSlotSource, /readonly sessionOrdinal: number \| null;/);
  assert.match(sessionSlotSource, /className="[^"]*slot-ordinal slot-ordinal-trigger"/);
  assert.match(sessionSlotSource, /slot && sessionOrdinal && sessionCount > 1/);
  assert.match(css, /\.slot-ordinal \{/);
});

test("Dashboard overview pagination stays separate from prompt targeting and restores grid focus", () => {
  assert.match(source, /const \[promptTargetKey, setPromptTargetKey\] = useState<string \| null>\(null\);/);
  assert.match(source, /resolveSessionNavigatorSelection\(\{/);
  assert.match(source, /if \(action\.kind === "focus-grid"\) \{\s*requestPromptTargetFocus\(action\.sessionKey\);/);
  assert.match(source, /overviewRestorePromptTargetKeyRef\.current = action\.restorePromptTargetKey;/);
  assert.match(source, /const leaveFocusedSession = useCallback\(\(\) => \{[\s\S]*?requestPromptTargetFocus\(restoreKey\);/);
  assert.match(source, /focusedKey === null \? \(\s*<SessionListNavigator/);
  assert.match(
    source,
    /filteredGridSessionKeys\(\{\s*filteredSessionKeys: overviewFilteredSessions\.map\(sessionKey\),\s*slotSessionKeys: focusedGridSlots,/,
  );
  assert.match(
    source,
    /setPromptTargetKey\(\(current\) => resolveOverviewPromptTargetForPage\(\{/,
  );
  assert.match(
    source,
    /pageSessionKeys: overviewPage\.sessionKeys,/,
  );
  assert.doesNotMatch(source, /contextLabel="Prompt target"/);
});

test("Dashboard exposes focused-session previous and next controls around the ordinal", () => {
  // The buttons use the same circular ordering as the keyboard shortcuts.
  // A phone Conversation reply in flight keeps its session (#892).
  assert.match(dashboardSource, /onFocusPrevious: \(\) => \{ if \(!phoneConversationLocked\) focusAdjacentSession\(-1\); \}/);
  assert.match(dashboardSource, /onFocusNext: \(\) => \{ if \(!phoneConversationLocked\) focusAdjacentSession\(1\); \}/);
  assert.match(sessionSlotSource, /readonly onFocusPrevious: \(\) => void;/);
  assert.match(sessionSlotSource, /readonly onFocusNext: \(\) => void;/);
  assert.match(sessionSlotSource, /aria-label="Previous session"/);
  assert.match(sessionSlotSource, /aria-label="Next session"/);
  assert.match(css, /\.slot-session-nav \{/);
  assert.match(css, /\.slot-session-nav-icon \{/);
});

test("Dashboard surfaces ⌘P retitle progress as slot feedback", () => {
  // Working state on trigger, resolved state from the summarizer result.
  assert.match(autoTitleControllerSource, /const result = await applyManualRetitleSummary\(\{/);
  assert.match(autoTitleControllerSource, /result === "updated"/);
  // Passed down and rendered in the slot header (visible while focused).
  assert.match(dashboardSource, /retitleState,/);
  assert.match(sessionSlotSource, /readonly retitleState: /);
  assert.match(sessionSlotSource, /retitle-feedback \$\{retitleState\}/);
  assert.match(css, /\.retitle-feedback \{/);
});

test("Dashboard ⌘F toggles between the list and the selected session", () => {
  // Keeps overview selection separate from fullscreen focus.
  assert.match(source, /const lastFocusedKeyRef = useRef<string \| null>\(null\);/);
  assert.match(source, /const \[promptTargetKey, setPromptTargetKey\] = useState<string \| null>\(null\);/);
  assert.match(source, /if \(focusedKey !== null\) \{\s*lastFocusedKeyRef\.current = focusedKey;/);
  assert.match(source, /const toggleFocusList = useCallback\(\(\) => \{/);
  // In a session -> back to list; in the list -> re-enter selected/active/remembered/first.
  assert.match(source, /if \(focusedKey !== null\) \{\s*leaveFocusedSession\(\);\s*return;/);
  assert.match(source, /resolveToggleFocusTarget\(\{/);
  assert.match(source, /selectedKey: sessionShortcutTarget\(\)/);
  assert.match(source, /openSessionByShortcutIndex\(shortcutSessionKeys\.indexOf\(target\)\)/);
  assert.match(source, /const cmdFocusTargetKey = useMemo\(\(\) => \{/);
  assert.match(source, /promptTargetKey && overviewPage\.sessionKeys\.includes\(promptTargetKey\)/);
  assert.match(
    source,
    /const promptTargetSessionKeys = focusedKey === null\s*\? overviewPage\.sessionKeys\s*: sessionNavGridKeys;/,
  );
  assert.match(source, /const notePromptTargetFocus = useCallback\(\(key: string\) => \{/);
  assert.match(
    source,
    /setPromptTargetKey\(\(currentPromptTargetKey\) => resolveOverviewPromptTargetFocus\(\{[\s\S]*?focusedSessionKey: focusedKey,[\s\S]*?gridSessionKeys: promptTargetSessionKeys,/,
  );
  assert.match(source, /cmdFocusTarget: Boolean\(!viewport\.mobile && slot && cmdFocusTargetKey === slot\)/);
  assert.match(sessionSlotSource, /readonly cmdFocusTarget: boolean;/);
  assert.match(sessionSlotSource, /\$\{cmdFocusTarget \? "is-cmd-focus-target" : ""\}/);
  assert.match(sessionSlotSource, /rememberSessionInteraction\(slot\);/);
  assert.match(source, /mobile: width <= 760 \|\| \(coarse && width <= 1024\)/);
  const cmdFocusTargetOverlayRule = cssRuleFor(".session-workspace.desktop .terminal-slot.is-cmd-focus-target::after,\n.session-workspace.desktop .terminal-slot.is-grid-focus::after");
  assert.doesNotMatch(css, /\.terminal-slot\.is-cmd-focus-target \{/);
  assert.doesNotMatch(css, /(^|\n)\.terminal-slot\.is-cmd-focus-target::after/);
  assert.match(cmdFocusTargetOverlayRule, /content: "";/);
  assert.match(cmdFocusTargetOverlayRule, /position: absolute;/);
  assert.match(cmdFocusTargetOverlayRule, /inset: 0;/);
  assert.match(cmdFocusTargetOverlayRule, /pointer-events: none;/);
  assert.match(cmdFocusTargetOverlayRule, /border: 1px solid var\(--accent\);/);
  assert.match(cmdFocusTargetOverlayRule, /border-radius: inherit;/);
  assert.match(cmdFocusTargetOverlayRule, /background: transparent;/);
});

test("Dashboard ⌘P manually regenerates the session title via the LLM summarizer", () => {
  assert.match(source, /const retitleFocusedSession = useCallback\(async \(\) => \{/);
  assert.match(source, /const key = focusedKey \?\? activeTerminalSlotKey\(\);/);
  // Uses a dedicated manual retitle flow so it does not send an empty prompt.
  assert.match(source, /await applyManualRetitleSummary\(\{/);
  const manualBlock = callBlock("applyManualRetitleSummary");
  assert.match(
    manualBlock,
    /\.\.\.makeAutoTitleDeps\(key, \{[\s\S]*?token,[\s\S]*?expectedTitleRevision: titleRevisionsRef\.current\.get\(key\),[\s\S]*?expectedSessionIncarnation: session\.session_incarnation,[\s\S]*?expectedSessionTitle: session\.title \?\? null,[\s\S]*?\}\),/,
  );
  assert.doesNotMatch(manualBlock, /isDisabled/);
  // The shared "refetch current title" helper is bundled into common auto-title deps.
  assert.match(source, /const fetchLiveTitle = useCallback\(/);
  assert.match(source, /const makeAutoTitleDeps = useCallback\(/);
  assert.match(source, /currentTitle = \(\) => fetchLiveTitle\(key\),/);
});

test("Dashboard auto-layout sizes the desktop grid to the session count, off by default", () => {
  // Opt-in flag, persisted per-device; existing users keep their fixed grid.
  assert.match(dashboardSource, /const AUTO_STORAGE = "agent-console\.layout\.auto";/);
  assert.match(dashboardSource, /const \[autoLayout, setAutoLayout\] = useState<boolean>\(\(\) => readAutoLayout\(\)\);/);
  assert.match(dashboardSource, /return localStorageGetItem\(AUTO_STORAGE\) === "1";/);
  assert.match(dashboardSource, /localStorageSetItem\(AUTO_STORAGE, autoLayout \? "1" : "0"\);/);
  // Desktop grid size follows the session count when Auto is on.
  assert.match(dashboardSource, /const autoDesktopMode = autoLayoutMode\(visible\.length\);/);
  assert.match(dashboardSource, /:\s*autoLayout\s*\?\s*autoDesktopMode\s*:\s*layoutMode;/);
  assert.match(dashboardSource, /resolveOverviewSessionListPageSize\(\{/);
  assert.match(dashboardSource, /resolveOverviewDesktopMode\(\{/);
});

test("Dashboard delegates responsive layout controls while keeping the grid ladder", () => {
  assert.match(dashboardSource, /<LayoutPicker auto=\{autoLayout\}/);
  assert.match(dashboardSource, /setAutoLayout\(false\); setLayoutMode\(mode\);/);
  // CSS: the new 1-pane desktop grid + the segmented control + icon sizing.
  const oneRule = cssRuleFor(".session-workspace.desktop.mode-1");
  assert.match(oneRule, /grid-template-columns: minmax\(0, 1fr\);/);
  // Mode 3: the first slot fills the left half; the other two stack on the right.
  const threeRule = cssRuleFor(".session-workspace.desktop.mode-3");
  assert.match(threeRule, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(threeRule, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(
    cssRuleFor(".session-workspace.desktop.mode-3 > .terminal-slot:first-child"),
    /grid-row: 1 \/ span 2;/,
  );
  const fiveRule = cssRuleFor(".session-workspace.desktop.mode-5");
  assert.match(fiveRule, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(fiveRule, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\);/);
  // Reading-order fill: a column-major flow would visually swap panes when
  // Auto steps from six panes to five.
  assert.doesNotMatch(fiveRule, /grid-auto-flow/);
  assert.equal(
    (css.match(/\.session-workspace\.desktop\.mode-5\s*\{/g) ?? []).length,
    1,
    "the five-pane 1-2-2 grid must remain intact at every desktop width",
  );
  assert.match(
    cssRuleFor(".session-workspace.desktop.mode-5 > .terminal-slot:first-child"),
    /grid-row: 1 \/ span 2;/,
  );
  assert.match(css, /\.layout-seg \{/);
  assert.match(css, /\.layout-seg-btn\.is-active \{/);
  assert.match(css, /\.layout-icon \{/);

  // Auto's resolved pane count uses a radius-aware border overlay so all four
  // corners stay even, including when the marker reaches the segment edge.
  const autoCurrentRule = cssRuleFor(".layout-seg-btn.is-auto-current");
  const autoCurrentOverlayRule = cssRuleFor(".layout-seg-btn.is-auto-current::after");
  assert.match(autoCurrentRule, /position: relative;/);
  assert.doesNotMatch(autoCurrentRule, /box-shadow:/);
  assert.match(autoCurrentOverlayRule, /content: "";/);
  assert.match(autoCurrentOverlayRule, /position: absolute;/);
  assert.match(autoCurrentOverlayRule, /inset: 0;/);
  assert.match(autoCurrentOverlayRule, /pointer-events: none;/);
  assert.match(autoCurrentOverlayRule, /border: 1px solid var\(--accent\);/);
  assert.match(autoCurrentOverlayRule, /border-radius: inherit;/);
  assert.match(autoCurrentOverlayRule, /background: transparent;/);
});

test("Dashboard header retires the machine pill and gates the machine filter", () => {
  // The mesa on/off toggle moved to Settings; no pill in the header anymore.
  assert.doesNotMatch(dashboardSource, /machine-toggle/);
  assert.doesNotMatch(dashboardSource, /isMachineToggleable/);
  // The opt-in state was lifted to App; Dashboard receives the enabled set.
  assert.match(dashboardSource, /readonly enabledMachines: readonly string\[\];/);
  assert.match(dashboardSource, /readonly machineColors: MachineColorMap;/);
  assert.doesNotMatch(dashboardSource, /const \[optInMachines/);
  // Overview filtering lives in the picker; focused terminals retain the
  // separate host control once more than the primary is enabled.
  assert.match(dashboardSource, /\{focusedKey !== null && enabledMachines\.length > 1 \? \(/);
});

test("Dashboard machine filter keeps a visible focus indicator in forced colors", () => {
  assert.match(
    css,
    /@media \(forced-colors: active\) \{[\s\S]*?\.machine-filter:focus-within \{[\s\S]*?outline: 2px solid Highlight;/,
  );
});

test("Dashboard header groups controls and routes Settings through the overflow menu", () => {
  // The gear moved into HeaderMenu (see headerMenu.test.ts); the dashboard now
  // mounts the overflow menu and forwards onSettings to it.
  assert.match(dashboardSource, /import \{ HeaderMenu \} from "\.\/HeaderMenu\.tsx";/);
  assert.doesNotMatch(dashboardSource, /<GearIcon \/>/);
  assert.match(dashboardSource, /<HeaderMenu[\s\S]*?onSettings=\{onSettings\}/);
  assert.match(dashboardSource, /className="dash-group"/);
  assert.match(css, /\.dash-group \{/);
  // Sign out moved to Settings > Account; it is no longer a header button.
  assert.doesNotMatch(dashboardSource, /onClick=\{signOut\}/);
});

test("Dashboard handles macOS session navigation shortcuts", () => {
  assert.match(source, /const openSessionByShortcutIndex = useCallback\(\(index: number\) => \{/);
  assert.match(source, /\(\) => overviewFilteredSessions\.map\(sessionKey\)/);
  assert.match(source, /const key = shortcutSessionKeys\[index\];[\s\S]*?enterSession\(key, sessionsByKey\.get\(key\)\?\.machine\);/);
  assert.match(source, /case "back":\s*setFocusedKey\(null\);/);
  assert.match(source, /shortcutAction\.startsWith\("open-"\)/);
  assert.match(source, /openSessionByShortcutIndex\(Number\(shortcutAction\.slice\("open-"\.length\)\) - 1\);/);
});

test("Dashboard focused session navigation does not rewrite fixed layout slots", () => {
  const openByShortcut = sourceBlock(
    "const openSessionByShortcutIndex = useCallback((index: number) => {",
    "  }, [enterSession, sessionsByKey, shortcutSessionKeys]);",
  );
  assert.doesNotMatch(openByShortcut, /setSlots\(/);
  assert.doesNotMatch(openByShortcut, /assignSlot\(/);
  assert.match(dashboardSource, /if \(index < 0 \|\| index >= slotsRef\.current\.length\) \{/);
  assert.match(dashboardSource, /const hiddenFocusedSlot = focusedKey && !focusedGridSlots\.includes\(focusedKey\) \? focusedKey : null;/);
  // Desktop still appends the hidden focused slot rather than rewriting the
  // fixed layout slots; mobile mounts a terminal only for the focused session
  // (the overview is MobileSessionList), so at most one live terminal runs.
  assert.match(dashboardSource, /const renderSlots = viewport\.mobile/);
  assert.match(dashboardSource, /\? focusedKey\s*\?\s*\[focusedKey\]\s*:\s*\[\]/);
  assert.match(
    dashboardSource,
    /: hiddenFocusedSlot\s*\?\s*\[\.\.\.focusedGridSlots, hiddenFocusedSlot\]\s*:\s*focusedKey\s*\?\s*focusedGridSlots\s*:\s*overviewDesktopSlots;/,
  );
});

test("Dashboard auto-dismisses completed repair banners without clearing newer messages", () => {
  assert.match(source, /repairMessageAutoDismissDelay/);
  assert.match(source, /repairMessageAfterAutoDismiss/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /const scheduledMessage = repairMessage;/);
  assert.match(source, /setRepairMessage\(\(current\) => repairMessageAfterAutoDismiss\(current, scheduledMessage\)\);/);
  assert.match(source, /return \(\) => clearTimeout\(timer\);/);
});

test("Dashboard confirms the planned repair before using the existing execution seam", () => {
  assert.match(source, /planSessionRepairs/);
  assert.match(source, /const result = await executeSessionRepairPlan\(\{/);
  assert.doesNotMatch(source, /decideSessionRepairAction/);
  assert.match(source, /setPendingRepair/);
  assert.match(source, /ariaLabelledby="repair-session-title"/);
});

test("Dashboard renders repair status as overlay so session panes do not resize", () => {
  assert.match(source, /className="repair-toast-layer"/);
  assert.match(source, /className=\{`repair-toast is-\$\{repairToastMessage\.intent\}`\}/);
  assert.match(source, /repairToastMessage\.text/);
  assert.match(source, /View failures/);
  assert.match(source, /setRepairMessage\(null\)/);
  assert.doesNotMatch(source, /repairToastMessage \? <p className="banner info"/);
  const headRule = cssRuleFor(".dash-head");
  assert.match(headRule, /position: relative;/);
  const layerRule = cssRuleFor(".repair-toast-layer");
  assert.match(layerRule, /position: absolute;/);
  assert.match(layerRule, /top: calc\(100% \+ 0\.35rem\);/);
  assert.match(layerRule, /pointer-events: none;/);
  assert.match(cssRuleFor(".repair-toast"), /pointer-events: auto;/);
  assert.ok(zIndexFor(".terminal-slot:has(.slot-title-menu[open])") > zIndexFor(".repair-toast-layer"));
  assert.ok(zIndexFor(".repair-toast-layer") < zIndexFor(".slot-title-dropdown"));
});

test("Dashboard resolves rename shortcut from focused pane or active terminal", () => {
  assert.match(source, /const key = focusedKey \?\? activeTerminalSlotKey\(\);/);
  assert.match(source, /closest<HTMLElement>\("\.terminal-slot"\)\?\.dataset\.slotKey/);
  assert.match(source, /data-slot-key=\{slot \?\? undefined\}/);
});

test("Dashboard close shortcut confirms with title and repo context", () => {
  assert.match(source, /function CloseSessionDialog\(\{/);
  assert.match(source, /<Modal[\s\S]*?className="close-session-modal"/);
  assert.match(source, /Close Session/);
  assert.match(source, /sessionLabel\(session\)/);
  assert.match(source, /sessionRepoLabel\(session\)/);
  assert.match(source, /const \[closeConfirmSession, setCloseConfirmSession\] = useState<Session \| null>\(null\);/);
  assert.match(source, /const beginCloseSessionConfirm = useCallback\(\(session: Session\) => \{/);
  assert.match(source, /setCloseConfirmSession\(session\);/);
  assert.match(source, /const confirmCloseSessionDelete = useCallback\(async \(\) => \{/);
  assert.match(source, /const deleted = await closeSession\(session\);/);
  assert.match(source, /beginCloseSessionConfirm\(s\);/);
  assert.match(source, /const closeFocusedSession = useCallback\(async \(\) => \{/);
  assert.match(source, /const key = focusedKey \?\? activeTerminalSlotKey\(\);/);
  assert.match(source, /beginCloseSessionConfirm\(session\);/);
  assert.match(source, /await killSession\(session\.machine, session\.id\);/);
  assert.doesNotMatch(source, /@tauri-apps\/plugin-dialog/);
  assert.doesNotMatch(source, /window\.confirm/);
});

test("Dashboard close flow only removes sessions after a successful delete", () => {
  assert.match(source, /result = await killSession\(session\.machine, session\.id\);/);
  // killSession can reject on a network failure, so the kill is wrapped and a
  // thrown error is routed to the banner (not just the ok:false path).
  assert.match(source, /catch \(err\)[\s\S]*?setCloseDeleteError\(message\);[\s\S]*?return false;/);
  assert.match(source, /if \(!result\.ok\) \{[\s\S]*?inspectFailedSession\(session, "delete", message, false\);[\s\S]*?return false;/);
  assert.match(source, /const nextSessions = sessionsRef\.current\.filter\(\(item\) => !removedKeys\.has\(sessionKey\(item\)\)\);/);
  assert.match(source, /void persistLayoutLocalOrder\(/);
});

test("Dashboard close completion does not clear newer focused sessions", () => {
  assert.match(source, /setFocusedKey\(\(current\) => \(current !== null && removedKeys\.has\(current\) \? null : current\)\);/);
  assert.match(source, /const removeSessionLocally = useCallback\(\(session: Session\) => \{[\s\S]*?\}, \[removeSessionsLocally\]\);/);
  assert.doesNotMatch(source, /if \(focusedKey === key\) \{\s*setFocusedKey\(null\);/);
});

test("Dashboard modal overlays focused terminal sessions", () => {
  assert.ok(
    zIndexFor(".modal-backdrop") > zIndexFor(".session-workspace.is-focused .terminal-slot.is-focused"),
  );
});

test("Dashboard close confirmation uses the styled danger modal", () => {
  assert.match(css, /\.close-session-modal \{/);
  assert.match(cssRuleFor(".close-session-modal"), /border-radius: var\(--r-md\);/);
  assert.match(cssRuleFor(".close-session-modal"), /background: var\(--surface-dialog\);/);
  assert.match(cssRuleFor(".close-session-summary"), /background: var\(--dialog-row-bg\);/);
  assert.match(cssRuleFor(".close-session-summary"), /border: 1px solid var\(--dialog-row-border\);/);
  assert.match(cssRuleFor(".close-session-summary"), /border-left: 3px solid rgba\(var\(--danger-rgb\), 0\.75\);/);
  assert.match(cssRuleFor(".close-session-delete-option"), /min-height: 48px;/);
  assert.match(
    cssRuleFor(".close-session-delete-option.is-selected"),
    /border-color: rgba\(var\(--danger-rgb\), 0\.72\);/,
  );
  assert.match(cssRuleFor(".btn.danger"), /color: var\(--danger-fg\);/);

});

test("Dashboard slot header uses the accessible semantic activity cluster", () => {
  assert.match(sessionSlotSource, /<SessionActivityPopover/);
  assert.match(sessionActivityPopoverSource, /selectSessionActivity\(\{/);
  assert.match(sessionActivityPopoverSource, /useSharedClock\(/);
  assert.doesNotMatch(dashboardSource, /useSharedClock\(/);
  assert.match(cssRuleFor(".session-activity-trigger"), /min-height: var\(--icon-compact-size\)/);
  assert.match(
    css,
    /\.activity-working \.session-activity-glyph,\s*\.activity-working-attention \.session-activity-glyph\s*\{[^}]*background: var\(--ok\)/,
  );
  assert.match(cssRuleFor(".activity-waiting .session-activity-glyph"), /border-color: var\(--accent\)/);
  assert.match(cssRuleFor(".activity-completed"), /background: rgba\(var\(--accent-rgb\), 0\.12\)/);
  assert.match(cssRuleFor(".activity-completed"), /font-weight: var\(--weight-bold\)/);
  assert.match(cssRuleFor(".activity-completed .session-activity-glyph"), /background: var\(--accent\)/);
  assert.match(cssRuleFor(".activity-completed .session-activity-glyph::after"), /content: "✓"/);
  assert.match(cssRuleFor(".activity-needs-input"), /color: var\(--warn\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
