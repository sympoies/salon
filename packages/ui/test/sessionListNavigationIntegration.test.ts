import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  makeCssRuleLookup,
  sourceBlock,
  uiSource,
  uiStyles,
} from "./support/source.ts";

const dashboardSource = uiSource("Dashboard.tsx");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const mobileSource = uiSource("MobileSessionList.tsx");
const layoutSyncSource = uiSource("useLayoutSync.ts");
const styles = uiStyles();
const filtersSource = uiSource("SessionFiltersBar.tsx");
const historySource = uiSource("HistoryPanel.tsx");
const debugSource = uiSource("DebugPanel.tsx");
const cssRuleFor = makeCssRuleLookup(styles);

test("Dashboard uses a dedicated overview navigator while focused slots retain SessionPager", () => {
  assert.match(
    dashboardSource,
    /import \{ SessionListNavigator \} from "\.\/SessionListNavigator\.tsx";/,
  );
  assert.match(dashboardSource, /focusedKey === null[\s\S]*?<SessionListNavigator/);
  assert.doesNotMatch(
    dashboardSource,
    /focusedKey === null[\s\S]{0,500}?<SessionPager/,
  );
  assert.match(sessionSlotSource, /s && focused[\s\S]*?<SessionPager/);
  assert.match(sessionSlotSource, /onPrevious=\{onFocusPrevious\}/);
  assert.match(sessionSlotSource, /onNext=\{onFocusNext\}/);
  assert.match(sessionSlotSource, /onSelect=\{onFocusSession\}/);
});

