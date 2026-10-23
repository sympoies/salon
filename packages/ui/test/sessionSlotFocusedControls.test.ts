import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiSource } from "./support/source.ts";

const slotSource = uiSource("SessionSlot.tsx");
const dashSource = uiSource("Dashboard.tsx");

test("SessionSlot gives the phone focused header the card identity and harness rows", () => {
  assert.doesNotMatch(slotSource, /focusedHeaderControls/);
  assert.doesNotMatch(slotSource, /slot-focus-statusbar/);
  assert.match(slotSource, /mobileFocused \? "slot-focus-toolbar slot-focus-row-one" : "slot-focus-toolbar"/);
  assert.match(slotSource, /mobileFocused \? "slot-session-details slot-focus-row-two" : "slot-session-details"/);
  assert.match(slotSource, /className="slot-focus-actions"/);
  assert.match(slotSource, /className="slot-focus-status"/);
  assert.match(
    slotSource,
    /slot-focus-row-one[\s\S]*\{titleControlFor\(false\)\}[\s\S]*className="slot-focus-actions"[\s\S]*\{copyButton\}[\s\S]*\{closeButton\}/,
  );
  assert.match(
    slotSource,
    /slot-focus-row-two"[\s\S]*\{agentRetitleButton\}[\s\S]*<SessionModelBadge[\s\S]*className="slot-focus-status"[\s\S]*\{sessionPager\}/,
  );
  assert.match(
    slotSource,
    /className="slot-action slot-back"[\s\S]*className="slot-back-icon"[\s\S]*className="slot-back-label"/,
  );
  assert.match(slotSource, /const closeButton[\s\S]*className="slot-action danger"/);
});

test("Dashboard does not inject global More/New actions into a focused session", () => {
  assert.doesNotMatch(dashSource, /focusedHeaderControls=/);
  assert.doesNotMatch(dashSource, /focusedHeaderMenuOpen/);
  assert.doesNotMatch(dashSource, /slot-focus-actions/);
});

test("Dashboard puts the overview list navigator beside the brand before centered usage", () => {
  assert.match(slotSource, /export function SessionPager/);
  assert.match(dashSource, /focusedKey === null \? \(\s*<SessionListNavigator/);
  assert.match(
    dashSource,
    /className="workspace-head-start"[\s\S]*?<BrandTitle[\s\S]*?<SessionListNavigator[\s\S]*?<HeaderUsage onOpen=\{onUsage\} \/>/,
  );
  assert.match(dashSource, /<HeaderUsage onOpen=\{onUsage\} \/>[\s\S]*?className="dash-group dash-create-actions"/);
  assert.match(dashSource, /page=\{overviewPage\.page \?\? 1\}/);
});

test("SessionSlot lets a stopped/idle focused session swipe between sessions on mobile", () => {
  // A running focused session swipes via the terminal touch bridge (onSessionSwipe),
  // but a non-running session renders slot-session-state with no terminal — it must
  // carry its own swipe handlers so the same left/right navigation works.
  assert.match(slotSource, /useSessionSwipe/);
  assert.match(
    slotSource,
    /useSessionSwipe\(\s*mobileFocused && sessionCount > 1,[\s\S]*?direction === "previous" \? onFocusPrevious\(\) : onFocusNext\(\)/,
  );
  assert.match(
    slotSource,
    /className="slot-session-state"[\s\S]{0,80}\{\.\.\.\(sessionSwipeHandlers \?\? \{\}\)\}/,
  );
});

test("a focused session can refresh its own terminal from the toolbar", () => {
  // Reconnecting was keyboard-only, so a phone had no way to rebuild a pane that
  // had gone stale. The button reuses the shortcut's action rather than adding a
  // second reconnect path.
  assert.match(slotSource, /const refreshButton = s && focused \?/);
  assert.match(slotSource, /className="slot-action slot-refresh"/);
  // Phone Conversation reuses the button for its history (#892).
  assert.match(slotSource, /aria-label=\{showPhoneConversation \? "Refresh conversation" : `Refresh \$\{sessionLabel\(s\)\}`\}/);
  assert.match(slotSource, /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*if \(showPhoneConversation\) conversationRefreshRef\.current\?\.\(\);\s*else onReconnect\(\);/);
  assert.match(
    slotSource,
    /className="slot-focus-actions"[\s\S]*?\{refreshButton\}[\s\S]*?\{copyButton\}[\s\S]*?\{closeButton\}/,
  );
});

test("the refresh button rebuilds only the focused pane, never the repair sweep", () => {
  // repairSessions resumes every visible session; the in-session control must
  // stay scoped to the pane the user is looking at.
  assert.match(dashSource, /onReconnect: reconnectFocusedSession,/);
  assert.doesNotMatch(slotSource, /onReconnect: \(\) => void repairSessions/);
  assert.match(slotSource, /readonly onReconnect: \(\) => void;/);
});

test("desktop session header renders the refresh button before copy", () => {
  // Desktop (non-mobile focused) must show the same refresh button as mobile,
  // placed in slot-session-details before copyButton.
  assert.match(
    slotSource,
    /slot-session-details"\}[\s\S]*?\{titleControlFor\(false\)\}[\s\S]*?\{refreshButton\}\s*\{copyButton\}/,
  );
});
