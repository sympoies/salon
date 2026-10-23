import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingsProps } from "../src/Settings.tsx";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { uiSource, uiStyles } from "./support/source.ts";

const settingsSource = uiSource("Settings.tsx");
const css = uiStyles();
const ssr = createUiSsrHarness();
const cleanupStack: Array<() => Promise<void> | void> = [];

function versionSettingsProps(): SettingsProps {
  return {
    onSaved() {}, onCancel() {}, machines: [], machineColors: {},
    defaultAutoResume: false, attentionAlerts: false,
    terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
    onMachineColorChange() {}, onMachineColorReset() {}, onDefaultAutoResumeChange() {},
    onAttentionAlertsChange() {},
    onTerminalRenderModeChange() {}, onTerminalSelectedPaneRealtimeChange() {},
    openAccess: true, onSignedOut() {},
  };
}

test("Settings offers manual account host toggles with a required reason for online and offline hosts", async () => {
  const writes: unknown[] = [];
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.__hostPreferenceWrites = writes;
  globals.__hostPreferenceAvailable = true;
  const harness = createUiSsrHarness([{
    name: "host-preference-api-boundary",
    transform(code, id) {
      if (!id.endsWith("/src/api.ts")) return;
      return code.replace("export async function listMachinePreferences(", "export async function originalListMachinePreferences(")
        .replace("export async function updateMachinePreference(", "export async function originalUpdateMachinePreference(")
        .replace("export async function listSessions(", "export async function originalListSessions(") + `
        export const listMachinePreferences = async () => globalThis.__hostPreferenceAvailable ? ({ok:true,machines:[
          {name:"fixture-online",enabled:true,active:true,last_change:null},
          {name:"fixture-offline",enabled:true,active:true,last_change:null}]}) : ({ok:false,machines:[]});
        export const listSessions = async () => ({ok:true,sessions:[],machines:[
          {name:"fixture-online",ok:true},{name:"fixture-offline",ok:false}]});
        export const updateMachinePreference = async (...args) => {
          globalThis.__hostPreferenceWrites.push(args);
          return {ok:true,machine:{name:args[0],enabled:args[1],active:args[1],last_change:null}};
        };
      `;
    },
  }]);
  cleanupStack.push(async () => { await harness.close(); delete globals.__hostPreferenceWrites; delete globals.__hostPreferenceAvailable; });
  const { Settings } = await harness.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  await act(async () => mounted.root.render(createElement(Settings, { ...versionSettingsProps(), machines: ["fixture-online", "fixture-offline"] })));
  const section = mounted.container.querySelector('[aria-label="Account host preferences"]');
  assert.ok(section, "shared manual host preferences belong in Settings");
  assert.match(section.textContent ?? "", /Online/);
  assert.match(section.textContent ?? "", /Offline/);
  const toggle = section.querySelector<HTMLButtonElement>('[aria-label="Disable fixture-offline"]');
  assert.ok(toggle, "offline reachability does not disable manual controls");
  await act(async () => toggle.click());
  const reason = section.querySelector<HTMLInputElement>('[aria-label="Host preference reason"]');
  assert.ok(reason); assert.equal(reason.required, true);
  const save = section.querySelector<HTMLButtonElement>('[type="submit"]'); assert.ok(save);
  assert.equal(save.disabled, true); assert.equal(writes.length, 0);
  reason.value = "Planned month-long maintenance";
  await act(async () => reason.dispatchEvent(new mounted.window.Event("input", { bubbles: true })));
  assert.equal(save.disabled, false);
  await act(async () => save.click());
  assert.deepEqual(writes, [["fixture-offline", false, "Planned month-long maintenance"]]);
  globals.__hostPreferenceAvailable = false;
  await act(async () => mounted.root.render(createElement(Settings, { ...versionSettingsProps(), machines: ["fixture-online", "fixture-offline"] })));
  assert.match(section.querySelector('[role="alert"]')?.textContent ?? "", /unavailable/);
  globals.__hostPreferenceAvailable = true;
  await act(async () => mounted.root.render(createElement(Settings, { ...versionSettingsProps(), machines: ["fixture-online", "fixture-offline"] })));
  assertNoElement(section, '[role="alert"]', "a successful account refresh clears its earlier availability error");
});