test("layout sync exposes a complete relative order rather than only current slots", () => {
  assert.match(
    layoutSyncSource,
    /readonly orderedSessionKeys: readonly string\[\];/,
  );
  assert.match(
    layoutSyncSource,
    /orderedSessionKeys:/,
  );
  assert.match(
    dashboardSource,
    /orderedSessionKeys: layoutSessionKeys/,
  );
  assert.match(
    dashboardSource,
    /orderSessionListSessions\(\{\s*sessions: visible,\s*preferredSessionKeys: layoutSessionKeys,/,
  );
});

test("page transitions update page state without entering sessions or mutating slots", () => {
  const previousPage = sourceBlock(
    dashboardSource,
    "  const goToPreviousSessionListPage = useCallback(() => {",
    "  }, [",
  );
  const nextPage = sourceBlock(
    dashboardSource,
    "  const goToNextSessionListPage = useCallback(() => {",
    "  }, [",
  );

  for (const block of [previousPage, nextPage]) {
    assert.match(block, /setSessionListPage/);
    assert.doesNotMatch(block, /enterSession/);
    assert.doesNotMatch(block, /onOverviewSession/);
    assert.doesNotMatch(block, /requestPromptTargetFocus/);
    assert.doesNotMatch(block, /setSlots/);
    assert.doesNotMatch(block, /assignSlot/);
    assert.doesNotMatch(block, /persistLayout/);
  }
});

test("overview drag reorders the projected complete order without enabling slot assignment", () => {
  assert.match(
    dashboardSource,
    /const reorderVisibleSlots = useCallback\([\s\S]*?reorderProjectedSessionKeys\(\{[\s\S]*?orderedSessionKeys: layoutSessionKeys,[\s\S]*?pageSessionKeys: overviewPage\.sessionKeys,/,
  );
  assert.match(
    layoutSyncSource,
    /readonly applyLayoutLocalOrder: \([\s\S]*?reason: string,[\s\S]*?\) => Promise<void> \| undefined;/,
  );
  assert.match(
    dashboardSource,
    /applyLayoutLocalOrder\(nextOrder, "reorder"\)/,
  );
  assert.match(
    dashboardSource,
    /const slotDrag = useSlotDrag\(\{\s*active,\s*mobile: viewport\.mobile,\s*setSlots,\s*onReorder: reorderVisibleSlots,/,
  );
  assert.match(
    dashboardSource,
    /slotAssignmentEnabled: slotAssignmentIndex >= 0,/,
  );
  assert.match(
    sessionSlotSource,
    /selectionEnabled=\{focused \|\| slotAssignmentEnabled\}[\s\S]*?onSlotSelect\(slotAssignmentIndex, slot, key\)/,
  );
  assert.match(
    dashboardSource,
    /if \(slotsRef\.current\[index\] !== currentKey\) \{\s*return;\s*\}[\s\S]*?if \(value === NEW_SESSION\)/,
  );
  assert.match(
    sessionSlotSource,
    /slotAssignmentEnabled && open \? options\.map\([\s\S]*?\) : null\}/,
  );
});

test("confirmed layout snapshots invalidate the derived complete order", () => {
  assert.match(
    layoutSyncSource,
    /const \[lastSentLayoutOrder, setLastSentLayoutOrder\] = useState<LayoutStoreSnapshot \| null>\(null\);/,
  );
  const publishSnapshot = sourceBlock(
    layoutSyncSource,
    "      setSnapshot:",
    "      getKnownMachines:",
  );
  assert.match(publishSnapshot, /const source = intent\.localOrderPlacement && confirmed/);
  assert.match(publishSnapshot, /acceptLayoutSnapshot\(snapshot, source\);/);
  assert.match(
    layoutSyncSource,
    /lastSentLayoutOrderRef\.current = snapshot;\s*setLastSentLayoutOrder\(snapshot\);\s*setServerLayoutOrder\(snapshot\);/,
  );
  assert.match(
    layoutSyncSource,
    /\[lastSentLayoutOrder, optimisticLayoutOrder, serverLayoutOrder\]/,
  );
  assert.match(
    layoutSyncSource,
    /\[completeOrder, currentRanking, reachableMachineNames, sessions\]/,
  );
});

test("scope, machine, and page-size changes reset page while live shrink only clamps", () => {
  assert.match(
    dashboardSource,
    /setMachineFilter\([\s\S]{0,200}?setSessionListPage\(1\)/,
  );
  assert.match(
    dashboardSource,
    /useEffect\(\(\) => \{\s*setSessionListPage\(1\);\s*\}, \[sessionListPageSize\]\);/,
  );
  assert.match(
    dashboardSource,
    /setSessionListPage\(\(current\) => Math\.min\(current, overviewPage\.pageCount\)\)/,
  );
});

test("an off-page overview prompt target is cleared without choosing a replacement", () => {
  assert.match(
    dashboardSource,
    /resolveOverviewPromptTargetForPage\(\{\s*promptTargetKey: current,\s*pageSessionKeys: overviewPage\.sessionKeys,/,
  );
  assert.match(
    dashboardSource,
    /setPromptTargetKey\(\(current\) => resolveOverviewPromptTargetForPage/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /resolveOverviewPromptTargetForPage\([\s\S]{0,300}?overviewPage\.sessionKeys\[0\]/,
  );
});

test("a created session hidden by the overview scope opens focused instead of receiving invisible grid focus", () => {
  assert.match(
    dashboardSource,
    /const overviewIncludesCreatedSession = overviewFilteredSessions\.some\(/,
  );
  assert.match(
    dashboardSource,
    /const hasSlotCapacity = \(projected\.includes\(pendingKey\)[\s\S]{0,180}?pendingCreatedGridPageRef\.current === overviewPage\.page\)\)[\s\S]{0,180}?&& overviewIncludesCreatedSession[\s\S]{0,180}?&& overviewPage\.sessionKeys\.includes\(pendingKey\);/,
  );
  assert.match(
    dashboardSource,
    /if \(hasSlotCapacity && !viewport\.mobile\) \{[\s\S]*?setGridFocusKey\(pendingKey\);[\s\S]*?\} else \{[\s\S]*?setFocusedKey\(pendingKey\);/,
  );
});

test("mobile overview receives only the current page and owns no duplicate filter state", () => {
  assert.match(
    dashboardSource,
    /<MobileSessionList\s+sessions=\{overviewPageSessions\}/,
  );
  assert.doesNotMatch(mobileSource, /selectedSessionListRunId/);
  assert.doesNotMatch(mobileSource, /showSubagentsInOverview/);
  assert.doesNotMatch(mobileSource, /sessionListPage/);
  assert.match(mobileSource, /\{sessions\.map\(\(session\)/);
});

test("desktop navigator stays compact and long group labels shrink safely", () => {
  const navigatorRule = cssRuleFor(".session-list-navigator");
  const pageButtonRule = cssRuleFor(".session-list-page-button");
  const pageLabelRule = cssRuleFor(".session-list-page-label");
  const triggerRule = cssRuleFor(".session-list-group-trigger");
  const labelRule = cssRuleFor(".session-list-group-trigger-label");

  assert.match(navigatorRule, /display: inline-flex;/);
  assert.match(navigatorRule, /min-width: 0;/);
  assert.match(styles, /--icon-standard-size:\s*34px;/);
  assert.match(pageButtonRule, /display: inline-grid;/);
  assert.match(pageLabelRule, /min-width: 2\.35rem;/);
  assert.doesNotMatch(pageLabelRule, /min-width: 6\.9rem;/);
  assert.match(triggerRule, /min-width: 0;/);
  assert.match(labelRule, /overflow: hidden;/);
  assert.match(labelRule, /text-overflow: ellipsis;/);
  assert.match(labelRule, /white-space: nowrap;/);
});

// The single-row layout contract is measured by headerCompaction.browser.test.ts.

test("identifier search inputs disable native spelling and capitalization transforms", () => {
  for (const [name, source, label] of [
    ["Repository filter", filtersSource, "Repository"],
    ["History metadata search", historySource, "History metadata search"],
    ["Debug search", debugSource, "Debug search"],
  ] as const) {
    const field = source.slice(source.indexOf(`aria-label="${label}"`) - 350, source.indexOf(`aria-label="${label}"`) + 220);
    assert.match(field, /autoCorrect="off"/, `${name} disables autocorrection`);
    assert.match(field, /autoCapitalize="none"/, `${name} disables autocapitalization`);
    assert.match(field, /spellCheck=\{false\}/, `${name} disables spellcheck`);
  }
});

test("mobile group picker still presents a bottom sheet", () => {
  assert.match(
    styles,
    /@media \(max-width: 760px\), \(pointer: coarse\) and \(max-width: 1024px\) \{[\s\S]*?\.session-list-group-trigger[\s\S]*?min-height: 44px;/s,
  );
  assert.match(
    styles,
    /\.session-list-group-sheet \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;[\s\S]*?max-height:/s,
  );
  assert.match(
    styles,
    /\.session-list-group-sheet[\s\S]*?min-height: 44px;/s,
  );
});

test("overview pagination never replaces the authoritative visible collection", () => {
  assert.match(
    dashboardSource,
    /useLayoutSync\(\{\s*sessions,\s*visible,\s*slotCount,/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /useLayoutSync\(\{[\s\S]{0,200}?visible: overviewPageSessions/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /reconcileSlots\(prev, overviewPageSessions/,
  );
});
