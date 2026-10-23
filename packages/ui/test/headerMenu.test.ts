import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const headerMenuSource = uiSource("HeaderMenu.tsx");
const dashboardSource = uiSource("Dashboard.tsx");
const iconsSource = uiSource("icons.tsx");
const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

test("HeaderMenu collapses the secondary pages into one overflow menu", () => {
  // A single controlled <details> overflow menu with a role=menu dropdown.
  assert.match(headerMenuSource, /<details className="header-menu" open=\{open\}>/);
  assert.match(headerMenuSource, /className="header-menu-dropdown" role="menu" onKeyDown=\{menuFocus\.onKeyDown\}/);
  // The trigger is the overflow (more) glyph, announced as a menu button.
  assert.match(headerMenuSource, /import \{ GearIcon, MoreIcon \} from "\.\/icons\.tsx";/);
  assert.match(headerMenuSource, /<MoreIcon \/>/);
  assert.match(headerMenuSource, /aria-haspopup="menu"/);
  assert.match(headerMenuSource, /aria-expanded=\{open\}/);
  assert.match(
    headerMenuSource,
    /className="btn icon-btn header-menu-trigger"/,
  );
  assert.doesNotMatch(
    headerMenuSource,
    /className="btn ghost icon-btn header-menu-trigger"/,
  );
  // The trigger controls the menu itself: it suppresses the native <details>
  // toggle and drives the controlled open state (the headline open path).
  assert.match(headerMenuSource, /onClick=\{\(e\) => \{[\s\S]*?e\.preventDefault\(\);\s*onOpenChange\(!open\);/);
});

test("HeaderMenu keeps Shell above Debug and Settings last", () => {
  assert.match(headerMenuSource, /onClick=\{\(\) => select\(onHistory\)\}[\s\S]*?>\s*History\s*<\/button>/);
  assert.match(headerMenuSource, /\{historyAvailable \? \(/);
  assert.match(dashboardSource, /historyAvailable=\{historyMachineNames\.size > 0\}/);
  assert.match(headerMenuSource, /role="menuitem" tabIndex=\{-1\}[\s\S]*?onClick=\{\(\) => select\(onUsage\)\}/);
  assert.doesNotMatch(headerMenuSource, /Services|onHermes|hermesAvailable/);
  assert.match(headerMenuSource, /role="menuitem" tabIndex=\{-1\}[\s\S]*?onClick=\{\(\) => select\(onDebug\)\}/);
  assert.match(headerMenuSource, /onClick=\{\(\) => select\(onSettings\)\}/);
  // Settings keeps the gear icon as its menu-item glyph.
  assert.match(headerMenuSource, /<GearIcon \/>/);
  // Shell is directly above Debug; Settings stays last below the divider.
  assert.match(
    headerMenuSource,
    /select\(onUsage\)[\s\S]*?select\(onHistory\)[\s\S]*?select\(onShell\)[\s\S]*?select\(onDebug\)[\s\S]*?header-menu-divider[\s\S]*?select\(onSettings\)/,
  );
  assert.match(headerMenuSource, /className="header-menu-divider" role="separator"/);
  // Selecting an item closes the menu before running the action (ordering
  // matters; the exact body is intentionally not pinned).
  assert.match(headerMenuSource, /const select = [\s\S]*?close\(\);[\s\S]*?action\(\);/);
});

test("Dashboard mounts the overflow menu to the left of + New in one group", () => {
  assert.match(dashboardSource, /import \{ HeaderMenu \} from "\.\/HeaderMenu\.tsx";/);
  assert.match(dashboardSource, /import \{ [^}]*PlusIcon[^}]* \} from "\.\/icons\.tsx";/);
  // The standalone gear icon left the dashboard header (it moved into the menu).
  assert.doesNotMatch(dashboardSource, /import \{ GearIcon \}/);
  assert.match(dashboardSource, /<HeaderMenu[\s\S]*?onSettings=\{onSettings\}[\s\S]*?\/>\s*<IconButton[^>]*className="btn dashboard-new-session"/);
  assert.match(dashboardSource, /<HeaderMenu[\s\S]*?open=\{headerMenuOpen\}[\s\S]*?onOpenChange=\{setHeaderMenuOpen\}/);
  assert.match(dashboardSource, /aria-label="New session"\s*title="New session"\s*onClick=\{\(\) => setShowCreate\(true\)\}/);
  assert.doesNotMatch(dashboardSource, /dash-create-label/);

});

test("HeaderMenu retains the compact Auto action while New stays in the primary row", () => {
  assert.match(headerMenuSource, /readonly autoLayoutEnabled\?: boolean;/);
  assert.match(headerMenuSource, /readonly onAutoLayout\?: \(\) => void;/);
  assert.match(headerMenuSource, /readonly onNewSession\?: \(\) => void;/);
  assert.match(headerMenuSource, /header-menu-compact-action[\s\S]*?role="menuitemcheckbox"[\s\S]*?aria-checked=\{autoLayoutEnabled\}[\s\S]*?select\(onAutoLayout\)/);
  assert.match(headerMenuSource, /header-menu-compact-action[\s\S]*?disabled=\{newSessionDisabled\}[\s\S]*?select\(onNewSession\)/);
  assert.match(dashboardSource, /autoLayoutEnabled=\{autoLayout\}[\s\S]*?onAutoLayout=\{\(\) => setAutoLayout\(\(current\) => !current\)\}/);
  assert.match(dashboardSource, /onNewSession=\{\(\) => setShowCreate\(true\)\}[\s\S]*?newSessionDisabled=/);
  assert.match(css, /data-header-compact="5"[^}]*\.header-menu-compact-action\[role="menuitemcheckbox"\]\s*\{\s*display:flex;/);
});

test("HeaderMenu exposes the compact Auto layout state as a checked menu item", async () => {
  const harness = createUiSsrHarness();
  try {
    const { HeaderMenu } = await harness.loadModule<typeof import("../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    const render = (autoLayoutEnabled: boolean) => renderComponent(HeaderMenu, {
      open: true,
      onOpenChange() {},
      historyAvailable: false,
      onHistory() {},
      onUsage() {},
      onDebug() {},
      onSettings() {},
      autoLayoutEnabled,
      onAutoLayout() {},
    });
    assert.match(render(true), /role="menuitemcheckbox"[^>]*aria-checked="true"[^>]*>\s*Auto layout/);
    assert.match(render(false), /role="menuitemcheckbox"[^>]*aria-checked="false"[^>]*>\s*Auto layout/);
  } finally {
    await harness.close();
  }
});

test("HeaderMenu closes the overflow menu on an outside pointer or Escape", () => {
  assert.match(dashboardSource, /const \[headerMenuOpen, setHeaderMenuOpen\] = useState\(false\);/);
  assert.match(headerMenuSource, /const close = useCallback\(\(\) => onOpenChange\(false\), \[onOpenChange\]\);/);
  assert.match(headerMenuSource, /useDismissOnOutside\(open, "\.header-menu", close\);/);
  assert.match(headerMenuSource, /useMenuFocus\(\{ open, menuRef, triggerRef, onClose: close \}\)/);
  assert.doesNotMatch(dashboardSource, /target\?\.closest\("\.header-menu"\)/);
});

test("Dashboard wires Android Back to dismiss the open header sheet", () => {
  assert.match(dashboardSource, /useAndroidBackEntry\("header-menu", active && headerMenuOpen, \(\) => setHeaderMenuOpen\(false\)\);/);
});

test("icons exposes plus and more glyphs alongside the gear", () => {
  assert.match(iconsSource, /export function PlusIcon\(\)/);
  assert.match(iconsSource, /export function MoreIcon\(\)/);
});

test("header menu dropdown is a right-anchored panel on desktop", () => {
  const rule = cssRuleFor(".header-menu-dropdown");
  assert.match(rule, /position: absolute;/);
  assert.match(rule, /right: 0;/);
  assert.match(rule, /z-index:/);
});

test("header menu becomes a bottom sheet with a scrim on mobile", () => {
  // Inside the mobile media query, the dropdown pins to the viewport bottom edge.
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.header-menu\[open\] \.header-menu-dropdown \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;/,
  );
  // A tappable scrim backs the sheet and is the mobile close path (the
  // outside-pointer handler ignores it since it lives inside .header-menu).
  assert.match(css, /\.header-menu-scrim \{/);
  assert.match(headerMenuSource, /className="header-menu-scrim"[\s\S]*?onClick=\{close\}/);
  assert.match(css, /\.header-menu-divider \{/);
});

test("header menu keeps supported pages and omits the retired Board entry", async () => {
  const harness = createUiSsrHarness();
  try {
    const { HeaderMenu } = await harness.loadModule<typeof import("../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    // Older edge deployments still advertise the shared Board API.
    const props = {
      open: true, onOpenChange() {}, historyAvailable: true, onHistory() {},
      boardAvailable: true, onBoard() {}, onUsage() {}, onDebug() {}, onSettings() {}, onShell() {},
    };
    const html = renderComponent(HeaderMenu, props);
    assert.doesNotMatch(html, />\s*Board\s*</, "the retired page never appears, even with legacy Board props");
    for (const page of ["Usage", "History", "Shell", "Debug", "Settings"]) {
      assert.match(html, new RegExp(`>\\s*${page}\\s*<`), `${page} remains available`);
    }
  } finally {
    await harness.close();
  }
});