test("Settings offers migration once, seeds only untouched account hosts and can discard without writes", async () => {
  const writes: unknown[] = [];
  const rows = [
    { name: "fixture-a", enabled: false, active: false, last_change: { actor: "owner-local:fixture", reason: "Owner maintenance", at: "2026-10-13T00:00:00Z", revision: 1 } },
    { name: "fixture-b", enabled: true, active: true, last_change: null as unknown },
  ];
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.__hostMigrationRows = rows;
  globals.__hostMigrationWrite = (name: string, enabled: boolean, reason: string, initial: boolean) => {
    writes.push([name, enabled, reason, initial]);
    const row = rows.find(row => row.name === name)!;
    row.enabled = enabled; row.active = enabled;
    row.last_change = { actor: "principal:fixture", reason, at: "2026-10-13T00:00:01Z", revision: 1 };
  };
  const harness = createUiSsrHarness([{
    name: "host-migration-api-boundary",
    transform(code, id) {
      if (!id.endsWith("/src/api.ts")) return;
      return code.replace("export async function listMachinePreferences(", "export async function originalListMachinePreferences(")
        .replace("export async function updateMachinePreference(", "export async function originalUpdateMachinePreference(")
        .replace("export async function listSessions(", "export async function originalListSessions(") + `
        export const listMachinePreferences = async () => ({ok:true,machines:globalThis.__hostMigrationRows});
        export const listSessions = async () => ({ok:true,sessions:[],machines:[]});
        export const updateMachinePreference = async (...args) => { globalThis.__hostMigrationWrite(...args); return {ok:true}; };
      `;
    },
  }]);
  cleanupStack.push(async () => { await harness.close(); delete globals.__hostMigrationRows; delete globals.__hostMigrationWrite; });
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  const storage = await harness.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  storage.setPrincipalStorageNamespace(null);
  const legacyKey = "ac.enabledMachines.optIn";
  mounted.window.localStorage.setItem(legacyKey, '["fixture-a","not-granted"]');
  const { Settings } = await harness.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const props = { ...versionSettingsProps(), machines: ["fixture-a", "fixture-b"] };
  await act(async () => mounted.root.render(createElement(Settings, props)));
  const button = (text: string) => [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === text);
  assert.equal(writes.length, 0, "reading old device storage never changes account preferences");
  const apply = button("Import device preference"); assert.ok(apply);
  await act(async () => apply.click());
  assert.deepEqual(writes, [["fixture-b", false, "Imported this device's previous host preference", true]]);
  assert.equal(rows[0].enabled, false, "existing owner-local disable is preserved");
  assert.equal(mounted.window.localStorage.getItem(legacyKey), null);
  assert.equal(Boolean(button("Import device preference")), false);
  await act(async () => mounted.root.render(null));
  await act(async () => mounted.root.render(createElement(Settings, props)));
  assert.equal(Boolean(button("Import device preference")), false, "remount does not offer a completed migration");
  await act(async () => mounted.root.render(null));
  mounted.window.localStorage.removeItem("ac.machinePreferences.migrationSeen");
  mounted.window.localStorage.setItem(legacyKey, "[]");
  await act(async () => mounted.root.render(createElement(Settings, props)));
  const keep = button("Keep account preferences"); assert.ok(keep);
  await act(async () => keep.click());
  assert.equal(writes.length, 1, "discarding old intent makes no server writes");
  assert.equal(mounted.window.localStorage.getItem(legacyKey), null);
});

