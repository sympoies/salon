import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";

const appSource = uiSource("App.tsx");
const startupDeadlineSource = uiSource("startupDeadline.ts");
const dashboardSource = uiSource("Dashboard.tsx");
const dashboardKeyboardSource = uiSource("useDashboardKeyboard.ts");
const dashboardBehaviorSource = `${dashboardSource}\n${dashboardKeyboardSource}`;
const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

test("App keeps the dashboard mounted behind secondary panels", () => {
  assert.doesNotMatch(appSource, /if \(view\.kind === "usage"\) \{\s*return <UsagePanel/);
  assert.doesNotMatch(appSource, /if \(view\.kind === "hermes"\) \{\s*return <HermesPanel/);
  assert.match(appSource, /const dashboardActive = view\.kind === "dashboard";/);
  assert.match(appSource, /<Dashboard[\s\S]*?active=\{dashboardActive\}/);
  assert.match(appSource, /view\.kind === "usage" && operatorCapabilities\.usage \? \(/);
  assert.match(appSource, /<Modal[\s\S]*?className="page-overlay"[\s\S]*?backdropClassName="app-overlay"/);
  assert.match(appSource, /usage-anchored/);
});

test("Secondary pages delegate keyboard and Android dismissal to the common modal shell", () => {
  assert.match(appSource, /import \{ Modal \} from "\.\/Modal\.tsx";/);
  assert.match(appSource, /androidBackEntry="secondary-panel"[\s\S]*?onClose=\{closeOverlay\}/);
  assert.doesNotMatch(appSource, /useAndroidBackEntry/);
});

test("App exposes permitted hosts and migrates the retired hidden-host preference", () => {
  assert.match(appSource, /hostVisibilityMigrationPending, acknowledgeHostVisibilityMigration, resolveEnabledMachines/);
  assert.match(appSource, /import \{ loadMachineColors, resetMachineColor, saveMachineColors, setMachineColor, type MachineColorMap \} from "\.\/machineColors\.ts";/);
  assert.match(appSource, /resolveEnabledMachines\(machines\)/);
  assert.match(appSource, /hostMigrationNotice/);
  assert.match(appSource, /acknowledgeHostVisibilityMigration\(\)/);
  assert.match(appSource, /const \{ machineColorDefaults \} = useUiExtensions\(\);/);
  assert.match(appSource, /const \[machineColors, setMachineColors\] = useState<MachineColorMap>\(\(\) => loadMachineColors\(undefined, machineColorDefaults\)\);/);
  // The gear is available on web and native now, not gated behind isTauri().
  assert.match(appSource, /onSettings=\{\(\) => setView\(\{ kind: "settings" \}\)\}/);
  assert.doesNotMatch(appSource, /onSettings=\{isTauri\(\)/);
  // Dashboard receives the principal-permitted set; Session filters own visibility.
  assert.match(appSource, /enabledMachines=\{enabledMachines\}/);
  assert.match(appSource, /machineColors=\{machineColors\}/);
  assert.match(appSource, /onMachineColorChange=\{updateMachineColor\}/);
  assert.match(appSource, /onMachineColorReset=\{resetMachineColorOverride\}/);
  assert.match(appSource, /variant="manage"/);
  assert.match(appSource, /variant="connect"/);
});

test("App owns and persists the default auto-resume preference", () => {
  assert.match(appSource, /import \{ loadDefaultAutoResume, saveDefaultAutoResume \} from "\.\/autoResumeDefault\.ts";/);
  assert.match(appSource, /const \[defaultAutoResume, setDefaultAutoResume\] = useState\(\(\) => loadDefaultAutoResume\(\)\);/);
  assert.match(appSource, /if \(saveDefaultAutoResume\(enabled\)\) \{\s*setDefaultAutoResume\(enabled\);\s*\}/);
  assert.match(appSource, /defaultAutoResume=\{defaultAutoResume\}/);
  assert.match(appSource, /onDefaultAutoResumeChange=\{updateDefaultAutoResume\}/);
});

test("App composes distribution providers around the current shell", () => {
  assert.match(appSource, /<ExtensionAppProviders permissions=\{permissions\}>\{shell\}<\/ExtensionAppProviders>/);
});

test("App owns and persists terminal rendering without remounting the dashboard", () => {
  assert.match(appSource, /loadTerminalRenderMode,/);
  assert.match(appSource, /loadTerminalSelectedPaneRealtime,/);
  assert.match(appSource, /saveTerminalRenderMode,/);
  assert.match(appSource, /saveTerminalSelectedPaneRealtime,/);
  assert.match(appSource, /useState<TerminalRenderMode>\(\(\) => loadTerminalRenderMode\(\)\)/);
  assert.match(
    appSource,
    /useState\(\s*\(\) => loadTerminalSelectedPaneRealtime\(\),\s*\)/,
  );
  assert.match(appSource, /if \(saveTerminalRenderMode\(mode\)\) \{\s*setTerminalRenderMode\(mode\);\s*\}/);
  assert.match(appSource, /if \(saveTerminalSelectedPaneRealtime\(enabled\)\) \{\s*setTerminalSelectedPaneRealtime\(enabled\);\s*\}/);
  assert.match(appSource, /terminalRenderMode=\{terminalRenderMode\}/);
  assert.match(appSource, /terminalSelectedPaneRealtime=\{terminalSelectedPaneRealtime\}/);
  assert.match(appSource, /onTerminalRenderModeChange=\{updateTerminalRenderMode\}/);
  assert.match(appSource, /onTerminalSelectedPaneRealtimeChange=\{updateTerminalSelectedPaneRealtime\}/);
  assert.match(
    appSource,
    /setTerminalPerformancePreferences\(terminalRenderMode, terminalSelectedPaneRealtime\)/,
  );
});

test("App exposes a Debug overlay from the dashboard", () => {
  assert.match(appSource, /import \{ DebugPanel \} from "\.\/DebugPanel\.tsx";/);
  assert.match(appSource, /type View = [\s\S]*\{ kind: "debug" \}/);
  assert.match(appSource, /onDebug=\{\(\) => operatorCapabilities\.debug && setView\(\{ kind: "debug" \}\)\}/);
  assert.match(appSource, /view\.kind === "debug" && operatorCapabilities\.debug \? \(/);
  assert.match(dashboardSource, /readonly onDebug: \(\) => void;/);
  // Debug is now reached through the header overflow menu rather than a
  // standalone button; the menu item itself is covered by headerMenu.test.ts.
  assert.match(dashboardSource, /<HeaderMenu[\s\S]*?onDebug=\{onDebug\}/);
});

test("App gates operator panels and polling by authenticated principal permissions", () => {
  assert.match(appSource, /const permissions = new Set\(principal\?\.permissions \?\? \[\]\);/);
  assert.match(appSource, /operatorCapabilities=\{operatorCapabilities\}/);
  assert.match(appSource, /ExtensionAppProviders permissions=\{permissions\}/);
  assert.match(appSource, /canResetRateLimits=\{permissions\.has\("codex_reset"\)\}/);
  assert.match(appSource, /function activatePrincipalStorage\(principalId: string \| null\): void/);
  assert.match(appSource, /flushDebugEvents\(\);\s*setPrincipalStorageNamespace\(principalId\);\s*hydrateDebugEventsFromStorage\(\);/);
  assert.match(appSource, /activatePrincipalStorage\(status\.principal\?\.id \?\? null\)/);
  assert.match(dashboardSource, /operatorCapabilities\.usage \? <HeaderUsage/);
  assert.match(dashboardSource, /usageAvailable=\{operatorCapabilities\.usage\}/);
  assert.doesNotMatch(dashboardSource, /hermesAvailable/);
  assert.match(dashboardSource, /debugAvailable=\{operatorCapabilities\.debug\}/);
});

test("Debug panel exposes agent diagnostics controls", () => {
  const debugPanelSource = uiSource("DebugPanel.tsx");
  assert.match(debugPanelSource, /Run Diagnostics/);
  assert.match(debugPanelSource, /Copy Agent Bundle/);
  assert.match(debugPanelSource, /debug-diagnostics/);
  assert.match(css, /\.debug-diagnostics \{/);
});

test("Dashboard disables background interactions while an overlay is active", () => {
  assert.match(dashboardSource, /readonly active: boolean;/);
  assert.match(dashboardSource, /useAndroidBackEntry\("focused-session", active && focusedKey !== null/);
  assert.match(dashboardSource, /useAndroidBackEntry\("header-menu", active && headerMenuOpen/);
  assert.match(dashboardBehaviorSource, /if \(!active\) \{\s*closeOpenSlotMenus\(\);\s*return;/);
  assert.match(dashboardSource, /aria-hidden=\{!active \? "true" : undefined\}/);
  assert.match(dashboardSource, /inert=\{!active \? true : undefined\}/);
});

test("Secondary panels render as full-screen overlays without hiding dashboard layout", () => {
  assert.match(css, /\.app-shell \{/);
  assert.match(css, /\.app-dashboard-layer\.is-backgrounded \{/);
  assert.match(css, /pointer-events: none;/);
  assert.match(css, /\.app-overlay \{/);
  assert.match(css, /position: fixed;/);
  assert.doesNotMatch(cssRuleFor(".app-dashboard-layer.is-backgrounded"), /display: none;/);
});

test("Android startup recovery has an early deadline and reports timeout and render elapsed times", () => {
  assert.match(startupDeadlineSource, /ANDROID_STARTUP_RECOVERY_DEADLINE_MS\s*=\s*6_000/);
  assert.match(appSource, /setStartupFailure\("timeout"\)/);
  assert.match(appSource, /if \(!initialStartup\) \{[\s\S]*?setStartupTimeoutElapsedMs\(null\)[\s\S]*?setStartupRecoveryElapsedMs\(null\)[\s\S]*?setStartupTimingVisible\(false\)/,
    "a retry clears all timing from the prior startup attempt");
  assert.match(appSource, /startup\/recovery-rendered/);
  assert.match(appSource, /appBootElapsedMs\(\)/);
  assert.match(appSource, /runStartupAuthCheck\(/,
    "App must use the behaviorally tested timer lifecycle");
});
