import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

// #252: on Android the real host pickers use the themed menu in the slot the native select had:
// one chevron, text clear of the icon, and the shrink behaviour at phone width.
const running = { schema_version: "agent-session.shell.v1", owner: "alice", status: "running", incarnation: "shell-one", tmux_name: "ac-shell-alice" };

async function renderAndroid(render: (load: <T extends Record<string, unknown>>(path: string) => Promise<T>) => Promise<ReturnType<typeof createElement>>): Promise<string> {
  Object.assign(globalThis, { __hostPickerRead: async () => running });
  const plugin: Plugin = { name: "host-picker-fixture", enforce: "pre", resolveId(source, importer) {
    if (!importer?.endsWith("/ShellPage.tsx")) return null;
    return source === "./api.ts" ? "\0host-picker-api" : source === "./TerminalPane.tsx" ? "\0host-picker-terminal" : null;
  }, load(id) {
    if (id === "\0host-picker-api") return "export const readEmergencyShell = (...args) => globalThis.__hostPickerRead(...args);";
    if (id === "\0host-picker-terminal") return 'import {createElement} from "react"; export const TerminalPane = () => createElement("div", {className: "terminal-pane with-key-bar"}, createElement("div", {className: "term-host"}));';
    return null;
  } };
  const harness = createUiSsrHarness([plugin]);
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  Object.defineProperty(window.navigator, "userAgent", { value: "Android", configurable: true });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    const element = await render(path => harness.loadModule(path));
    await act(async () => root.render(element));
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    await harness.close();
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
    Reflect.deleteProperty(globalThis, "__hostPickerRead");
    await window.happyDOM.close();
  }
}

interface Machine { readonly sameBox: boolean; readonly chevrons: number; readonly clearance: number; readonly inside: boolean; readonly width: number; readonly overflow: boolean }

const machineFilter = () => renderAndroid(async load => {
  const { MachineFilter } = await load<{ MachineFilter: ComponentType<Record<string, unknown>> }>("/src/MachineFilter.tsx");
  return createElement(MachineFilter, { value: "a-longer-machine-name", machines: ["a-longer-machine-name", "second-machine"], allValue: "all", onChange() {} });
});

for (const width of [320, 360, 412, 480]) {
  test(`the Android machine filter keeps one chevron and clears its icon at ${width}px`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const markup = await machineFilter();
    assert.doesNotMatch(markup, /<select/, "the real consumer renders the themed menu on Android");
    const m = measureUiMarkup<Machine>(`<div class="dash-group" style="display:flex">${markup}</div>`, width, `
      const filter = document.querySelector('.machine-filter'), icon = filter.querySelector(':scope > svg'), value = filter.querySelector('.select-menu-value');
      const trigger = filter.querySelector('.select-menu-trigger'), f = filter.getBoundingClientRect(), v = value.getBoundingClientRect(), i = icon.getBoundingClientRect(), t = trigger.getBoundingClientRect();
      const result = { chevrons: filter.querySelectorAll(':scope > svg').length, clearance: v.left - i.right, inside: t.left >= f.left - 1 && t.right <= f.right + 1 && t.top >= f.top - 1 && t.bottom <= f.bottom + 1,
        sameBox: Math.abs(t.height - f.height) < 4, width: f.width, overflow: document.documentElement.scrollWidth > innerWidth };`);
    assert.equal(m.chevrons, 1, `only the machine icon is drawn beside the menu: ${JSON.stringify(m)}`);
    assert.ok(m.clearance >= 2, `the value text clears the icon: ${JSON.stringify(m)}`);
    assert.ok(m.inside && m.sameBox, `the menu trigger fills the filter box: ${JSON.stringify(m)}`);
    assert.equal(m.overflow, false, "no horizontal scroll");
  });
}

interface Shell { readonly machine: { left: number; right: number; width: number }; readonly actionsLeft: number; readonly overflow: boolean; readonly outside: boolean }

for (const width of [320, 360, 412, 480]) {
  test(`the Android Shell host control shrinks beside the actions at ${width}px`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const markup = await renderAndroid(async load => {
      const { ShellPage } = await load<{ ShellPage: ComponentType<{ machines: string[]; onExit(): void }> }>("/src/ShellPage.tsx");
      return createElement(ShellPage, { machines: ["example-machine-with-a-long-name", "second-machine"], onExit() {} });
    });
    assert.doesNotMatch(markup, /<select/);
    const m = measureUiMarkup<Shell>(`<div style="height:640px;display:flex;flex-direction:column">${markup}</div>`, width, `
      const header = document.querySelector('.shell-page-header'), menu = header.querySelector('.select-menu'), r = menu.getBoundingClientRect();
      const actions = header.querySelector('.shell-page-actions').getBoundingClientRect();
      const result = { machine: { left: r.left, right: r.right, width: r.width }, actionsLeft: actions.left, overflow: document.documentElement.scrollWidth > innerWidth, outside: r.left < 0 || r.right > innerWidth };`);
    assert.ok(m.machine.width > 40, `the host control keeps a usable width: ${JSON.stringify(m)}`);
    assert.ok(m.machine.right <= m.actionsLeft + 1 || m.machine.left >= m.actionsLeft, `it does not overlap the actions: ${JSON.stringify(m)}`);
    assert.equal(m.overflow, false);
    assert.equal(m.outside, false);
  });
}