test("Settings offers persistent session list display with Terminal as the default", async () => {
  const { Settings } = await ssr.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const changes: string[] = [];
  const props = { ...versionSettingsProps(), onSessionListDisplayChange: (value: string) => changes.push(value) };
  await act(async () => mounted.root.render(createElement(Settings, props)));
  const select = mounted.container.querySelector<HTMLSelectElement>('select[aria-label="Session list display"]');
  assert.ok(select, "the view choice belongs in Settings");
  assert.equal(select.value, "terminal");
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]),
    [["terminal", "Terminal"], ["conversation", "Conversation"]]);
  select.value = "conversation";
  await act(async () => select.dispatchEvent(new mounted.window.Event("change", { bubbles: true })));
  assert.deepEqual(changes, ["conversation"]);
  await act(async () => mounted.root.render(createElement(Settings, { ...props, sessionListDisplay: "conversation" })));
  assert.equal(mounted.container.querySelector<HTMLSelectElement>('select[aria-label="Session list display"]')?.value, "conversation");
});

test("Settings shows and copies injected client metadata while server version is unavailable", async () => {
  const copied: string[] = [];
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.__AGENT_CONSOLE_APP_VERSION__ = "0.3.30";
  globals.__AGENT_CONSOLE_BUILD_SHA__ = "ad41d7963b261dd51261f7259376e09bc510d8ad";
  globals.__versionTestWrite = (text: string) => copied.push(text);
  const harness = createUiSsrHarness([{
    name: "version-clipboard-boundary",
    transform(_code, id) {
      if (id.endsWith("/src/terminalClipboard.ts")) {
        return "export async function writeTerminalClipboardText(text) { globalThis.__versionTestWrite(text); }";
      }
    },
  }]);
  cleanupStack.push(async () => {
    await harness.close();
    delete globals.__AGENT_CONSOLE_APP_VERSION__;
    delete globals.__AGENT_CONSOLE_BUILD_SHA__;
    delete globals.__versionTestWrite;
  });
  const module = await harness.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  await act(async () => mounted.root.render(createElement(module.Settings, versionSettingsProps())));
  const section = mounted.container.querySelector('[aria-label="Version information"]');
  assert.ok(section, "Settings needs a version section independent of backend requests");
  assert.match(section.textContent ?? "", /Client version.*0\.3\.30/);
  assert.match(section.textContent ?? "", /Client build.*ad41d7963b26/);
  assert.match(section.textContent ?? "", /Server version.*Unavailable/);
  const copy = section.querySelector<HTMLButtonElement>("button");
  assert.ok(copy);
  await act(async () => copy.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(copied, ["Client version: 0.3.30\nClient build: ad41d7963b26\nSurface: web"]);
  assert.match(section.textContent ?? "", /Copied/);
});

test("Settings missing metadata stays explicit and usable without a backend", async () => {
  const module = await ssr.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  await act(async () => mounted.root.render(createElement(module.Settings, versionSettingsProps())));
  const section = mounted.container.querySelector('[aria-label="Version information"]');
  assert.ok(section);
  assert.match(section.textContent ?? "", /Client version.*Unavailable/);
  assert.match(section.textContent ?? "", /Client build.*Unavailable/);
  assert.match(section.textContent ?? "", /Server version.*Unavailable/);
  assert.equal(section.querySelector<HTMLButtonElement>("button")?.disabled, false);
});

test("Settings reports clipboard failure without exposing the underlying error", async () => {
  const harness = createUiSsrHarness([{
    name: "version-clipboard-failure",
    transform(_code, id) {
      if (id.endsWith("/src/terminalClipboard.ts")) {
        return 'export async function writeTerminalClipboardText() { throw new Error("test-private-error"); }';
      }
    },
  }]);
  cleanupStack.push(() => harness.close());
  const module = await harness.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  await act(async () => mounted.root.render(createElement(module.Settings, versionSettingsProps())));
  const section = mounted.container.querySelector('[aria-label="Version information"]');
  assert.ok(section);
  const copy = section.querySelector<HTMLButtonElement>("button");
  assert.ok(copy);
  await act(async () => copy.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.match(section.textContent ?? "", /Could not copy version information/);
  assert.doesNotMatch(section.textContent ?? "", /test-private-error/);
  assert.equal(copy.disabled, false);
});


test("native onboarding exposes a masked, labelled credential target for testcred", async () => {
  const { Settings } = await ssr.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  await act(async () => mounted.root.render(createElement(Settings, { ...versionSettingsProps(), variant: "connect" })));
  const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="console-access-token"]');
  assert.ok(input, "automation needs a stable credential field");
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("aria-label"), "Console access token");
  const submit = mounted.container.querySelector<HTMLButtonElement>('[data-testid="console-sign-in"]');
  assert.ok(submit);
  assert.equal(submit.type, "submit");
  assert.equal(submit.textContent?.trim(), "Connect");
});

after(async () => {
  await ssr.close();
});

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { readonly window: Window; readonly root: Root; readonly container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    window,
    root,
    container,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

test("Settings supports a connect variant and a manage variant", () => {
  assert.match(settingsSource, /variant\?: "connect" \| "manage"/);
  assert.match(settingsSource, /if \(variant === "connect"\)/);
});

test("Settings connect variant keeps the server onboarding form", () => {
  assert.match(settingsSource, /Connect to your server\./);
  assert.match(settingsSource, /normalizeServerUrl\(server\)/);
  assert.match(settingsSource, />\s*Connect\s*<\/button>/);
});

test("Settings manage page shows Connection only in the native app", () => {
  assert.match(settingsSource, /const native = isTauri\(\);/);
  assert.match(settingsSource, /\{native \? \(/);
  assert.match(settingsSource, /Server URL/);
  assert.match(settingsSource, /Access token/);
});

test("Settings directs host visibility to shared Session filters", () => {
  assert.match(settingsSource, /\{machines\.length > 0 \? \(/);
  assert.match(settingsSource, /Choose visible hosts in Session filters/);
  assert.doesNotMatch(settingsSource, /optInMachines|onToggleMachine/);
  assert.match(settingsSource, /className="settings-machines"/);
});

test("Settings manage page exposes machine color overrides", () => {
  assert.match(settingsSource, /readonly machineColors: MachineColorMap;/);
  assert.match(settingsSource, /createMachineColorMap,/);
  assert.match(settingsSource, /machineColorOverride,/);
  assert.match(settingsSource, /const \[draftMachineColors, setDraftMachineColors\] = useState<Record<string, string>>\(\(\) => createMachineColorMap\(\)\);/);
  assert.match(settingsSource, /useEffect\(\(\) => \{[\s\S]*?const next = createMachineColorMap\(\);[\s\S]*?next\[machine\] = resolveMachineColor\(machine, machineColors, machineColorDefaults\);/);
  assert.match(settingsSource, /resolveMachineColor\(machine, machineColors, machineColorDefaults\)/);
  assert.match(settingsSource, /const \{ machineColorDefaults \} = useUiExtensions\(\);/);
  assert.match(settingsSource, /type="color"/);
  assert.match(settingsSource, /className="settings-color-input"/);
  assert.match(settingsSource, /const color = machineColorOverride\(draftMachineColors, machine\) \?\? resolveMachineColor\(machine, machineColors, machineColorDefaults\);/);
  assert.match(settingsSource, /onChange=\{\(e\) => \{[\s\S]*?const draft = createMachineColorMap\(Object\.entries\(prev\)\);[\s\S]*?draft\[machine\] = next;[\s\S]*?return draft;/);
  assert.match(settingsSource, /onBlur=\{\(e\) => commitMachineColor\(machine, e\.currentTarget\.value\)\}/);
  assert.match(settingsSource, /onClick=\{\(\) => \{[\s\S]*?const draft = createMachineColorMap\(Object\.entries\(prev\)\);[\s\S]*?draft\[machine\] = resolveMachineColor\(machine, \{\}, machineColorDefaults\);[\s\S]*?return draft;[\s\S]*?onMachineColorReset\(machine\);/);
  assert.doesNotMatch(settingsSource, /onChange=\{\(e\) => onMachineColorChange/);
});

test("Settings manage page exposes the default auto-resume preference", () => {
  assert.match(settingsSource, /readonly defaultAutoResume: boolean;/);
  assert.match(settingsSource, /readonly onDefaultAutoResumeChange: \(enabled: boolean\) => void;/);
  assert.match(settingsSource, /Default auto-resume/);
  assert.match(settingsSource, /New supported sessions will enable auto-resume before their first prompt is submitted\./);
  assert.match(settingsSource, /aria-checked=\{defaultAutoResume\}/);
  assert.match(settingsSource, /onDefaultAutoResumeChange\(!defaultAutoResume\)/);
});



test("Settings manage page exposes terminal rendering preference contracts", () => {
  assert.match(settingsSource, /readonly terminalRenderMode: TerminalRenderMode;/);
  assert.match(settingsSource, /readonly terminalSelectedPaneRealtime: boolean;/);
});

test("Settings renders terminal profiles and wires selected-pane priority behavior", async () => {
  const module = await ssr.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const modeChanges: string[] = [];
  const priorityChanges: boolean[] = [];
  const alertChanges: boolean[] = [];
  const baseProps: SettingsProps = {
    onSaved: () => undefined,
    onCancel: () => undefined,
    variant: "manage",
    machines: [],
    optInMachines: new Set(),
    machineColors: {},
    defaultAutoResume: false,
    attentionAlerts: false,
    terminalRenderMode: "realtime",
    terminalSelectedPaneRealtime: true,
    onToggleMachine: () => undefined,
    onMachineColorChange: () => undefined,
    onMachineColorReset: () => undefined,
    onDefaultAutoResumeChange: () => undefined,
    onAttentionAlertsChange: (enabled) => alertChanges.push(enabled),
    onTerminalRenderModeChange: (mode) => modeChanges.push(mode),
    onTerminalSelectedPaneRealtimeChange: (enabled) => priorityChanges.push(enabled),
    openAccess: true,
    onSignedOut: () => undefined,
  };
  const render = async (props: SettingsProps) => {
    await act(async () => mounted.root.render(createElement(module.Settings, props)));
  };

  await render(baseProps);
  const select = mounted.container.querySelector("select");
  assert.ok(select);
  assert.deepEqual(
    Array.from(select.options).map((option) => [option.value, option.textContent]),
    [
      ["realtime", "Realtime"],
      ["focus-aware-smooth", "Focus-aware · Smooth (100 ms)"],
      ["focus-aware-balanced", "Focus-aware · Balanced (250 ms)"],
      ["focus-aware-efficient", "Focus-aware · Efficient (500 ms)"],
    ],
  );
  const priority = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
    .find((button) => button.closest(".settings-preference-row")?.textContent?.includes("Selected pane"));
  assert.ok(priority);
  assert.equal(priority.disabled, true);

  await render({ ...baseProps, terminalRenderMode: "focus-aware-balanced" });
  const activeSelect = mounted.container.querySelector("select");
  assert.ok(activeSelect);
  activeSelect.value = "focus-aware-efficient";
  await act(async () => activeSelect.dispatchEvent(new mounted.window.Event("change", { bubbles: true })));
  assert.deepEqual(modeChanges, ["focus-aware-efficient"]);

  const activePriority = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
    .find((button) => button.closest(".settings-preference-row")?.textContent?.includes("Selected pane"));
  assert.ok(activePriority);
  assert.equal(activePriority.disabled, false);
  await act(async () => activePriority.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(priorityChanges, [false]);

  const alerts = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
    .find((button) => button.closest(".settings-preference-row")?.textContent?.includes("Attention alerts"));
  assert.ok(alerts);
  assert.equal(alerts.getAttribute("aria-checked"), "false");
  await act(async () => alerts.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(alertChanges, [true]);
  await render({ ...baseProps, terminalRenderMode: "focus-aware-balanced", attentionAlerts: true });
  const enabledAlerts = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
    .find((button) => button.closest(".settings-preference-row")?.textContent?.includes("Attention alerts"));
  assert.equal(enabledAlerts?.getAttribute("aria-checked"), "true");



});

test("Settings manage page offers Sign out unless open-access", () => {
  assert.match(settingsSource, /\{!openAccess \? \(/);
  assert.match(settingsSource, /const signOut = async \(\) => \{[\s\S]*?await logout\(\);[\s\S]*?onSignedOut\(\);/);
  assert.match(settingsSource, />\s*Sign out\s*<\/AsyncButton>/);
});

test("Settings styles define sectioned layout and the machine switch", () => {
  assert.match(css, /\.settings-section \{/);
  assert.match(css, /\.settings-section-title \{/);
  assert.match(css, /\.settings-machine-color \{/);
  assert.match(css, /\.settings-color-input \{/);
  assert.match(css, /\.settings-switch \{/);
});

test("Settings machine color controls align in a shared column", () => {
  assert.match(css, /\.settings-machines \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /\.settings-row \{[\s\S]*?grid-template-columns: subgrid;/);
  assert.match(css, /\.settings-row-actions \{[\s\S]*?display: contents;/);
  assert.match(css, /\.settings-machine-color \{[\s\S]*?justify-self: start;/);
  assert.match(css, /\.settings-row-note,\n\.settings-switch \{[\s\S]*?justify-self: end;/);
});


test("connection settings distinguish startup timeout and transport failure without exposing credentials", async () => {
  const module = await ssr.loadModule<{ Settings: ComponentType<SettingsProps> }>("/src/Settings.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const props: SettingsProps = {
    onSaved: () => undefined, variant: "connect", machines: [], machineColors: {},
    terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
    onMachineColorChange: () => undefined, onMachineColorReset: () => undefined,
    onDefaultAutoResumeChange: () => undefined, onAttentionAlertsChange: () => undefined,
    onTerminalSelectedPaneRealtimeChange: () => undefined,
    openAccess: false, onSignedOut: () => undefined,
  };
  for (const [startupFailure, expected] of [
    ["timeout", /timed out/i], ["transport", /could not reach/i],
  ] as const) {
    await act(async () => mounted.root.render(createElement(module.Settings, {
      ...props, startupFailure, startupTimeoutElapsedMs: 6_012, startupRecoveryElapsedMs: 6_148,
    })));
    const notice = mounted.container.querySelector('[role="alert"]');
    assert.ok(notice, "connection recovery states why startup failed");
    assert.match(notice.textContent ?? "", expected);
    assert.ok(mounted.container.querySelector('input[type="password"]'), "the retry form stays available");
    if (startupFailure === "timeout") {
      assert.match(mounted.container.textContent ?? "", /Timeout fired at 6\.01 s/);
      assert.match(mounted.container.textContent ?? "", /Recovery rendered at 6\.15 s/);
    }
  }
  await act(async () => mounted.root.render(createElement(module.Settings, {
    ...props, startupFailure: "timeout", startupTimeoutElapsedMs: null, startupRecoveryElapsedMs: null,
  })));
  assertNoElement(mounted.container, ".startup-timing",
    "a retry timeout without startup timing must not display values from the first attempt");
  await act(async () => mounted.root.render(createElement(module.Settings, props)));
  assert.equal(Boolean(mounted.container.querySelector('[role="alert"]')), false, "first-run onboarding has no startup error");
});
